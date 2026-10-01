//! SSH 主机指纹存储（TOFU：Trust On First Use）。
//!
//! 替代系统 ssh 的 StrictHostKeyChecking=accept-new 语义：
//! 首次连接自动记录主机指纹；指纹变化时连接被拒绝，由前端弹窗确认后经
//! `accept_host_key` 命令覆盖记录。
//!
//! 条目按 (dest, algo) 隔离：一台服务器常同时配置多种主机密钥算法，
//! 服务端轮换通告算法不应误判为密钥变更。存储于 app_config_dir()/ssh_known_hosts.json，
//! 独立于 settings.json（不参与云同步）。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::docker::conn::CmdResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KnownHost {
    /// 主机标识：22 端口为 host，非 22 为 [host]:port（对齐 OpenSSH known_hosts 惯例）
    pub dest: String,
    /// OpenSSH SHA256 指纹（SHA256:base64），可与 ssh-keygen -lf 输出对照
    pub fingerprint: String,
    /// 主机密钥算法（ssh-ed25519 / rsa-sha2-256 / ecdsa-sha2-nistp256 …）
    pub algo: String,
    /// 记录时间（unix 秒）
    pub added_at: i64,
}

/// 指纹比对结果
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// 首次见到该主机（该算法）
    New,
    /// 指纹一致
    Match,
    /// 指纹变更（携带原指纹，用于弹窗展示）
    Mismatch { stored: String },
}

/// known_hosts 主机标识：host 小写；非 22 端口加 [host]:port 括号（IPv6 亦天然需要）
pub fn dest_key(host: &str, port: u16) -> String {
    let host = host.trim().to_ascii_lowercase();
    if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    }
}

fn file_path(dir: &Path) -> PathBuf {
    dir.join("ssh_known_hosts.json")
}

/// 读取全部条目；文件缺失或损坏时按空处理（与 settings 同策略：不因存储问题阻断连接）
pub fn load(dir: &Path) -> Vec<KnownHost> {
    std::fs::read_to_string(file_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// tmp + rename 原子写入（对齐 settings.rs 做法）
fn save(dir: &Path, hosts: &[KnownHost]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let text =
        serde_json::to_string_pretty(hosts).map_err(|e| format!("序列化主机指纹失败: {e}"))?;
    let path = file_path(dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入主机指纹失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存主机指纹失败: {e}"))?;
    Ok(())
}

/// 比对主机指纹（只读，不落盘）
pub fn check(dir: &Path, dest: &str, fingerprint: &str, algo: &str) -> Result<Decision, String> {
    Ok(load(dir)
        .iter()
        .find(|h| h.dest == dest && h.algo == algo)
        .map_or(Decision::New, |h| {
            if h.fingerprint == fingerprint {
                Decision::Match
            } else {
                Decision::Mismatch {
                    stored: h.fingerprint.clone(),
                }
            }
        }))
}

/// 记录（或经用户确认后覆盖）主机指纹
pub fn record(dir: &Path, dest: &str, fingerprint: &str, algo: &str) -> Result<(), String> {
    let mut hosts = load(dir);
    hosts.retain(|h| !(h.dest == dest && h.algo == algo));
    hosts.push(KnownHost {
        dest: dest.to_string(),
        fingerprint: fingerprint.to_string(),
        algo: algo.to_string(),
        added_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    });
    save(dir, &hosts)
}

/// 用户确认接受新的主机指纹（覆盖旧记录）
#[tauri::command]
pub async fn accept_host_key(
    app: tauri::AppHandle,
    dest: String,
    fingerprint: String,
    algo: String,
) -> CmdResult<()> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?;
    record(&dir, &dest, &fingerprint, &algo)?;
    log::info!("已接受主机 {dest}（{algo}）的指纹 {fingerprint}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dockpilot-known-hosts-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dest_key_normalizes_host_case_and_brackets_port() {
        assert_eq!(dest_key("Example.COM", 22), "example.com");
        assert_eq!(dest_key("10.0.0.5", 2222), "[10.0.0.5]:2222");
        assert_eq!(dest_key("::1", 22), "::1");
        assert_eq!(dest_key("::1", 2222), "[::1]:2222");
    }

    #[test]
    fn tofu_flow_new_match_mismatch_and_accept() {
        let dir = tempdir();
        // 首次连接：New
        assert_eq!(check(&dir, "h", "FP1", "ssh-ed25519"), Ok(Decision::New));
        record(&dir, "h", "FP1", "ssh-ed25519").unwrap();
        // 一致：Match
        assert_eq!(check(&dir, "h", "FP1", "ssh-ed25519"), Ok(Decision::Match));
        // 变更：Mismatch 并携带旧指纹
        assert_eq!(
            check(&dir, "h", "FP2", "ssh-ed25519"),
            Ok(Decision::Mismatch {
                stored: "FP1".into()
            })
        );
        // 不同算法互不干扰（服务器同时通告多种主机密钥是常态）
        assert_eq!(check(&dir, "h", "FPX", "rsa-sha2-256"), Ok(Decision::New));
        record(&dir, "h", "FPX", "rsa-sha2-256").unwrap();
        assert_eq!(check(&dir, "h", "FP1", "ssh-ed25519"), Ok(Decision::Match));
        // 用户确认后覆盖
        record(&dir, "h", "FP2", "ssh-ed25519").unwrap();
        assert_eq!(check(&dir, "h", "FP2", "ssh-ed25519"), Ok(Decision::Match));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_or_corrupt_store_treated_as_empty() {
        let dir = tempdir();
        assert!(load(&dir).is_empty());
        assert_eq!(check(&dir, "h", "FP", "a"), Ok(Decision::New));
        // 损坏文件按空处理
        std::fs::write(file_path(&dir), "not json").unwrap();
        assert!(load(&dir).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
