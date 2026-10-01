use serde::Serialize;
use std::time::{Duration, Instant};

use crate::docker::conn::CmdResult;

/// Docker daemon 配置文件；读取通常无需 root，写入与重启需要（走 pkexec）
const DAEMON_JSON: &str = "/etc/docker/daemon.json";
/// 覆盖前的自动备份路径
const DAEMON_JSON_BAK: &str = "/etc/docker/daemon.json.dockpilot.bak";

#[derive(Debug, Clone, Serialize)]
pub struct DaemonConfigDto {
    /// daemon.json 是否存在
    pub exists: bool,
    /// 文件原始文本（不存在时为空串），编辑器直接展示、应用时整体写回
    pub raw: String,
    pub registry_mirrors: Vec<String>,
    /// live-restore 是否开启（开启时重启 daemon 不中断运行中的容器）
    pub live_restore: bool,
    /// 除 registry-mirrors 外用户已有的其他配置键
    pub other_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DaemonValidationDto {
    /// 阻断写入的错误（JSON 语法、顶层类型、dockerd 校验失败）
    pub errors: Vec<String>,
    /// 不阻断的提示（可疑键、存储位置变更风险等）
    pub warnings: Vec<String>,
    /// 深度校验（dockerd --validate）是否实际执行；未执行时仅做了语法与语义检查
    pub deep_checked: bool,
}

/// 读取 JSON 文本；文件不存在返回 (false, "")。独立出路径参数便于单元测试。
fn read_json_file(path: &str) -> Result<(bool, String), String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok((true, text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((false, String::new())),
        Err(e) => Err(format!("读取 {path} 失败: {e}")),
    }
}

fn read_daemon_raw() -> Result<(bool, String), String> {
    read_json_file(DAEMON_JSON)
}

/// 语法 + 语义校验（不含 dockerd 深度校验），独立成纯函数便于单元测试。
/// 与 dockerd 一致按严格 JSON 处理（不支持注释、尾逗号）。
/// current 为磁盘当前文件文本（用于提示存储位置类键的变更风险），解析失败时忽略。
fn validate_content(content: &str, current: Option<&str>) -> (Vec<String>, Vec<String>) {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let v: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => {
            errors.push(format!("JSON 语法错误: {e}"));
            return (errors, warnings);
        }
    };
    let Some(obj) = v.as_object() else {
        errors.push("顶层必须是 JSON 对象（{...}）".into());
        return (errors, warnings);
    };
    if let Some(mirrors) = obj.get("registry-mirrors") {
        match mirrors.as_array() {
            None => errors.push("registry-mirrors 必须是字符串数组".into()),
            Some(items) => {
                for item in items {
                    match item.as_str() {
                        Some(s) if s.trim().is_empty() => {
                            warnings.push("registry-mirrors 存在空字符串条目，daemon 将忽略".into())
                        }
                        Some(_) => {}
                        None => errors.push("registry-mirrors 必须是字符串数组".into()),
                    }
                }
            }
        }
    }
    // hosts 与 systemd 版 docker.service 的 ExecStart -H 冲突，是 daemon 拒绝启动的常见原因
    if obj.contains_key("hosts") {
        warnings.push(
            "检测到 hosts 键：systemd 部署的 Docker 与其 ExecStart 的 -H 参数冲突，可能导致 daemon 无法启动".into(),
        );
    }
    // 存储位置类键变更后既有镜像/容器不可见；新值本身是否合法交给深度校验
    if let Some(cur) = current.and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok()) {
        for key in ["storage-driver", "data-root"] {
            if obj.contains_key(key) && cur.get(key).is_some() && obj.get(key) != cur.get(key) {
                warnings.push(format!(
                    "{key} 与当前配置不同：切换后既有的镜像/容器可能不可见，请确认后再应用"
                ));
            }
        }
    }
    (errors, warnings)
}

/// dockerd 深度校验确认不可用（版本过老等）后的缓存标记，避免重复空跑子进程
static DEEP_VALIDATE_UNSUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// 尽力而为的深度校验：交给本机 dockerd 自身的解析器（含未知键、取值合法性检查）。
/// dockerd 缺失、版本过老、非 root 被拒或超时都静默降级（返回 false），仅做语法校验；
/// 提权写入时始终有 dockerd 门禁兜底，此处失败不影响安全性。
async fn deep_validate(content: &str) -> (bool, Vec<String>) {
    if DEEP_VALIDATE_UNSUPPORTED.get() == Some(&true) {
        return (false, Vec::new());
    }
    let tmp = std::env::temp_dir().join(format!(
        "dockpilot-daemon-validate-{}.json",
        uuid::Uuid::new_v4()
    ));
    if std::fs::write(&tmp, content).is_err() {
        return (false, Vec::new());
    }
    let out = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::process::Command::new("dockerd")
            .args(["--validate", "--config-file"])
            .arg(&tmp)
            .output(),
    )
    .await;
    let _ = std::fs::remove_file(&tmp);
    let Ok(Ok(out)) = out else {
        // 无法启动或超时：无法区分是缺 dockerd 还是环境异常，按未执行处理
        return (false, Vec::new());
    };
    let combined = format!("{} {}", trim(&out.stdout), trim(&out.stderr));
    // Go flag 包对未注册 flag 的报错，说明 dockerd 不支持 --validate（< 23.0）
    if combined.contains("provided but not defined") || combined.contains("unknown flag") {
        DEEP_VALIDATE_UNSUPPORTED.set(true).ok();
        return (false, Vec::new());
    }
    if out.status.success() {
        return (true, Vec::new());
    }
    // 非 root 运行 dockerd 被拒（部分发行版在 flag 解析后即检查 euid），降级处理
    if combined.contains("permission denied") || combined.to_lowercase().contains("root") {
        return (false, Vec::new());
    }
    (true, vec![format!("dockerd 校验失败: {combined}")])
}

fn trim(s: &[u8]) -> String {
    String::from_utf8_lossy(s).trim().to_string()
}

/// 本模块的读写/重启命令面向 Linux 本机 Docker（/etc/docker/daemon.json + pkexec/systemctl），
/// Windows 版不支持本地 daemon 管理（UI 亦隐藏入口，此处双保险）
#[cfg(windows)]
fn unsupported_platform() -> CmdResult<()> {
    Err("该功能仅支持 Linux 本机 Docker".to_string())
}

#[cfg(not(windows))]
fn unsupported_platform() -> CmdResult<()> {
    Ok(())
}

#[tauri::command]
pub async fn read_daemon_config() -> CmdResult<DaemonConfigDto> {
    unsupported_platform()?;
    let (exists, raw) = read_daemon_raw()?;
    // 解析失败时按空对象处理：编辑器会展示原文并标出语法错误，不应阻塞读取
    let v = serde_json::from_str::<serde_json::Value>(&raw).unwrap_or(serde_json::json!({}));
    let registry_mirrors = v
        .get("registry-mirrors")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let live_restore = v
        .get("live-restore")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let other_keys = v
        .as_object()
        .map(|o| {
            o.keys()
                .filter(|k| k.as_str() != "registry-mirrors")
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    Ok(DaemonConfigDto {
        exists,
        raw,
        registry_mirrors,
        live_restore,
        other_keys,
    })
}

/// 编辑器实时校验：语法 + 语义 + 尽力 dockerd 深度校验；返回的错误列表由前端阻断应用
#[tauri::command]
pub async fn validate_daemon_json(content: String) -> CmdResult<DaemonValidationDto> {
    unsupported_platform()?;
    let (exists, current_raw) = read_daemon_raw()?;
    let (mut errors, warnings) = validate_content(&content, exists.then_some(current_raw.as_str()));
    let mut deep_checked = false;
    if errors.is_empty() {
        let (ok, deep_errors) = deep_validate(&content).await;
        deep_checked = ok;
        errors.extend(deep_errors);
    }
    Ok(DaemonValidationDto {
        errors,
        warnings,
        deep_checked,
    })
}

/// 整体写入 daemon.json（编辑器内容即最终内容）：写临时文件后经 pkexec 提权执行
/// [dockerd --validate 门禁（若可用）] → 备份原文件 → 原子覆盖。
/// shell 脚本内容全部由应用侧生成（仅含固定路径），用户输入只进入 JSON 文件内容，无注入面。
#[tauri::command]
pub async fn write_daemon_json(content: String) -> CmdResult<()> {
    unsupported_platform()?;
    // 写入前再校验一次，语法/顶层类型错误绝不落盘
    let (errors, _) = validate_content(&content, None);
    if !errors.is_empty() {
        return Err(errors.join("；"));
    }
    let (exists, _) = read_daemon_raw()?;

    let tmp = std::env::temp_dir().join(format!("dockpilot-daemon-{}.json", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, &content).map_err(|e| format!("写入临时文件失败: {e}"))?;

    let tmp_display = tmp.display();
    // dockerd 门禁：配置非法时中止且不落盘；旧版 dockerd 无 --validate 时自动跳过
    let gate = format!(
        r#"if command -v dockerd >/dev/null 2>&1; then gate=$(dockerd --validate --config-file {tmp_display} 2>&1); if [ $? -ne 0 ]; then case "$gate" in *"provided but not defined"*|*"unknown flag"*) : ;; *) echo "$gate" >&2; exit 1 ;; esac; fi; fi"#
    );
    let script = if exists {
        format!(
            r#"{gate}; cp -f {DAEMON_JSON} {DAEMON_JSON_BAK} && install -m 644 {tmp_display} {DAEMON_JSON}"#
        )
    } else {
        format!(r#"{gate}; install -m 644 {tmp_display} {DAEMON_JSON}"#)
    };

    let out = tokio::process::Command::new("pkexec")
        .args(["/bin/sh", "-c", &script])
        .output()
        .await
        .map_err(|e| format!("无法启动 pkexec: {e}（请确认系统安装了 polkit）"))?;

    let _ = std::fs::remove_file(&tmp);

    if !out.status.success() {
        let stderr = trim(&out.stderr);
        if stderr.contains("dismissed") || stderr.contains("cancelled") {
            return Err("已取消授权，未修改配置".into());
        }
        log::warn!("daemon.json 写入失败：{stderr}");
        return Err(format!(
            "写入 daemon.json 失败: {stderr}（可在下方改用终端命令手动执行）"
        ));
    }
    log::info!(
        "daemon.json 已写入（{}）",
        if exists {
            format!("原文件已备份为 {DAEMON_JSON_BAK}")
        } else {
            "新建配置".to_string()
        }
    );
    Ok(())
}

/// 经 pkexec 重启 Docker 服务（systemctl restart docker）
#[tauri::command]
pub async fn restart_docker() -> CmdResult<()> {
    unsupported_platform()?;
    log::info!("重启 Docker 服务（systemctl restart docker）");
    let out = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new("pkexec")
            .args(["systemctl", "restart", "docker"])
            .output(),
    )
    .await
    .map_err(|_| "重启超时，请检查 systemd 状态".to_string())?
    .map_err(|e| format!("无法启动 pkexec: {e}（请确认系统安装了 polkit）"))?;

    if !out.status.success() {
        log::warn!("重启 Docker 失败: {}", trim(&out.stderr));
        return Err(format!("重启 Docker 失败: {}", trim(&out.stderr)));
    }
    log::info!("Docker 服务已重启");
    Ok(())
}

/// 生成手动执行的终端命令（pkexec 不可用时的回退）：先写临时文件，经 dockerd 校验后
/// 替换 daemon.json 并重启，与应用内写入流程等价（旧版 dockerd 会在 --validate 处中止，属安全失败）
#[tauri::command]
pub async fn generate_daemon_command(content: String) -> CmdResult<String> {
    unsupported_platform()?;
    let (errors, _) = validate_content(&content, None);
    if !errors.is_empty() {
        return Err(errors.join("；"));
    }
    // shell 单引号转义，防止 JSON 内容意外闭合引号
    let quoted = content.replace('\'', r#"'\''"#);
    Ok(format!(
        "printf '%s' '{quoted}' | sudo tee /tmp/dockpilot-daemon.json >/dev/null && sudo dockerd --validate --config-file /tmp/dockpilot-daemon.json && sudo install -m 644 /tmp/dockpilot-daemon.json {DAEMON_JSON} && sudo systemctl restart docker"
    ))
}

/// 测速：GET {url}/v2/，任意 HTTP 响应（含 401/404）都算可达，返回毫秒
#[tauri::command]
pub async fn test_mirror(url: String) -> CmdResult<u64> {
    let url = crate::settings::normalize_mirror(&url);
    if url.is_empty() {
        return Err("地址为空".into());
    }

    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(4))
            .user_agent("DockPilot")
            .build()
            .expect("构建 HTTP 客户端失败")
    });

    let start = Instant::now();
    client
        .get(format!("{url}/v2/"))
        .send()
        .await
        .map_err(|e| format!("{url} 不可达: {e}"))?;
    let ms = start.elapsed().as_millis() as u64;
    log::info!("镜像源测速：{url} → {ms} ms");
    Ok(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_accepts_valid_object() {
        let (errors, warnings) = validate_content(
            r#"{"registry-mirrors":["https://a.com"],"debug":true}"#,
            None,
        );
        assert!(errors.is_empty());
        assert!(warnings.is_empty());
    }

    #[test]
    fn validate_rejects_syntax_errors() {
        for text in ["{", r#"{"debug":true,}"#, "", "not json"] {
            let (errors, _) = validate_content(text, None);
            assert_eq!(errors.len(), 1, "{text}");
            assert!(errors[0].starts_with("JSON 语法错误"), "{text}");
        }
    }

    #[test]
    fn validate_rejects_non_object_top_level() {
        let (errors, _) = validate_content("[1,2]", None);
        assert!(errors.iter().any(|e| e.contains("顶层必须是 JSON 对象")));
    }

    #[test]
    fn validate_checks_registry_mirrors_type() {
        let (errors, _) = validate_content(r#"{"registry-mirrors":"https://a.com"}"#, None);
        assert!(errors.iter().any(|e| e.contains("字符串数组")));
        let (errors, _) = validate_content(r#"{"registry-mirrors":[1]}"#, None);
        assert!(errors.iter().any(|e| e.contains("字符串数组")));
        let (_, warnings) = validate_content(r#"{"registry-mirrors":["  "]}"#, None);
        assert!(warnings.iter().any(|w| w.contains("空字符串")));
    }

    #[test]
    fn validate_warns_hosts_key() {
        let (_, warnings) = validate_content(r#"{"hosts":["unix:///var/run/docker.sock"]}"#, None);
        assert!(warnings.iter().any(|w| w.contains("hosts")));
        let (_, warnings) = validate_content(r#"{"debug":true}"#, None);
        assert!(warnings.is_empty());
    }

    #[test]
    fn validate_warns_storage_changes_against_current() {
        let current = r#"{"storage-driver":"overlay2","data-root":"/var/lib/docker"}"#;
        let (_, warnings) = validate_content(r#"{"storage-driver":"overlayfs"}"#, Some(current));
        assert!(warnings.iter().any(|w| w.contains("storage-driver")));
        // 值未变化或当前文件本就没有该键时不提示
        let (_, warnings) = validate_content(r#"{"data-root":"/var/lib/docker"}"#, Some(current));
        assert!(warnings.is_empty());
        let (_, warnings) = validate_content(r#"{"data-root":"/srv/docker"}"#, Some(current));
        assert!(warnings.iter().any(|w| w.contains("data-root")));
        // 当前文件解析失败时忽略对比
        let (_, warnings) = validate_content(r#"{"storage-driver":"overlayfs"}"#, Some("broken"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn read_json_file_missing_is_empty() {
        let (exists, raw) = read_json_file("/nonexistent/dockpilot-test/daemon.json").unwrap();
        assert!(!exists);
        assert_eq!(raw, "");
    }
}
