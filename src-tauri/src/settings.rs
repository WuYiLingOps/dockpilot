use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

use crate::docker::conn::CmdResult;

/// 应用设置：持久化到 app_config_dir()/settings.json。
/// 反序列化带 #[serde(default)]，旧文件缺字段自动补默认值，
/// 文件缺失或损坏时整体回落默认值。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppSettings {
    /// "system" | "light" | "dark"
    pub theme: String,
    /// 自定义 Docker socket 路径；为空时使用默认 /var/run/docker.sock。
    /// 连接在启动后缓存，修改需重启应用生效。
    pub docker_socket: String,
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
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            docker_socket: String::new(),
            containers_refresh_secs: 10,
            images_refresh_secs: 20,
            logs_default_tail: 1000,
            logs_timestamps: false,
            terminal_shell: "bash".into(),
            mirror_custom: Vec::new(),
        }
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
        Ok(text) => sanitize(parse_settings(&text)),
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
// conn.rs 启动时读取的 socket 覆盖值（不随运行中修改，重启应用生效）
// ------------------------------------------------------------------

static DOCKER_SOCKET: RwLock<Option<String>> = RwLock::new(None);

pub fn set_docker_socket(path: Option<String>) {
    if let Ok(mut g) = DOCKER_SOCKET.write() {
        *g = path;
    }
}

pub fn docker_socket() -> Option<String> {
    DOCKER_SOCKET.read().ok().and_then(|g| g.clone())
}

#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> CmdResult<AppSettings> {
    Ok(load(&app))
}

#[tauri::command]
pub async fn set_settings(app: tauri::AppHandle, settings: AppSettings) -> CmdResult<AppSettings> {
    let s = sanitize(settings);
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
}
