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
    pub registry_mirrors: Vec<String>,
    /// live-restore 是否开启（开启时重启 daemon 不中断运行中的容器）
    pub live_restore: bool,
    /// 除 registry-mirrors 外用户已有的其他配置键（提示会被保留）
    pub other_keys: Vec<String>,
}

/// 读取 daemon.json；文件不存在返回 (false, {})
fn read_daemon_json() -> Result<(bool, serde_json::Value), String> {
    match std::fs::read_to_string(DAEMON_JSON) {
        Ok(text) => {
            let v: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("解析 {DAEMON_JSON} 失败: {e}（文件内容不是合法 JSON）"))?;
            Ok((true, v))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((false, serde_json::json!({}))),
        Err(e) => Err(format!("读取 {DAEMON_JSON} 失败: {e}")),
    }
}

/// 只改 registry-mirrors 字段，保留其余配置；列表为空则移除该字段。
/// 独立成纯函数便于单元测试。
pub fn merge_mirrors(v: &mut serde_json::Value, mirrors: &[String]) -> Result<(), String> {
    let obj = v
        .as_object_mut()
        .ok_or_else(|| format!("{DAEMON_JSON} 顶层必须是 JSON 对象"))?;
    if mirrors.is_empty() {
        obj.remove("registry-mirrors");
    } else {
        obj.insert(
            "registry-mirrors".into(),
            serde_json::Value::Array(
                mirrors
                    .iter()
                    .map(|m| serde_json::Value::String(m.clone()))
                    .collect(),
            ),
        );
    }
    Ok(())
}

/// 把清洗后的 mirrors 应用到 daemon.json（保留其他字段），返回合并后的 JSON 文本
fn merged_daemon_json(mirrors: &[String]) -> Result<(bool, String), String> {
    let (exists, mut v) = read_daemon_json()?;
    merge_mirrors(&mut v, mirrors)?;
    let text = serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败: {e}"))?;
    Ok((exists, text))
}

/// 规范化加速源：去空白/末尾斜杠、补 scheme、去空
fn clean_mirrors(mirrors: &[String]) -> Vec<String> {
    let mut out: Vec<String> = mirrors
        .iter()
        .map(|m| crate::settings::normalize_mirror(m))
        .filter(|m| !m.is_empty())
        .collect();
    out.dedup();
    out
}

fn trim(s: &[u8]) -> String {
    String::from_utf8_lossy(s).trim().to_string()
}

#[tauri::command]
pub async fn read_daemon_config() -> CmdResult<DaemonConfigDto> {
    let (exists, v) = read_daemon_json()?;
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
        registry_mirrors,
        live_restore,
        other_keys,
    })
}

/// 应用加速源配置：写临时文件后经 pkexec 提权备份并覆盖 daemon.json。
/// shell 脚本内容全部由应用侧生成（仅含固定路径），用户输入只进入 JSON 文件内容，无注入面。
#[tauri::command]
pub async fn apply_mirrors(mirrors: Vec<String>) -> CmdResult<()> {
    let mirrors = clean_mirrors(&mirrors);
    let (exists, text) = merged_daemon_json(&mirrors)?;

    let tmp = std::env::temp_dir().join(format!("dockpilot-daemon-{}.json", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, &text).map_err(|e| format!("写入临时文件失败: {e}"))?;

    let tmp_display = tmp.display();
    let script = if exists {
        format!(
            "cp -f {DAEMON_JSON} {DAEMON_JSON_BAK} && install -m 644 {tmp_display} {DAEMON_JSON}"
        )
    } else {
        format!("install -m 644 {tmp_display} {DAEMON_JSON}")
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
        return Err(format!("写入 daemon.json 失败: {stderr}（可在下方改用终端命令手动执行）"));
    }
    Ok(())
}

/// 经 pkexec 重启 Docker 服务（systemctl restart docker）
#[tauri::command]
pub async fn restart_docker() -> CmdResult<()> {
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
        return Err(format!("重启 Docker 失败: {}", trim(&out.stderr)));
    }
    Ok(())
}

/// 生成手动执行的终端命令（pkexec 不可用时的回退），JSON 已与现有 daemon.json 合并
#[tauri::command]
pub async fn generate_mirrors_command(mirrors: Vec<String>) -> CmdResult<String> {
    let mirrors = clean_mirrors(&mirrors);
    let (_, text) = merged_daemon_json(&mirrors)?;
    // shell 单引号转义，防止 JSON 内容意外闭合引号
    let quoted = text.replace('\'', r#"'\''"#);
    Ok(format!(
        "printf '%s' '{quoted}' | sudo tee {DAEMON_JSON} >/dev/null && sudo systemctl restart docker"
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
    Ok(start.elapsed().as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_mirrors_preserves_other_fields() {
        let mut v = serde_json::json!({
            "debug": true,
            "registry-mirrors": ["https://old.example.com"],
            "insecure-registries": ["192.168.0.0/16"]
        });
        merge_mirrors(&mut v, &["https://new.example.com".into()]).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "debug": true,
                "registry-mirrors": ["https://new.example.com"],
                "insecure-registries": ["192.168.0.0/16"]
            })
        );
    }

    #[test]
    fn merge_mirrors_adds_key_to_object_without_it() {
        let mut v = serde_json::json!({"log-driver": "json-file"});
        merge_mirrors(&mut v, &["https://a.com".into()]).unwrap();
        assert_eq!(
            v.get("registry-mirrors").unwrap(),
            &serde_json::json!(["https://a.com"])
        );
        assert_eq!(v.get("log-driver").unwrap(), "json-file");
    }

    #[test]
    fn merge_mirrors_empty_removes_key() {
        let mut v = serde_json::json!({"registry-mirrors": ["https://a.com"], "debug": false});
        merge_mirrors(&mut v, &[]).unwrap();
        assert!(v.get("registry-mirrors").is_none());
        assert_eq!(v.get("debug").unwrap(), &serde_json::json!(false));
    }

    #[test]
    fn merge_mirrors_rejects_non_object_top_level() {
        let mut v = serde_json::json!([1, 2]);
        assert!(merge_mirrors(&mut v, &["https://a.com".into()]).is_err());
    }

    #[test]
    fn clean_mirrors_normalizes_and_dedups() {
        let out = clean_mirrors(&[
            " https://a.com/ ".into(),
            "a.com".into(),
            "".into(),
            "  ".into(),
        ]);
        assert_eq!(out, vec!["https://a.com".to_string()]);
    }
}
