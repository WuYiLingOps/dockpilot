//! SSH 连接密钥管理：登录密码与私钥口令存 secret_store（系统钥匙串，
//! 回退机器绑定加密文件），实际落点提示记录在 ConnectionProfile.secret_backend。
//!
//! key_id 约定：`ssh/{profile_id}` = 登录密码（auth=password）；
//! `sshkey/{profile_id}` = 私钥口令（加密私钥的可选解锁口令）。
//! 两条密钥分属不同 key_id，但共用 secret_backend 提示字段，
//! 读取/删除走 load_secret_any / delete_secret_any 双后端兜底。
//!
//! 与 registries.rs 的差异：连接档案由前端经 set_settings 整包维护，
//! 没有「单条删除」命令，因此已删除连接的孤儿密钥在 set_settings 中 diff 清理。

use crate::docker::conn::CmdResult;
use crate::secret_store::{self, SecretBackend};
use crate::settings::{self, AppSettings};

/// 登录密码的密钥条目 id
pub fn password_key(profile_id: &str) -> String {
    format!("ssh/{profile_id}")
}

/// 私钥口令的密钥条目 id
pub fn passphrase_key(profile_id: &str) -> String {
    format!("sshkey/{profile_id}")
}

/// 密钥类型 → 密钥条目 id；非法类型报错
fn secret_key_for(profile_id: &str, kind: &str) -> Result<String, String> {
    match kind {
        "password" => Ok(password_key(profile_id)),
        "key_passphrase" => Ok(passphrase_key(profile_id)),
        other => Err(format!("未知的 ssh 密钥类型: {other}")),
    }
}

/// 保存或清除 ssh 密钥（kind: "password" | "key_passphrase"）。
/// secret 为空 = 清除该类密钥（编辑时留空不改密钥的语义由前端保证，
/// 只有用户主动清空密码框并保存时才传空串）。
#[tauri::command]
pub async fn set_ssh_secret(
    app: tauri::AppHandle,
    profile_id: String,
    kind: String,
    secret: String,
) -> CmdResult<()> {
    let key = secret_key_for(&profile_id, &kind)?;

    let mut s = settings::load(&app);
    let profile = settings::find_connection(&s, &profile_id)
        .ok_or_else(|| format!("连接配置不存在: {profile_id}"))?
        .clone();
    if profile.kind != "ssh" {
        return Err("仅 SSH 连接支持保存密码/私钥口令".into());
    }

    let dir = secret_store::config_dir(&app)?;
    let backend = if secret.is_empty() {
        let prefer = backend_hint(&profile.secret_backend);
        secret_store::delete_secret_any(&dir, &key, prefer)?;
        log::info!("已清除 SSH 连接 {} 的{}密钥", profile_id, kind);
        String::new()
    } else {
        let backend = secret_store::save_secret(&dir, &key, &secret)?;
        log::info!(
            "已保存 SSH 连接 {} 的{}密钥（{}）",
            profile_id,
            kind,
            backend.as_str()
        );
        backend.as_str().to_string()
    };

    // 就地更新落点提示，保持连接列表顺序不变
    let target = s
        .connections
        .iter_mut()
        .find(|c| c.id == profile_id)
        .ok_or_else(|| format!("连接配置不存在: {profile_id}"))?;
    target.secret_backend = backend;
    settings::save(&app, &s)?;
    Ok(())
}

fn backend_hint(secret_backend: &str) -> SecretBackend {
    SecretBackend::parse(secret_backend).unwrap_or(SecretBackend::Keyring)
}

/// 读取已保存的 ssh 密钥（不存在返回 None）
pub fn load(
    dir: &std::path::Path,
    profile: &settings::ConnectionProfile,
    kind: &str,
) -> Option<String> {
    let key = secret_key_for(&profile.id, kind).ok()?;
    let prefer = backend_hint(&profile.secret_backend);
    secret_store::load_secret_any(dir, &key, prefer)
        .ok()
        .flatten()
}

/// 连接被删除时清理其全部密钥（密码 + 私钥口令，双后端尽力而为）。
/// 由 set_settings 在 diff 出已删除的 ssh 连接后调用；失败仅记日志，
/// 不阻断设置保存（密钥残留可由重新保存/覆盖兜底）。
pub fn cleanup_removed(app: &tauri::AppHandle, old: &AppSettings, new: &AppSettings) {
    let Ok(dir) = secret_store::config_dir(app) else {
        return;
    };
    cleanup_removed_in(&dir, old, new);
}

/// 清理的可测核心：目录参数化
fn cleanup_removed_in(dir: &std::path::Path, old: &AppSettings, new: &AppSettings) {
    for c in &old.connections {
        if c.kind != "ssh" || new.connections.iter().any(|n| n.id == c.id) {
            continue;
        }
        let prefer = backend_hint(&c.secret_backend);
        for key in [password_key(&c.id), passphrase_key(&c.id)] {
            if let Err(e) = secret_store::delete_secret_any(dir, &key, prefer) {
                log::warn!("清理已删除 SSH 连接 {} 的密钥失败: {e}", c.id);
            }
        }
        log::info!("已清理已删除 SSH 连接 {} 的密钥", c.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ConnectionProfile;

    fn tempdir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dockpilot-ssh-secret-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ssh_profile(id: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.into(),
            kind: "ssh".into(),
            host: "root@10.0.0.5".into(),
            ..Default::default()
        }
    }

    #[test]
    fn secret_key_mapping() {
        assert_eq!(password_key("abc"), "ssh/abc");
        assert_eq!(passphrase_key("abc"), "sshkey/abc");
        assert!(secret_key_for("abc", "other").is_err());
    }

    #[test]
    fn cleanup_removed_deletes_only_gone_ssh_profiles() {
        let dir = tempdir();
        // file 后端可直接落盘测试（keyring 写入会污染真实钥匙串，不走 save_secret）
        let old = AppSettings {
            connections: vec![ssh_profile("gone"), ssh_profile("kept")],
            ..Default::default()
        };
        let new = AppSettings {
            connections: vec![ssh_profile("kept")],
            ..Default::default()
        };
        secret_store::save_file(&dir, &password_key("gone"), "pw").unwrap();
        secret_store::save_file(&dir, &passphrase_key("gone"), "phrase").unwrap();
        secret_store::save_file(&dir, &password_key("kept"), "pw").unwrap();

        cleanup_removed_in(&dir, &old, &new);

        assert!(secret_store::load_file(&dir, &password_key("gone"))
            .unwrap()
            .is_none());
        assert!(secret_store::load_file(&dir, &passphrase_key("gone"))
            .unwrap()
            .is_none());
        assert_eq!(
            secret_store::load_file(&dir, &password_key("kept"))
                .unwrap()
                .as_deref(),
            Some("pw")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cleanup_ignores_non_ssh_and_missing_entries() {
        let dir = tempdir();
        let mut local = ssh_profile("x");
        local.kind = "local".into();
        let old = AppSettings {
            connections: vec![local],
            ..Default::default()
        };
        let new = AppSettings::default();
        // 不应 panic、不触碰任何后端
        cleanup_removed_in(&dir, &old, &new);
        std::fs::remove_dir_all(&dir).ok();
    }
}
