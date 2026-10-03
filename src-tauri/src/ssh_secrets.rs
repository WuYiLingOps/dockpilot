//! SSH 凭证密钥管理：登录密码、私钥口令与钥匙串私钥存 secret_store（系统钥匙串，
//! 回退机器绑定加密文件），实际落点提示记录在 ConnectionProfile.secret_backend。
//!
//! key_id 约定：`ssh/{profile_id}` = 登录密码（auth=password）；
//! `sshkey/{profile_id}` = 路径型私钥的口令；钥匙串条目（settings.ssh_keys，
//! id 为条目 id）：`sshkeypem/{key_id}` = 私钥 PEM 全文、`sshkeypass/{key_id}` = 其口令。
//! 同一连接的密码/口令/私钥分属不同 key_id，共用 secret_backend 提示字段，
//! 读取/删除走 load_secret_any / delete_secret_any 双后端兜底。
//!
//! 跨设备同步：凭证经 export/import 命令进出同步载荷（信封内为明文，受同步密码
//! 保护，见 lib/sync/encryption.ts）；本机静态安全由 secret_store 的机器绑定加密
//! 承担——与 Netcatty 的双层加密域同构。钥匙串条目元数据（ssh_keys）随同步载荷
//! 的 ssh_keys 数组走，材料经本命令组写入对端本机 secret_store。
//!
//! 与 registries.rs 的差异：连接档案由前端经 set_settings 整包维护，
//! 没有「单条删除」命令，因此已删除连接的孤儿密钥在 set_settings 中 diff 清理。

use crate::docker::conn::CmdResult;
use crate::secret_store::{self, SecretBackend};
use crate::settings::{self, AppSettings, SshIdentity, SshKeyEntry};
use russh::keys::{decode_secret_key, HashAlg};
use serde::{Deserialize, Serialize};

/// 登录密码的密钥条目 id
pub fn password_key(profile_id: &str) -> String {
    format!("ssh/{profile_id}")
}

/// 私钥口令的密钥条目 id
pub fn passphrase_key(profile_id: &str) -> String {
    format!("sshkey/{profile_id}")
}

/// 导入式私钥（PEM 全文）的密钥条目 id（参数为钥匙串条目 id）
pub fn key_pem_key(key_id: &str) -> String {
    format!("sshkeypem/{key_id}")
}

/// 钥匙串私钥口令的密钥条目 id（口令随钥匙串条目而非连接）
pub fn keychain_passphrase_key(key_id: &str) -> String {
    format!("sshkeypass/{key_id}")
}

/// SSH 身份密码的密钥条目 id
pub fn identity_password_key(identity_id: &str) -> String {
    format!("sshidpass/{identity_id}")
}

/// 同步凭证类型 → 密钥条目 id；非法类型报错。
/// target_id 语义随 kind 不同：password/key_passphrase 指连接 id，
/// keychain_pem/keychain_passphrase 指钥匙串条目 id。
fn sync_secret_key_for(target_id: &str, kind: &str) -> Result<String, String> {
    match kind {
        "password" => Ok(password_key(target_id)),
        "key_passphrase" => Ok(passphrase_key(target_id)),
        "keychain_pem" => Ok(key_pem_key(target_id)),
        "keychain_passphrase" => Ok(keychain_passphrase_key(target_id)),
        "identity_password" => Ok(identity_password_key(target_id)),
        other => Err(format!("未知的 ssh 凭证类型: {other}")),
    }
}

/// 连接引用身份的解析结果（供 ssh_client 建立连接）
#[derive(Debug, Clone)]
pub struct ResolvedSshIdentity {
    pub username: String,
    /// 身份密码（None = 身份关联了钥匙串私钥）
    pub password: Option<String>,
    /// 身份关联的钥匙串私钥条目 id（空 = 密码认证）
    pub key_id: String,
}

/// 云同步载荷中的凭证条目（明文；整体载荷由同步密码信封加密）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshSecretSyncEntry {
    /// 连接 id（password / key_passphrase）或钥匙串条目 id（keychain_*）
    pub target_id: String,
    /// "password" | "key_passphrase" | "keychain_pem" | "keychain_passphrase"
    pub kind: String,
    pub value: String,
}

/// 同步导出的可测核心：目录参数化，只收集非空条目。
/// 连接侧导出登录密码与路径型口令；钥匙串侧导出全部条目的 PEM 与口令。
fn export_in(dir: &std::path::Path, s: &AppSettings) -> Vec<SshSecretSyncEntry> {
    let mut out = Vec::new();
    for profile in s.connections.iter().filter(|c| c.kind == "ssh") {
        let prefer = backend_hint(&profile.secret_backend);
        for kind in ["password", "key_passphrase"] {
            let key = match sync_secret_key_for(&profile.id, kind) {
                Ok(key) => key,
                Err(_) => continue,
            };
            if let Ok(Some(value)) = secret_store::load_secret_any(dir, &key, prefer) {
                if !value.is_empty() {
                    out.push(SshSecretSyncEntry {
                        target_id: profile.id.clone(),
                        kind: kind.into(),
                        value,
                    });
                }
            }
        }
    }
    for entry in &s.ssh_keys {
        let prefer = SecretBackend::Keyring;
        for kind in ["keychain_pem", "keychain_passphrase"] {
            let key = match sync_secret_key_for(&entry.id, kind) {
                Ok(key) => key,
                Err(_) => continue,
            };
            if let Ok(Some(value)) = secret_store::load_secret_any(dir, &key, prefer) {
                if !value.is_empty() {
                    out.push(SshSecretSyncEntry {
                        target_id: entry.id.clone(),
                        kind: kind.into(),
                        value,
                    });
                }
            }
        }
    }
    for identity in &s.ssh_identities {
        let key = identity_password_key(&identity.id);
        // 身份密码始终经 secret_store 存储；提示固定走钥匙串，缺失软兜底加密文件
        if let Ok(Some(value)) = secret_store::load_secret_any(dir, &key, SecretBackend::Keyring) {
            if !value.is_empty() {
                out.push(SshSecretSyncEntry {
                    target_id: identity.id.clone(),
                    kind: "identity_password".into(),
                    value,
                });
            }
        }
    }
    out
}

/// 单条同步导入的目标解析（纯逻辑便于单测）：校验 kind 并定位写入目标——
/// password/key_passphrase 返回连接的可变引用，keychain_* 返回 Err 由调用方
/// 跳过（钥匙串元数据应已随载荷落地；缺失说明载荷不完整）。
fn sync_import_target<'a>(
    s: &'a mut AppSettings,
    entry: &SshSecretSyncEntry,
) -> Result<(&'a mut settings::ConnectionProfile, String), String> {
    let key = sync_secret_key_for(&entry.target_id, &entry.kind)?;
    let profile = s
        .connections
        .iter_mut()
        .find(|c| c.id == entry.target_id && c.kind == "ssh")
        .ok_or_else(|| format!("同步凭证对应的 SSH 连接不存在: {}", entry.target_id))?;
    Ok((profile, key))
}

/// 同步导入的可测核心：逐条 upsert 到本机 secret_store；目标不存在时跳过并告警
/// （同步先写 settings 再导入，正常不会发生）；不清除未提及条目。
/// 注意：save_secret 会优先写真实系统钥匙串，测试不得直接调用本函数。
fn import_in(
    dir: &std::path::Path,
    s: &mut AppSettings,
    entries: &[SshSecretSyncEntry],
) -> CmdResult<()> {
    for entry in entries {
        match entry.kind.as_str() {
            // 连接侧：登录密码 / 路径型口令，需要连接存在
            "password" | "key_passphrase" => match sync_import_target(s, entry) {
                Ok((profile, key)) => {
                    let backend = secret_store::save_secret(dir, &key, &entry.value)?;
                    profile.secret_backend = backend.as_str().to_string();
                    log::info!(
                        "已导入 SSH 凭证 {} 的{}（{}）",
                        entry.target_id,
                        entry.kind,
                        backend.as_str()
                    );
                }
                Err(e) => log::warn!("{e}，跳过"),
            },
            // 钥匙串侧：条目元数据应已随载荷的 ssh_keys 落地；缺失（载荷不完整）
            // 时跳过并保留既有内容
            "keychain_pem" | "keychain_passphrase" => {
                if !s.ssh_keys.iter().any(|k| k.id == entry.target_id) {
                    log::warn!(
                        "钥匙串条目 {} 不在本机元数据中，跳过该凭证",
                        entry.target_id
                    );
                    continue;
                }
                let key = sync_secret_key_for(&entry.target_id, &entry.kind)?;
                let backend = secret_store::save_secret(dir, &key, &entry.value)?;
                log::info!(
                    "已导入钥匙串凭证 {} 的{}（{}）",
                    entry.target_id,
                    entry.kind,
                    backend.as_str()
                );
            }
            // 身份侧：密码写入 sshidpass/{id}（身份元数据应已随载荷的 ssh_identities 落地）
            "identity_password" => {
                if !s.ssh_identities.iter().any(|i| i.id == entry.target_id) {
                    log::warn!("身份 {} 不在本机元数据中，跳过该凭证", entry.target_id);
                    continue;
                }
                let key = sync_secret_key_for(&entry.target_id, &entry.kind)?;
                let backend = secret_store::save_secret(dir, &key, &entry.value)?;
                log::info!(
                    "已导入身份 {} 的密码（{}）",
                    entry.target_id,
                    backend.as_str()
                );
            }
            other => log::warn!("未知的 ssh 凭证类型: {other}，跳过"),
        }
    }
    Ok(())
}

/// 保存或清除连接侧 ssh 密钥（kind: "password" | "key_passphrase"）。
/// secret 为空 = 清除该类密钥（编辑时留空不改密钥的语义由前端保证，
/// 只有用户主动清空密码框并保存时才传空串）。
/// 钥匙串条目（PEM/口令）不走此命令，见 save_ssh_key_entry。
#[tauri::command]
pub async fn set_ssh_secret(
    app: tauri::AppHandle,
    profile_id: String,
    kind: String,
    secret: String,
) -> CmdResult<()> {
    if !matches!(kind.as_str(), "password" | "key_passphrase") {
        return Err(format!(
            "未知的 ssh 密钥类型: {kind}（钥匙串条目请用 save_ssh_key_entry）"
        ));
    }
    let key = sync_secret_key_for(&profile_id, &kind)?;

    let mut s = settings::load(&app);
    let profile = settings::find_connection(&s, &profile_id)
        .ok_or_else(|| format!("连接配置不存在: {profile_id}"))?
        .clone();
    if profile.kind != "ssh" {
        return Err("仅 SSH 连接支持保存密码 / 私钥口令".into());
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

/// 云同步导出凭证：连接侧（登录密码 / 路径型口令）与钥匙串侧（PEM / 口令）
/// 的非空条目，供前端组装同步载荷。载荷整体由同步密码信封加密后上传，
/// 本命令只在本机 secret_store 与前端之间搬运。
#[tauri::command]
pub async fn export_ssh_secrets(app: tauri::AppHandle) -> CmdResult<Vec<SshSecretSyncEntry>> {
    let dir = secret_store::config_dir(&app)?;
    let s = settings::load(&app);
    Ok(export_in(&dir, &s))
}

/// 云同步导入凭证：把同步载荷里的凭证条目写入本机 secret_store（upsert，
/// 不清除未提及条目）。应在 set_settings（连接档案已落地）之后调用。
#[tauri::command]
pub async fn import_ssh_secrets(
    app: tauri::AppHandle,
    entries: Vec<SshSecretSyncEntry>,
) -> CmdResult<()> {
    let dir = secret_store::config_dir(&app)?;
    let mut s = settings::load(&app);
    import_in(&dir, &mut s, &entries)?;
    settings::save(&app, &s)
}

/// 读取私钥文件内容（钥匙串导入用）：拒绝 .pub 公钥、限制大小、校验 PEM 头。
/// 内容经 save_ssh_key_entry 入钥匙串 secret_store，不落明文文件。
#[tauri::command]
pub async fn read_private_key_file(path: String) -> CmdResult<String> {
    let p = std::path::PathBuf::from(path.trim());
    if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pub")) {
        return Err(
            "指向了 .pub 公钥文件，请选择对应的私钥（例如 id_rsa，而不是 id_rsa.pub）".into(),
        );
    }
    let meta = tokio::fs::metadata(&p)
        .await
        .map_err(|e| format!("读取私钥文件失败: {e}"))?;
    if !meta.is_file() {
        return Err("所选路径不是文件".into());
    }
    if meta.len() > 256 * 1024 {
        return Err("私钥文件过大（>256KB），请确认选择的是正确的私钥文件".into());
    }
    let content = tokio::fs::read_to_string(&p)
        .await
        .map_err(|e| format!("读取私钥文件失败（含非文本内容?）: {e}"))?;
    if !content.contains("-----BEGIN") {
        return Err("文件不像私钥（缺少 PEM 头），请确认选择的是私钥文件".into());
    }
    Ok(content)
}

/// 读取已保存的连接侧 ssh 密钥（不存在返回 None）
pub fn load(
    dir: &std::path::Path,
    profile: &settings::ConnectionProfile,
    kind: &str,
) -> Option<String> {
    let key = sync_secret_key_for(&profile.id, kind).ok()?;
    let prefer = backend_hint(&profile.secret_backend);
    secret_store::load_secret_any(dir, &key, prefer)
        .ok()
        .flatten()
}

/// 读取钥匙串条目的私钥/口令（不存在返回 None；后端提示取自引用连接）
pub fn load_keychain(
    dir: &std::path::Path,
    profile: &settings::ConnectionProfile,
    key_id: &str,
    kind: &str,
) -> Option<String> {
    let key = match kind {
        "pem" => key_pem_key(key_id),
        "passphrase" => keychain_passphrase_key(key_id),
        _ => return None,
    };
    let prefer = backend_hint(&profile.secret_backend);
    secret_store::load_secret_any(dir, &key, prefer)
        .ok()
        .flatten()
}

/// 由 PEM 推导公钥材料：(公钥指纹 OpenSSH `SHA256:xxx`, 公钥全文)；解码失败返回 None
fn key_material_of_pem(pem: &str, passphrase: Option<&str>) -> Option<(String, String)> {
    match decode_secret_key(pem, passphrase) {
        Ok(key) => {
            let public = key.public_key();
            let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();
            let public_key = public
                .to_openssh()
                .map(|s| s.trim_end().to_string())
                .unwrap_or_default();
            Some((fingerprint, public_key))
        }
        Err(_) => None,
    }
}

/// 钥匙串条目 upsert（纯逻辑便于单测）：新建直接 push；更新保留原创建时间，
/// 未重新计算指纹（空）时保留原指纹（指纹源自公钥，改名/换口令不影响）
fn upsert_key_entry(s: &mut AppSettings, entry: SshKeyEntry) {
    match s.ssh_keys.iter_mut().find(|k| k.id == entry.id) {
        Some(existing) => {
            let created = existing.created_at;
            let fingerprint = if entry.fingerprint.is_empty() {
                existing.fingerprint.clone()
            } else {
                entry.fingerprint
            };
            *existing = SshKeyEntry {
                fingerprint,
                created_at: created,
                ..entry
            };
        }
        None => s.ssh_keys.push(entry),
    }
}

/// 保存钥匙串条目（导入新私钥 / 更新 PEM / 重命名）：写入 sshkeypem 与
/// sshkeypass 双密钥、decode_secret_key 校验私钥有效性并计算公钥指纹、
/// upsert settings.ssh_keys 元数据。id 传 None 时新建（后端生成 uuid）。
#[tauri::command]
pub async fn save_ssh_key_entry(
    app: tauri::AppHandle,
    id: Option<String>,
    label: String,
    pem: Option<String>,
    passphrase: Option<String>,
) -> CmdResult<SshKeyEntry> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("请填写私钥名称".into());
    }
    let dir = secret_store::config_dir(&app)?;
    let mut s = settings::load(&app);

    let key_id = match id.as_deref().filter(|v| !v.is_empty()) {
        Some(existing) => {
            if !s.ssh_keys.iter().any(|k| k.id == existing) {
                return Err(format!("钥匙串条目不存在: {existing}"));
            }
            existing.to_string()
        }
        None => uuid::Uuid::new_v4().to_string(),
    };

    let mut fingerprint = String::new();
    let mut public_key = String::new();
    if let Some(pem) = pem.as_deref().filter(|p| !p.trim().is_empty()) {
        let pem = pem.trim().to_string();
        let (fp, pk) = key_material_of_pem(&pem, passphrase.as_deref())
            .ok_or_else(|| "私钥解析失败：内容不是有效的私钥，或口令不正确".to_string())?;
        fingerprint = fp;
        public_key = pk;
        secret_store::save_secret(&dir, &key_pem_key(&key_id), &pem)?;
    } else if id.as_deref().filter(|v| !v.is_empty()).is_none() {
        return Err("请选择要导入的私钥文件".into());
    }
    if let Some(pass) = passphrase.as_deref() {
        if pass.is_empty() {
            let prefer = SecretBackend::Keyring;
            let _ =
                secret_store::delete_secret_any(&dir, &keychain_passphrase_key(&key_id), prefer);
        } else {
            secret_store::save_secret(&dir, &keychain_passphrase_key(&key_id), pass)?;
        }
    }

    let created_at = settings::now_secs();
    let entry = SshKeyEntry {
        id: key_id,
        label,
        fingerprint,
        public_key,
        created_at,
    };
    let returned = entry.clone();
    upsert_key_entry(&mut s, entry);
    settings::save(&app, &s)?;
    log::info!("已保存钥匙串私钥「{}」（{}）", returned.label, returned.id);
    Ok(returned)
}

/// 删除钥匙串条目：被任何 SSH 连接引用时拒绝（附引用数量）；删除双密钥与元数据
#[tauri::command]
pub async fn delete_ssh_key_entry(app: tauri::AppHandle, id: String) -> CmdResult<()> {
    let dir = secret_store::config_dir(&app)?;
    let mut s = settings::load(&app);

    let refs = s
        .connections
        .iter()
        .filter(|c| c.kind == "ssh" && c.key_id == id)
        .count();
    if refs > 0 {
        return Err(format!(
            "该私钥正被 {refs} 个连接引用，请先在连接设置中改用其他私钥来源"
        ));
    }

    let prefer = SecretBackend::Keyring;
    for key in [key_pem_key(&id), keychain_passphrase_key(&id)] {
        let _ = secret_store::delete_secret_any(&dir, &key, prefer);
    }
    s.ssh_keys.retain(|k| k.id != id);
    settings::save(&app, &s)?;
    log::info!("已删除钥匙串私钥 {id}");
    Ok(())
}

/// 保存 SSH 身份（新建 / 重命名 / 改用户名 / 改密码 / 关联私钥）：
/// password Some 写入、Some("") 删除、None 保持不变；key_id 校验指向存在的
/// 钥匙串条目；upsert ssh_identities 元数据。id 传 None 时新建。
#[tauri::command]
pub async fn save_ssh_identity(
    app: tauri::AppHandle,
    id: Option<String>,
    label: String,
    username: String,
    password: Option<String>,
    key_id: Option<String>,
) -> CmdResult<SshIdentity> {
    let label = label.trim().to_string();
    let username = username.trim().to_string();
    if label.is_empty() {
        return Err("请填写身份名称".into());
    }
    if username.is_empty() {
        return Err("请填写用户名".into());
    }
    let dir = secret_store::config_dir(&app)?;
    let mut s = settings::load(&app);

    let iid = match id.as_deref().filter(|v| !v.is_empty()) {
        Some(existing) => {
            if !s.ssh_identities.iter().any(|i| i.id == existing) {
                return Err(format!("身份不存在: {existing}"));
            }
            existing.to_string()
        }
        None => uuid::Uuid::new_v4().to_string(),
    };
    // 关联私钥校验（None = 不变；空串 = 解除关联）
    let key_id = match key_id.as_deref() {
        Some("") => String::new(),
        Some(kid) => {
            if !s.ssh_keys.iter().any(|k| k.id == kid) {
                return Err(format!("关联的钥匙串私钥不存在: {kid}"));
            }
            kid.to_string()
        }
        None => s
            .ssh_identities
            .iter()
            .find(|i| i.id == iid)
            .map(|i| i.key_id.clone())
            .unwrap_or_default(),
    };
    if key_id.is_empty() {
        // 无关联私钥的身份必须配置密码（新建时）；编辑时密码 None = 保持既有
        let has_password = secret_store::load_secret_any(
            &dir,
            &identity_password_key(&iid),
            SecretBackend::Keyring,
        )
        .ok()
        .flatten()
        .is_some();
        if !has_password && password.as_deref().filter(|p| !p.is_empty()).is_none() {
            return Err("请填写密码，或关联一把钥匙串私钥".into());
        }
    }

    if let Some(pass) = password.as_deref() {
        if pass.is_empty() {
            let _ = secret_store::delete_secret_any(
                &dir,
                &identity_password_key(&iid),
                SecretBackend::Keyring,
            );
        } else {
            secret_store::save_secret(&dir, &identity_password_key(&iid), pass)?;
        }
    }

    let entry = SshIdentity {
        id: iid,
        label,
        username,
        key_id,
        created_at: settings::now_secs(),
    };
    match s.ssh_identities.iter_mut().find(|i| i.id == entry.id) {
        // 更新：保留原创建时间
        Some(existing) => {
            let created = existing.created_at;
            *existing = SshIdentity {
                created_at: created,
                ..entry.clone()
            };
        }
        None => s.ssh_identities.push(entry.clone()),
    }
    settings::save(&app, &s)?;
    log::info!("已保存 SSH 身份「{}」（{}）", entry.label, entry.id);
    Ok(entry)
}

/// 删除 SSH 身份：被任何连接引用时拒绝；删除其密码
#[tauri::command]
pub async fn delete_ssh_identity(app: tauri::AppHandle, id: String) -> CmdResult<()> {
    let dir = secret_store::config_dir(&app)?;
    let mut s = settings::load(&app);

    let refs = s
        .connections
        .iter()
        .filter(|c| c.kind == "ssh" && c.identity_id == id)
        .count();
    if refs > 0 {
        return Err(format!(
            "该身份正被 {refs} 个连接引用，请先在连接设置中解除"
        ));
    }

    let _ =
        secret_store::delete_secret_any(&dir, &identity_password_key(&id), SecretBackend::Keyring);
    s.ssh_identities.retain(|i| i.id != id);
    settings::save(&app, &s)?;
    log::info!("已删除 SSH 身份 {id}");
    Ok(())
}

/// 连接引用的身份解析（供 ssh_client，无 AppHandle 场景）：
/// 返回 (username, password)；密码可能为 None（身份关联了钥匙串私钥）
pub fn load_identity_for_connect(
    dir: &std::path::Path,
    profile: &settings::ConnectionProfile,
) -> Option<ResolvedSshIdentity> {
    if profile.identity_id.is_empty() {
        return None;
    }
    let s = settings::load_from_dir(dir);
    let identity = s
        .ssh_identities
        .iter()
        .find(|i| i.id == profile.identity_id)?;
    let prefer = backend_hint(&profile.secret_backend);
    let password = secret_store::load_secret_any(dir, &identity_password_key(&identity.id), prefer)
        .ok()
        .flatten();
    Some(ResolvedSshIdentity {
        username: identity.username.clone(),
        password,
        key_id: identity.key_id.clone(),
    })
}

/// 老配置迁移（幂等，启动时执行一次）：把"每连接内嵌导入"的旧形态升级为钥匙串
/// 引用——以 secret_store 中存在 sshkeypem/{profile_id} 为判定依据（旧字段
/// key_embedded 已随模型升级移除），复制 PEM 与口令到钥匙串 key_id、生成条目
/// 元数据并重写连接引用。返回迁移的连接数。
pub fn migrate_embedded_to_keychain(app: &tauri::AppHandle) -> usize {
    let Ok(dir) = secret_store::config_dir(app) else {
        return 0;
    };
    let mut s = settings::load(app);
    let migrated = migrate_in(&dir, &mut s);
    if migrated > 0 {
        if let Err(e) = settings::save(app, &s) {
            log::warn!("钥匙串迁移结果保存失败: {e}");
            return 0;
        }
        log::info!("钥匙串迁移完成：{migrated} 个连接");
    }
    migrated
}

/// 单条迁移计划（规划层产物；pem/passphrase 已从旧 key 读出）
struct MigrationPlan {
    profile_id: String,
    label: String,
    pem: String,
    passphrase: Option<String>,
    fingerprint: String,
    public_key: String,
}

/// 迁移规划（纯读，可测）：找出"无钥匙串引用但 secret_store 存在按连接 id 存放的
/// PEM"的连接，读取 PEM 与旧口令。旧形态判定依据即 sshkeypem/{profile_id} 的存在。
fn plan_migrations(dir: &std::path::Path, s: &AppSettings) -> Vec<MigrationPlan> {
    let mut plans = Vec::new();
    for c in s
        .connections
        .iter()
        .filter(|c| c.kind == "ssh" && c.key_id.is_empty())
    {
        let prefer = backend_hint(&c.secret_backend);
        let Some(pem) = secret_store::load_secret_any(dir, &key_pem_key(&c.id), prefer)
            .ok()
            .flatten()
            .filter(|p| !p.is_empty())
        else {
            continue;
        };
        // 口令随钥匙串条目走（旧 sshkey/{pid} 为路径型口令，原样保留不迁移）
        let passphrase = secret_store::load_secret_any(dir, &passphrase_key(&c.id), prefer)
            .ok()
            .flatten()
            .filter(|p| !p.is_empty());
        let (fingerprint, public_key) = key_material_of_pem(&pem, None).unwrap_or_default();
        plans.push(MigrationPlan {
            profile_id: c.id.clone(),
            label: format!("{} 的私钥", c.name),
            pem,
            passphrase,
            fingerprint,
            public_key,
        });
    }
    plans
}

/// 迁移执行（写入 secret_store 与 settings；save_secret 优先钥匙串，测试不得直接调用）
fn migrate_in(dir: &std::path::Path, s: &mut AppSettings) -> usize {
    let plans = plan_migrations(dir, s);
    let mut migrated = 0usize;
    for plan in plans {
        let kid = uuid::Uuid::new_v4().to_string();
        if let Some(pass) = plan.passphrase.as_deref() {
            let _ = secret_store::save_secret(dir, &keychain_passphrase_key(&kid), pass);
        }
        let _ = secret_store::save_secret(dir, &key_pem_key(&kid), &plan.pem);
        // 迁移为复制语义：旧 sshkeypem/{pid} 残留由 cleanup_removed 在连接删除时清理
        if let Some(c) = s.connections.iter_mut().find(|c| c.id == plan.profile_id) {
            c.key_id = kid.clone();
        }
        s.ssh_keys.push(SshKeyEntry {
            id: kid,
            label: plan.label.clone(),
            fingerprint: plan.fingerprint.clone(),
            public_key: plan.public_key.clone(),
            created_at: settings::now_secs(),
        });
        migrated += 1;
        log::info!("已迁移连接 {} 的导入式私钥到钥匙串", plan.profile_id);
    }
    migrated
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
        for key in [
            password_key(&c.id),
            passphrase_key(&c.id),
            key_pem_key(&c.id),
        ] {
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
        assert_eq!(keychain_passphrase_key("abc"), "sshkeypass/abc");
        // 钥匙串 PEM 与旧内嵌形态共用 sshkeypem/ 前缀,参数语义由 id 区分
        assert_eq!(key_pem_key("kid"), "sshkeypem/kid");
        assert!(sync_secret_key_for("abc", "other").is_err());
        assert!(sync_secret_key_for("abc", "key_pem").is_err());
    }

    #[test]
    fn export_collects_nonempty_entries_via_file_backend() {
        let dir = tempdir();
        let mut s = AppSettings {
            connections: vec![ssh_profile("a"), ssh_profile("b")],
            ..Default::default()
        };
        s.ssh_keys.push(SshKeyEntry {
            id: "k1".into(),
            label: "腾讯云".into(),
            fingerprint: String::new(),
            public_key: String::new(),
            created_at: 1,
        });
        // file 后端可直接落盘测试（keyring 写入会污染真实钥匙串，不走 save_secret）
        secret_store::save_file(&dir, &password_key("a"), "pw-a").unwrap();
        secret_store::save_file(&dir, &passphrase_key("a"), "phrase").unwrap();
        secret_store::save_file(
            &dir,
            &key_pem_key("k1"),
            "-----BEGIN OPENSSH PRIVATE KEY-----",
        )
        .unwrap();

        // 连接侧导出 password / key_passphrase；钥匙串侧导出 PEM / 口令；连接 b 无任何条目
        let entries = export_in(&dir, &s);
        assert_eq!(entries.len(), 3, "got: {entries:?}");
        assert!(entries
            .iter()
            .any(|e| e.target_id == "a" && e.kind == "password" && e.value == "pw-a"));
        assert!(entries
            .iter()
            .any(|e| e.target_id == "a" && e.kind == "key_passphrase" && e.value == "phrase"));
        assert!(entries.iter().any(|e| e.target_id == "k1"
            && e.kind == "keychain_pem"
            && e.value.contains("-----BEGIN")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn import_in_skips_keychain_entry_without_metadata() {
        // 钥匙串元数据未随载荷落地（载荷不完整）时:跳过且不写任何后端
        let dir = tempdir();
        let mut s = AppSettings {
            connections: vec![ssh_profile("a")],
            ..Default::default()
        };
        import_in(
            &dir,
            &mut s,
            &[SshSecretSyncEntry {
                target_id: "kid".into(),
                kind: "keychain_pem".into(),
                value: "-----BEGIN".into(),
            }],
        )
        .unwrap();
        assert!(secret_store::load_file(&dir, &key_pem_key("kid"))
            .unwrap()
            .is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sync_import_target_maps_profile_and_key() {
        let mut s = AppSettings {
            connections: vec![ssh_profile("a")],
            ..Default::default()
        };
        // 连接侧密码:profile_id + password 路由到 ssh/{id}
        let (profile, key) = sync_import_target(
            &mut s,
            &SshSecretSyncEntry {
                target_id: "a".into(),
                kind: "password".into(),
                value: "pw".into(),
            },
        )
        .unwrap();
        assert_eq!(profile.id, "a");
        assert_eq!(key, "ssh/a");
        // 连接不存在 → 报错（import_in 捕获后跳过）
        assert!(sync_import_target(
            &mut s,
            &SshSecretSyncEntry {
                target_id: "missing".into(),
                kind: "password".into(),
                value: "x".into(),
            }
        )
        .is_err());
        // 未知类型 → 报错
        assert!(sync_import_target(
            &mut s,
            &SshSecretSyncEntry {
                target_id: "a".into(),
                kind: "key_pem".into(),
                value: "x".into(),
            }
        )
        .is_err());
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
    #[test]
    fn plan_migrations_reads_embedded_pem_and_passphrase() {
        let dir = tempdir();
        let mut s = AppSettings {
            connections: vec![ssh_profile("a"), ssh_profile("b")],
            ..Default::default()
        };
        s.connections[0].name = "腾讯云".into();
        // file 后端可直接落盘测试（keyring 写入会污染真实钥匙串，不走 save_secret）
        secret_store::save_file(
            &dir,
            &key_pem_key("a"),
            "-----BEGIN OPENSSH PRIVATE KEY-----",
        )
        .unwrap();
        secret_store::save_file(&dir, &passphrase_key("a"), "phrase").unwrap();

        // 规划层：读出 PEM 与口令；连接 b 无旧内嵌 → 不在计划内
        let plans = plan_migrations(&dir, &s);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].profile_id, "a");
        assert_eq!(plans[0].label, "腾讯云 的私钥");
        assert!(plans[0].pem.contains("-----BEGIN"));
        assert_eq!(plans[0].passphrase.as_deref(), Some("phrase"));

        // 已迁移（key_id 非空）后规划为空 → migrate_in 幂等的依据
        s.connections[0].key_id = "k1".into();
        assert!(plan_migrations(&dir, &s).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[test]
fn upsert_key_entry_preserves_created_at_and_fingerprint_on_rename() {
    let mut s = AppSettings {
        ssh_keys: vec![SshKeyEntry {
            id: "k".into(),
            label: "旧名".into(),
            fingerprint: "SHA256:old".into(),
            public_key: String::new(),
            created_at: 42,
        }],
        ..Default::default()
    };
    // 重命名（无新指纹）：label 更新，指纹与创建时间保留
    upsert_key_entry(
        &mut s,
        SshKeyEntry {
            id: "k".into(),
            label: "新名".into(),
            fingerprint: String::new(),
            public_key: String::new(),
            created_at: 99,
        },
    );
    assert_eq!(s.ssh_keys[0].label, "新名");
    assert_eq!(s.ssh_keys[0].fingerprint, "SHA256:old");
    assert_eq!(s.ssh_keys[0].created_at, 42);

    // 重新导入（带新指纹）：指纹更新，创建时间仍保留
    upsert_key_entry(
        &mut s,
        SshKeyEntry {
            id: "k".into(),
            label: "新名".into(),
            fingerprint: "SHA256:new".into(),
            public_key: String::new(),
            created_at: 99,
        },
    );
    assert_eq!(s.ssh_keys[0].fingerprint, "SHA256:new");
    assert_eq!(s.ssh_keys[0].created_at, 42);

    // 新条目 push
    upsert_key_entry(
        &mut s,
        SshKeyEntry {
            id: "k2".into(),
            label: "第二把".into(),
            fingerprint: "SHA256:k2".into(),
            public_key: String::new(),
            created_at: 7,
        },
    );
    assert_eq!(s.ssh_keys.len(), 2);
}
