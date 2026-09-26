use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::docker::conn::CmdResult;
use crate::secret_store::SecretBackend;

/// Docker 连接配置。kind 决定其余字段的语义：
/// - local: socket_path（空 = 默认 /var/run/docker.sock）
/// - tcp:   host（host:port，明文 HTTP）
/// - tls:   host（host:port）+ cert_path（证书目录，含 ca.pem / cert.pem / key.pem）
/// - ssh:   host（user@host[:port]）+ 可选 key_path + 可选 remote_socket（rootless 等非默认路径）
///          + 可选 jump_host（跳板机 user@host[:port]，经 ProxyJump 中转）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    /// "local" | "tcp" | "tls" | "ssh"
    pub kind: String,
    pub socket_path: String,
    pub host: String,
    pub cert_path: String,
    pub key_path: String,
    /// ssh 类型：远程 docker socket 路径，空 = /var/run/docker.sock
    pub remote_socket: String,
    /// ssh 类型：跳板机地址（user@host[:port]），空 = 直连
    pub jump_host: String,
}

impl ConnectionProfile {
    /// 兜底本地连接（默认 socket）
    pub fn default_local() -> Self {
        Self {
            id: "local".into(),
            name: "本地".into(),
            kind: "local".into(),
            socket_path: String::new(),
            host: String::new(),
            cert_path: String::new(),
            key_path: String::new(),
            remote_socket: String::new(),
            jump_host: String::new(),
        }
    }

    /// 展示地址（连接 URL 形式，供系统概览与侧栏显示）
    pub fn display_url(&self) -> String {
        match self.kind.as_str() {
            "local" => format!(
                "unix://{}",
                if self.socket_path.is_empty() {
                    "/var/run/docker.sock"
                } else {
                    &self.socket_path
                }
            ),
            "tcp" => format!("tcp://{}", self.host),
            "tls" => format!("https://{}", self.host),
            "ssh" => format!("ssh://{}", self.host),
            _ => self.host.clone(),
        }
    }
}

/// 镜像仓库凭据档案（推送用）。密码等敏感信息不落 settings.json，
/// 由 secret_store 存入系统钥匙串或机器绑定加密文件，secret_backend 记录实际落点。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RegistryProfile {
    pub id: String,
    pub name: String,
    /// "aliyun" | "harbor" | "generic"（决定域名预设与错误提示文案）
    pub kind: String,
    /// registry 地址：域名[:端口]，无 scheme（如 registry.cn-hangzhou.aliyuncs.com）
    pub registry: String,
    pub username: String,
    /// 密钥实际存储位置："keyring" | "file"
    pub secret_backend: String,
    /// 测试连接时跳过 TLS 证书校验（自签名 Harbor 用；仅作用于应用侧探测，
    /// 推送侧证书校验由 Docker daemon 决定）
    pub skip_tls_verify: bool,
    /// 创建时间（unix 秒）
    pub created_at: i64,
}

/// 应用设置：持久化到 app_config_dir()/settings.json。
/// 反序列化带 #[serde(default)]，旧文件缺字段自动补默认值，
/// 文件缺失或损坏时整体回落默认值。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppSettings {
    /// "system" | "light" | "dark"
    pub theme: String,
    /// 旧版自定义 socket 字段：仅用于迁移为 local 连接，迁移后不再使用
    pub docker_socket: String,
    /// 连接配置列表，始终保证至少一个本地连接
    pub connections: Vec<ConnectionProfile>,
    /// 当前激活的连接 id
    pub active_connection_id: String,
    /// 容器列表轮询间隔（秒）
    pub containers_refresh_secs: u32,
    /// 镜像列表轮询间隔（秒）
    pub images_refresh_secs: u32,
    /// 日志页默认回看行数
    pub logs_default_tail: u32,
    /// 日志页默认显示时间戳
    pub logs_timestamps: bool,
    /// 终端默认 shell："bash" | "sh" | "ash"
    pub terminal_shell: String,
    /// 用户自定义镜像加速源（区别于预设列表）
    pub mirror_custom: Vec<String>,
    /// 容器异常（非零退出/OOM/健康检查失败）时发送系统通知
    pub notifications_enabled: bool,
    /// 镜像仓库凭据列表（密码不在此处，见 secret_store）
    pub registries: Vec<RegistryProfile>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            docker_socket: String::new(),
            // 反序列化旧配置时以本 Default 为底：留空让 migrate() 统一补本地连接，
            // 避免旧配置被误判为"已有连接列表"而跳过迁移
            connections: Vec::new(),
            active_connection_id: String::new(),
            containers_refresh_secs: 10,
            images_refresh_secs: 20,
            logs_default_tail: 1000,
            logs_timestamps: false,
            terminal_shell: "bash".into(),
            mirror_custom: Vec::new(),
            notifications_enabled: true,
            registries: Vec::new(),
        }
    }
}

/// 旧配置迁移：仅有 docker_socket 时转为"本地"连接；
/// 并保证连接列表非空、始终存在本地连接、active_id 指向真实存在的配置。
/// load/set_settings 时都会执行，幂等。
pub fn migrate(mut s: AppSettings) -> AppSettings {
    if s.connections.is_empty() && !s.docker_socket.trim().is_empty() {
        s.connections.push(ConnectionProfile {
            socket_path: s.docker_socket.trim().to_string(),
            ..ConnectionProfile::default_local()
        });
    }
    if !s.connections.iter().any(|c| c.kind == "local") {
        s.connections.push(ConnectionProfile::default_local());
    }
    if s.active_connection_id.is_empty()
        || !s
            .connections
            .iter()
            .any(|c| c.id == s.active_connection_id)
    {
        s.active_connection_id = "local".into();
    }
    // 旧字段已完成迁移，清空避免残留歧义
    s.docker_socket.clear();
    s
}

/// 连接地址归一化：去 scheme 与首尾空白/斜杠，tcp/tls 缺端口时补默认（2375/2376）。
/// ssh 的 user@host 保留原样（端口由用户显式给出）。
pub fn normalize_conn_host(kind: &str, host: &str) -> String {
    let mut h = host.trim().trim_end_matches('/').to_string();
    for prefix in ["ssh://", "tcp://", "http://", "https://"] {
        if let Some(rest) = h.strip_prefix(prefix) {
            h = rest.to_string();
            break;
        }
    }
    let h = h.trim().to_string();
    match kind {
        "tcp" | "tls" if !h.is_empty() && !h.contains(':') => {
            format!("{h}:{}", if kind == "tls" { 2376 } else { 2375 })
        }
        _ => h,
    }
}

/// 清洗非法值：枚举回落默认、数值收敛到合理区间、列表去空去重
pub fn sanitize(mut s: AppSettings) -> AppSettings {
    if !["system", "light", "dark"].contains(&s.theme.as_str()) {
        s.theme = "system".into();
    }
    if !["bash", "sh", "ash"].contains(&s.terminal_shell.as_str()) {
        s.terminal_shell = "bash".into();
    }
    s.containers_refresh_secs = s.containers_refresh_secs.clamp(2, 300);
    s.images_refresh_secs = s.images_refresh_secs.clamp(5, 600);
    s.logs_default_tail = s.logs_default_tail.clamp(50, 100_000);
    s.docker_socket = s.docker_socket.trim().to_string();
    s.mirror_custom = s
        .mirror_custom
        .iter()
        .map(|m| normalize_mirror(m))
        .filter(|m| !m.is_empty())
        .collect();
    s.mirror_custom.dedup();

    // 连接配置：字段归一化 + 空 id 生成 + id 去重（保留首个，重复者换新 id）
    use std::collections::HashSet;
    let mut seen = HashSet::new();
    for c in &mut s.connections {
        c.id = c.id.trim().to_string();
        c.name = c.name.trim().to_string();
        if c.name.is_empty() {
            c.name = "未命名连接".into();
        }
        if !matches!(c.kind.as_str(), "local" | "tcp" | "tls" | "ssh") {
            c.kind = "local".into();
        }
        c.socket_path = c.socket_path.trim().to_string();
        c.host = normalize_conn_host(&c.kind, &c.host);
        c.cert_path = c.cert_path.trim().to_string();
        c.key_path = c.key_path.trim().to_string();
        c.remote_socket = c.remote_socket.trim().to_string();
        c.jump_host = c.jump_host.trim().to_string();
        if c.id.is_empty() {
            c.id = uuid::Uuid::new_v4().to_string();
        }
        if !seen.insert(c.id.clone()) {
            c.id = uuid::Uuid::new_v4().to_string();
            seen.insert(c.id.clone());
        }
    }
    s.connections.retain(|c| {
        match c.kind.as_str() {
            "local" => true,
            // 远程连接缺关键信息时丢弃，避免出现永远连不上的死配置
            "tcp" | "tls" => !c.host.is_empty(),
            "ssh" => !c.host.is_empty(),
            _ => false,
        }
    });

    // 镜像仓库凭据：字段归一化 + 空 id 生成 + id 去重（保留首个，重复者换新 id）
    let mut seen_registry = HashSet::new();
    for r in &mut s.registries {
        r.id = r.id.trim().to_string();
        r.name = r.name.trim().to_string();
        if r.name.is_empty() {
            r.name = "未命名仓库".into();
        }
        if !matches!(r.kind.as_str(), "aliyun" | "harbor" | "generic") {
            r.kind = "generic".into();
        }
        r.registry = normalize_registry_host(&r.registry);
        r.username = r.username.trim().to_string();
        if SecretBackend::parse(&r.secret_backend).is_none() {
            r.secret_backend = SecretBackend::Keyring.as_str().into();
        }
        if r.created_at <= 0 {
            r.created_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
        }
        if r.id.is_empty() {
            r.id = uuid::Uuid::new_v4().to_string();
        }
        if !seen_registry.insert(r.id.clone()) {
            r.id = uuid::Uuid::new_v4().to_string();
            seen_registry.insert(r.id.clone());
        }
    }
    // 缺地址或用户名的凭据无法使用，直接丢弃
    s.registries
        .retain(|r| !r.registry.is_empty() && !r.username.is_empty());
    s
}

/// 统一加速源写法：去空白、去末尾斜杠、无 scheme 时补 https://
pub fn normalize_mirror(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    if u.is_empty() {
        return String::new();
    }
    if u.starts_with("http://") || u.starts_with("https://") {
        u.to_string()
    } else {
        format!("https://{u}")
    }
}

/// registry 地址归一化：去 scheme 与首尾空白/斜杠，转小写（docker 引用要求小写域名）
pub fn normalize_registry_host(host: &str) -> String {
    let mut h = host.trim().to_lowercase();
    for prefix in ["https://", "http://"] {
        if let Some(rest) = h.strip_prefix(prefix) {
            h = rest.to_string();
            break;
        }
    }
    h.trim().trim_end_matches('/').to_string()
}

/// 从 JSON 文本解析（缺失/损坏均回落默认值），供测试与 load 复用
pub fn parse_settings(text: &str) -> AppSettings {
    serde_json::from_str(text).unwrap_or_default()
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &tauri::AppHandle) -> AppSettings {
    let path = match config_file(app) {
        Ok(p) => p,
        Err(_) => return AppSettings::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => migrate(sanitize(parse_settings(&text))),
        Err(_) => AppSettings::default(),
    }
}

/// tmp + rename 原子写入，避免半截文件
pub fn save(app: &tauri::AppHandle, s: &AppSettings) -> Result<(), String> {
    let path = config_file(app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "配置文件路径异常".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let text = serde_json::to_string_pretty(s).map_err(|e| format!("序列化设置失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入设置失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存设置失败: {e}"))?;
    Ok(())
}

// ------------------------------------------------------------------
// 运行时连接访问：切换连接时由 conn.rs 维护，设置文件始终为持久化真相
// ------------------------------------------------------------------

/// 按 id 查找连接配置
pub fn find_connection<'a>(
    s: &'a AppSettings,
    id: &str,
) -> Option<&'a ConnectionProfile> {
    s.connections.iter().find(|c| c.id == id)
}

#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> CmdResult<AppSettings> {
    Ok(load(&app))
}

#[tauri::command]
pub async fn set_settings(app: tauri::AppHandle, settings: AppSettings) -> CmdResult<AppSettings> {
    let s = migrate(sanitize(settings));
    save(&app, &s)?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_missing_and_corrupt_falls_back_to_default() {
        assert_eq!(parse_settings(""), AppSettings::default());
        assert_eq!(parse_settings("not json"), AppSettings::default());
    }

    #[test]
    fn parse_merges_missing_fields_with_default() {
        let s = parse_settings(r#"{"theme":"dark"}"#);
        assert_eq!(s.theme, "dark");
        assert_eq!(s.containers_refresh_secs, 10);
        assert_eq!(s.terminal_shell, "bash");
    }

    #[test]
    fn sanitize_clamps_and_normalizes() {
        let s = sanitize(AppSettings {
            theme: "hacker".into(),
            terminal_shell: "fish".into(),
            containers_refresh_secs: 0,
            images_refresh_secs: 99999,
            logs_default_tail: 1,
            mirror_custom: vec!["  https://a.com/ ".into(), "".into(), "b.com".into()],
            ..Default::default()
        });
        assert_eq!(s.theme, "system");
        assert_eq!(s.terminal_shell, "bash");
        assert_eq!(s.containers_refresh_secs, 2);
        assert_eq!(s.images_refresh_secs, 600);
        assert_eq!(s.logs_default_tail, 50);
        assert_eq!(s.mirror_custom, vec!["https://a.com", "https://b.com"]);
    }

    #[test]
    fn normalize_mirror_adds_scheme_and_trims_slash() {
        assert_eq!(normalize_mirror(" docker.1ms.run "), "https://docker.1ms.run");
        assert_eq!(normalize_mirror("https://a.com/"), "https://a.com");
        assert_eq!(normalize_mirror("http://insecure.local///"), "http://insecure.local");
        assert_eq!(normalize_mirror("   "), "");
    }

    #[test]
    fn migrate_converts_legacy_socket_to_local_profile() {
        let s = migrate(sanitize(parse_settings(
            r#"{"theme":"dark","docker_socket":"/tmp/my.sock"}"#,
        )));
        assert_eq!(s.docker_socket, "", "迁移后旧字段应清空");
        assert_eq!(s.connections.len(), 1);
        assert_eq!(s.connections[0].kind, "local");
        assert_eq!(s.connections[0].socket_path, "/tmp/my.sock");
        assert_eq!(s.active_connection_id, "local");
    }

    #[test]
    fn migrate_ensures_local_fallback_and_valid_active_id() {
        // 完全空配置 → 默认本地连接
        let s = migrate(sanitize(parse_settings("{}")));
        assert!(s.connections.iter().any(|c| c.kind == "local"));
        assert_eq!(s.active_connection_id, "local");

        // active_id 指向不存在的配置 → 回落 local
        let mut s2 = AppSettings::default();
        s2.active_connection_id = "ghost".into();
        let s2 = migrate(sanitize(s2));
        assert_eq!(s2.active_connection_id, "local");
    }

    #[test]
    fn sanitize_connection_fields_and_ids() {
        let s = sanitize(AppSettings {
            connections: vec![
                ConnectionProfile {
                    id: String::new(),
                    name: "  ".into(),
                    kind: "unknown".into(),
                    ..Default::default()
                },
                ConnectionProfile {
                    id: "dup".into(),
                    name: "a".into(),
                    kind: "tcp".into(),
                    host: "tcp://10.0.0.5".into(),
                    ..Default::default()
                },
                ConnectionProfile {
                    id: "dup".into(),
                    name: "b".into(),
                    kind: "tls".into(),
                    host: "https://10.0.0.5".into(),
                    ..Default::default()
                },
                // 缺 host 的远程连接应被丢弃
                ConnectionProfile {
                    id: "dead".into(),
                    name: "c".into(),
                    kind: "ssh".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        assert_eq!(s.connections.len(), 3);
        assert_eq!(s.connections[0].kind, "local");
        assert_eq!(s.connections[0].name, "未命名连接");
        assert_eq!(s.connections[1].host, "10.0.0.5:2375", "tcp 缺端口应补默认");
        assert_eq!(s.connections[2].host, "10.0.0.5:2376", "tls 缺端口应补默认");
        assert_ne!(s.connections[1].id, s.connections[2].id, "重复 id 应重新生成");
    }

    #[test]
    fn normalize_conn_host_strips_scheme_and_fills_port() {
        assert_eq!(normalize_conn_host("tcp", " tcp://10.0.0.5 "), "10.0.0.5:2375");
        assert_eq!(normalize_conn_host("tls", "https://10.0.0.5"), "10.0.0.5:2376");
        assert_eq!(normalize_conn_host("tcp", "10.0.0.5:2377"), "10.0.0.5:2377");
        assert_eq!(normalize_conn_host("ssh", "ssh://root@10.0.0.5:2222"), "root@10.0.0.5:2222");
        assert_eq!(normalize_conn_host("ssh", "root@10.0.0.5"), "root@10.0.0.5");
    }

    #[test]
    fn sanitize_trims_jump_host() {
        let s = sanitize(AppSettings {
            connections: vec![ConnectionProfile {
                id: "j1".into(),
                name: "经跳板机".into(),
                kind: "ssh".into(),
                host: "root@10.0.0.9".into(),
                jump_host: "  jump@10.0.0.1:22 ".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        assert_eq!(s.connections[0].jump_host, "jump@10.0.0.1:22");
    }

    #[test]
    fn display_url_reflects_kind() {
        assert_eq!(ConnectionProfile::default_local().display_url(), "unix:///var/run/docker.sock");
        assert_eq!(
            ConnectionProfile { kind: "ssh".into(), host: "root@10.0.0.5".into(), ..Default::default() }.display_url(),
            "ssh://root@10.0.0.5"
        );
        assert_eq!(
            ConnectionProfile { kind: "tls".into(), host: "10.0.0.5:2376".into(), ..Default::default() }.display_url(),
            "https://10.0.0.5:2376"
        );
    }

    #[test]
    fn normalize_registry_host_strips_scheme_and_lowercases() {
        assert_eq!(normalize_registry_host(" registry.cn-hangzhou.aliyuncs.com "), "registry.cn-hangzhou.aliyuncs.com");
        assert_eq!(normalize_registry_host("https://Harbor.Example.com/"), "harbor.example.com");
        assert_eq!(normalize_registry_host("http://harbor.local:5000/"), "harbor.local:5000");
        assert_eq!(normalize_registry_host("   "), "");
    }

    #[test]
    fn sanitize_registry_profiles_fields_and_ids() {
        let s = sanitize(AppSettings {
            registries: vec![
                RegistryProfile {
                    id: String::new(),
                    name: "  ".into(),
                    kind: "unknown".into(),
                    registry: " HTTPS://Aliyun.COM/ ".into(),
                    username: " user ".into(),
                    ..Default::default()
                },
                // 缺 registry 或 username 的凭据应被丢弃
                RegistryProfile {
                    id: "no-host".into(),
                    name: "a".into(),
                    kind: "harbor".into(),
                    username: "u".into(),
                    ..Default::default()
                },
                RegistryProfile {
                    id: "no-user".into(),
                    name: "b".into(),
                    kind: "harbor".into(),
                    registry: "h.local".into(),
                    ..Default::default()
                },
                // 重复 id 重新生成
                RegistryProfile {
                    id: "dup".into(),
                    name: "c".into(),
                    kind: "aliyun".into(),
                    registry: "r1.aliyuncs.com".into(),
                    username: "u1".into(),
                    ..Default::default()
                },
                RegistryProfile {
                    id: "dup".into(),
                    name: "d".into(),
                    kind: "aliyun".into(),
                    registry: "r2.aliyuncs.com".into(),
                    username: "u2".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        assert_eq!(s.registries.len(), 3);
        let first = &s.registries[0];
        assert_eq!(first.name, "未命名仓库");
        assert_eq!(first.kind, "generic", "未知 kind 应回落 generic");
        assert_eq!(first.registry, "aliyun.com");
        assert_eq!(first.username, "user");
        assert_eq!(first.secret_backend, "keyring", "非法 backend 应回落 keyring");
        assert!(first.created_at > 0, "空 created_at 应回落当前时间");
        assert_ne!(s.registries[1].id, s.registries[2].id, "重复 id 应重新生成");
    }

    #[test]
    fn parse_keeps_registries_field_from_old_configs() {
        // 旧配置无 registries 字段 → serde default 补空列表；新配置可正常读回
        let old = parse_settings(r#"{"theme":"dark"}"#);
        assert!(old.registries.is_empty());
        let new = parse_settings(
            r#"{"registries":[{"id":"r1","name":"aliyun","kind":"aliyun","registry":"registry.cn-hangzhou.aliyuncs.com","username":"u","secret_backend":"keyring","created_at":100}]}"#,
        );
        assert_eq!(new.registries.len(), 1);
        assert_eq!(new.registries[0].registry, "registry.cn-hangzhou.aliyuncs.com");
    }
}
