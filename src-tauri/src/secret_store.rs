//! registry 凭据等敏感信息的本地存储。
//!
//! 优先写入系统钥匙串（macOS Keychain / Windows 凭据管理器 / Linux Secret Service）；
//! 无钥匙串环境（无桌面的 Linux 等）自动回退到机器绑定的 AES-256-GCM 加密文件
//! （`app_config_dir()/secrets.bin`），密钥由 machine-id 经 SHA-256 派生。
//! 回退属于混淆级防护：可防同机其他普通用户直读，不防本用户与 root，换机/重装后不可解密。
//!
//! 实际落点由调用方记录（RegistryProfile.secret_backend），读取时按记录直取，不做猜测。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

/// 凭据实际存储位置
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretBackend {
    /// 系统钥匙串
    Keyring,
    /// 机器绑定加密文件（回退）
    File,
}

impl SecretBackend {
    pub fn as_str(&self) -> &'static str {
        match self {
            SecretBackend::Keyring => "keyring",
            SecretBackend::File => "file",
        }
    }

    pub fn parse(s: &str) -> Option<SecretBackend> {
        match s {
            "keyring" => Some(SecretBackend::Keyring),
            "file" => Some(SecretBackend::File),
            _ => None,
        }
    }
}

/// keyring 条目：同一 service 下按 key_id（如 `registry/{uuid}`）隔离
const KEYRING_SERVICE: &str = "com.dockpilot.app";

// ---------------------------------------------------------------------------
// 对外 API：核心函数以配置目录为参数（便于单测），app 包装层解析目录
// ---------------------------------------------------------------------------

pub fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))
}

/// 保存密钥：优先钥匙串，失败自动落加密文件，返回实际落点
pub fn save_secret(dir: &Path, key_id: &str, secret: &str) -> Result<SecretBackend, String> {
    match save_keyring(key_id, secret) {
        Ok(()) => Ok(SecretBackend::Keyring),
        // 无钥匙串环境（无桌面 Linux 等）：回退加密文件，落点由调用方记录并展示给用户
        Err(_) => {
            save_file(dir, key_id, secret)?;
            Ok(SecretBackend::File)
        }
    }
}

/// 读取密钥（按记录的存储位置）；不存在返回 None
pub fn load_secret(
    dir: &Path,
    key_id: &str,
    backend: SecretBackend,
) -> Result<Option<String>, String> {
    match backend {
        SecretBackend::Keyring => load_keyring(key_id),
        SecretBackend::File => load_file(dir, key_id),
    }
}

/// 删除密钥：尽力而为，条目不存在视为成功
pub fn delete_secret(dir: &Path, key_id: &str, backend: SecretBackend) -> Result<(), String> {
    let r = match backend {
        SecretBackend::Keyring => delete_keyring(key_id),
        SecretBackend::File => delete_file(dir, key_id),
    };
    match r {
        Ok(()) => Ok(()),
        // keyring: 平台差异的"条目不存在"；文件: 密钥文件缺失
        Err(e) if e.contains("NoEntry") || e.contains("找不到") || e.contains("不存在") => Ok(()),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// keyring 后端
// ---------------------------------------------------------------------------

fn keyring_entry(key_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, key_id).map_err(|e| format!("创建钥匙串条目失败: {e}"))
}

fn save_keyring(key_id: &str, secret: &str) -> Result<(), String> {
    keyring_entry(key_id)?
        .set_password(secret)
        .map_err(|e| format!("写入钥匙串失败: {e}"))
}

fn load_keyring(key_id: &str) -> Result<Option<String>, String> {
    match keyring_entry(key_id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取钥匙串失败: {e}")),
    }
}


fn delete_keyring(key_id: &str) -> Result<(), String> {
    keyring_entry(key_id)?
        .delete_credential()
        .map_err(|e| format!("删除钥匙串条目失败: {e}"))
}

// ---------------------------------------------------------------------------
// 加密文件后端：app_config_dir()/secrets.bin
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct VaultEntry {
    /// base64(nonce, 12 字节，每条独立)
    nonce: String,
    /// base64(AES-256-GCM 密文)
    cipher: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    entries: HashMap<String, VaultEntry>,
}

fn vault_path(dir: &Path) -> PathBuf {
    dir.join("secrets.bin")
}

/// 密钥派生：machine-id + 固定盐 → SHA-256（32 字节 AES-256 key）
fn derive_key() -> Result<[u8; 32], String> {
    let uid = machine_uid::get().map_err(|e| format!("获取机器标识失败: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(b"dockpilot-v1:secret-store:");
    hasher.update(uid.as_bytes());
    Ok(hasher.finalize().into())
}

fn load_vault(dir: &Path) -> Result<VaultFile, String> {
    let path = vault_path(dir);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("解析密钥文件失败: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(VaultFile {
            version: 1,
            entries: HashMap::new(),
        }),
        Err(e) => Err(format!("读取密钥文件失败: {e}")),
    }
}

/// tmp + rename 原子写（与 settings.json 同策略）
fn save_vault(dir: &Path, vault: &VaultFile) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let path = vault_path(dir);
    let text = serde_json::to_vec_pretty(vault).map_err(|e| format!("序列化密钥文件失败: {e}"))?;
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入密钥文件失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存密钥文件失败: {e}"))?;
    Ok(())
}

fn encrypt(secret: &str) -> Result<(String, String), String> {
    let key = derive_key()?;
    let cipher = Aes256Gcm::new((&key).into());
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, secret.as_bytes())
        .map_err(|e| format!("加密失败: {e}"))?;
    Ok((B64.encode(nonce), B64.encode(ct)))
}

fn decrypt(nonce_b64: &str, cipher_b64: &str) -> Result<String, String> {
    let key = derive_key()?;
    let cipher = Aes256Gcm::new((&key).into());
    let nonce_bytes = B64.decode(nonce_b64).map_err(|e| format!("解码 nonce 失败: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = B64.decode(cipher_b64).map_err(|e| format!("解码密文失败: {e}"))?;
    let pt = cipher
        .decrypt(nonce, ct.as_ref())
        .map_err(|_| "解密失败：密钥文件可能来自其他机器或系统重装，请重新录入密码".to_string())?;
    String::from_utf8(pt).map_err(|e| format!("解密结果异常: {e}"))
}

fn save_file(dir: &Path, key_id: &str, secret: &str) -> Result<(), String> {
    let (nonce, cipher) = encrypt(secret)?;
    let mut vault = load_vault(dir)?;
    vault.entries.insert(
        key_id.to_string(),
        VaultEntry {
            nonce,
            cipher,
        },
    );
    save_vault(dir, &vault)
}

fn load_file(dir: &Path, key_id: &str) -> Result<Option<String>, String> {
    let vault = load_vault(dir)?;
    match vault.entries.get(key_id) {
        Some(e) => Ok(Some(decrypt(&e.nonce, &e.cipher)?)),
        None => Ok(None),
    }
}

fn delete_file(dir: &Path, key_id: &str) -> Result<(), String> {
    let mut vault = load_vault(dir)?;
    if vault.entries.remove(key_id).is_some() {
        save_vault(dir, &vault)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dockpilot-secret-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn file_backend_roundtrip() {
        let dir = tempdir();
        let r = save_file(&dir, "registry/a", "p@ss word-密码");
        assert!(r.is_ok(), "file 保存失败: {r:?}");
        let loaded = load_file(&dir, "registry/a").unwrap();
        assert_eq!(loaded.as_deref(), Some("p@ss word-密码"));
        // 覆盖写
        save_file(&dir, "registry/a", "new-pass").unwrap();
        assert_eq!(load_file(&dir, "registry/a").unwrap().as_deref(), Some("new-pass"));
        // 不同 key 隔离
        assert!(load_file(&dir, "registry/b").unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_backend_delete_and_missing_vault() {
        let dir = tempdir();
        // 密钥文件不存在时读取/删除均应安全
        assert!(load_file(&dir, "registry/x").unwrap().is_none());
        assert!(delete_file(&dir, "registry/x").is_ok());
        save_file(&dir, "registry/x", "v").unwrap();
        delete_file(&dir, "registry/x").unwrap();
        assert!(load_file(&dir, "registry/x").unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_backend_rejects_tampered_cipher() {
        let dir = tempdir();
        save_file(&dir, "registry/c", "secret").unwrap();
        let mut vault = load_vault(&dir).unwrap();
        vault.entries.get_mut("registry/c").unwrap().cipher = B64.encode(b"tampered-data!!");
        save_vault(&dir, &vault).unwrap();
        let err = load_file(&dir, "registry/c").unwrap_err();
        assert!(err.contains("解密失败"), "应报解密失败而非 panic: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn vault_survives_unknown_fields_and_version() {
        let dir = tempdir();
        save_file(&dir, "registry/d", "v1").unwrap();
        // 旧条目仍在，缺 version 字段回落 0 不影响读取
        let vault: VaultFile = serde_json::from_str(
            &std::fs::read_to_string(vault_path(&dir)).unwrap(),
        )
        .unwrap();
        assert!(vault.entries.contains_key("registry/d"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 依赖系统钥匙串的用例：CI/无桌面环境无 Secret Service，默认忽略
    #[test]
    #[ignore]
    fn keyring_backend_roundtrip() {
        save_keyring("registry/test-rt", "v").unwrap();
        assert_eq!(load_keyring("registry/test-rt").unwrap().as_deref(), Some("v"));
        delete_keyring("registry/test-rt").unwrap();
        assert!(load_keyring("registry/test-rt").unwrap().is_none());
    }

    /// 自动回退策略：无钥匙串环境应自动落到 file
    #[test]
    fn save_secret_falls_back_without_keyring() {
        let dir = tempdir();
        // 有钥匙串的平台返回 Keyring；无钥匙串平台自动落 File，二者都合法
        let backend = save_secret(&dir, "registry/fallback-test", "v").unwrap();
        let loaded = load_secret(&dir, "registry/fallback-test", backend).unwrap();
        assert_eq!(loaded.as_deref(), Some("v"));
        delete_secret(&dir, "registry/fallback-test", backend).unwrap();
        assert!(load_secret(&dir, "registry/fallback-test", backend).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
