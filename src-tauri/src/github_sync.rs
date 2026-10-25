//! GitHub 云同步的 Rust 桥：Device Flow 认证 + Gist raw 内容兜底下载 + token 钥匙串存取。
//!
//! 为什么需要 Rust：`github.com/login/*` 与 `gist.githubusercontent.com` 在 WebView
//! 内 fetch 存在 CORS 限制，必须经主进程 reqwest 代理；api.github.com 自带 CORS，
//! Gist CRUD 由前端直接 fetch。
//!
//! GitHub OAuth token 永不落明文文件——复用 secret_store 的钥匙串/加密文件设施，
//! key_id = "sync/github_token"，实际落点由前端同步配置记录。

use std::sync::OnceLock;

use serde::Serialize;
use tauri::Manager;

use crate::secret_store::{self, SecretBackend};

const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
/// token 在 secret_store 中的 key_id
const TOKEN_KEY_ID: &str = "sync/github_token";
const DEFAULT_SCOPE: &str = "gist read:user";

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("构建 HTTP 客户端失败")
    })
}

/// 请求失败的完整原因链（reqwest 的 Display 不含底层 source，
/// 如 DNS / 连接 / TLS 具体错误，拼出来才能定位网络问题）
fn err_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut src = e.source();
    while let Some(err) = src {
        s.push_str(&format!(": {err}"));
        src = err.source();
    }
    s
}

/// 带重试的请求发送：直连 github.com 的链路存在间歇性超时（尤其国内网络），
/// 网络类失败自动重试，间隔 1s / 2s 递增。最后一次仍失败时，超时类错误附上处理指引。
async fn send_with_retry(
    builder: reqwest::RequestBuilder,
    attempts: u32,
    what: &str,
) -> Result<reqwest::Response, String> {
    let mut last_err = String::new();
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(1000 * attempt as u64)).await;
        }
        let request = builder
            .try_clone()
            .ok_or_else(|| crate::i18n::tr("sync.reqCloneFailed", &[("what", what)]))?;
        match request.send().await {
            Ok(res) => return Ok(res),
            Err(e) => {
                last_err = err_chain(&e);
            }
        }
    }
    if last_err.contains("timed out") || last_err.contains("timeout") {
        return Err(crate::i18n::tr(
            "sync.reqTimeout",
            &[("what", what), ("attempts", &attempts.to_string())],
        ));
    }
    Err(crate::i18n::tr(
        "sync.reqFailed",
        &[("what", what), ("err", &last_err)],
    ))
}

// ---------------------------------------------------------------------------
// Device Flow（RFC 8628，仅需 client_id，无需 client secret）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// 过期时间（本地毫秒时间戳）
    pub expires_at: i64,
    /// 建议轮询间隔（秒）
    pub interval: u64,
}

/// 启动 Device Flow：请求 device code，用户到 verification_uri 输入 user_code
#[tauri::command]
pub async fn github_device_flow_start(
    client_id: String,
    scope: Option<String>,
) -> Result<DeviceFlowStart, String> {
    if client_id.trim().is_empty() {
        return Err(crate::i18n::t("err.noClientId").into());
    }
    log::info!("{}", crate::i18n::t("log.deviceFlowStart"));

    let res = send_with_retry(
        http_client()
            .post(GITHUB_DEVICE_CODE_URL)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(format!(
                "client_id={}&scope={}",
                urlencode(&client_id),
                urlencode(scope.as_deref().unwrap_or(DEFAULT_SCOPE))
            )),
        3,
        "sync.whatDeviceCodeReq",
    )
    .await?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| crate::i18n::tr("err.responseReadFailed", &[("err", &e.to_string())]))?;
    if !status.is_success() {
        return Err(crate::i18n::tr(
            "err.deviceFlowFailed",
            &[("status", &status.to_string()), ("text", &text)],
        ));
    }

    #[derive(serde::Deserialize)]
    struct Raw {
        device_code: String,
        user_code: String,
        verification_uri: String,
        expires_in: Option<u64>,
        interval: Option<u64>,
    }
    let raw: Raw = serde_json::from_str(&text).map_err(|_| {
        crate::i18n::tr(
            "err.deviceFlowBadJson",
            &[("status", ""), ("text", &text[..text.len().min(200)])],
        )
    })?;

    Ok(DeviceFlowStart {
        device_code: raw.device_code,
        user_code: raw.user_code,
        verification_uri: raw.verification_uri,
        expires_at: now_millis() + (raw.expires_in.unwrap_or(0) * 1000) as i64,
        interval: raw.interval.unwrap_or(5).max(5),
    })
}

/// 轮询令牌端点一次。GitHub 对 pending/slow_down 返回 HTTP 200 + error 字段，
/// 直接透传响应 JSON，由前端按 RFC 8628 处理 authorization_pending / slow_down /
/// expired_token / access_denied。
#[tauri::command]
pub async fn github_device_flow_poll(
    client_id: String,
    device_code: String,
) -> Result<serde_json::Value, String> {
    if client_id.trim().is_empty() || device_code.trim().is_empty() {
        return Err(crate::i18n::t("err.deviceFlowParamsMissing").into());
    }

    let res = send_with_retry(
        http_client()
            .post(GITHUB_ACCESS_TOKEN_URL)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(format!(
                "client_id={}&device_code={}&grant_type={}",
                urlencode(&client_id),
                urlencode(&device_code),
                urlencode("urn:ietf:params:oauth:grant-type:device_code"),
            )),
        2,
        "sync.whatTokenReq",
    )
    .await?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| crate::i18n::tr("err.responseReadFailed", &[("err", &e.to_string())]))?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        crate::i18n::tr(
            "err.tokenPollBadJson",
            &[
                ("status", &status.to_string()),
                ("text", &text[..text.len().min(200)]),
            ],
        )
    })?;

    // 携带 error 字段（pending/slow_down/expired/denied）或成功拿到 token 都原样返回
    if value.get("access_token").is_some() || value.get("error").is_some() {
        return Ok(value);
    }
    if !status.is_success() {
        return Err(crate::i18n::tr(
            "err.tokenPollFailed",
            &[("status", &status.to_string()), ("text", &text)],
        ));
    }
    Ok(value)
}

// ---------------------------------------------------------------------------
// Gist raw 内容兜底下载（Gist API 内嵌 content 约 1MB 截断时使用）
// ---------------------------------------------------------------------------

/// 校验 URL 必须指向 gist.githubusercontent.com（防把 token 发去任意主机）。
/// 带尾斜杠的前缀匹配：`https://gist.githubusercontent.com.evil.com/` 不通过。
fn normalize_gist_raw_url(raw_url: &str) -> Result<String, String> {
    const PREFIX: &str = "https://gist.githubusercontent.com/";
    if !raw_url.starts_with(PREFIX) {
        return Err(crate::i18n::t("err.gistRawUrlInvalid").into());
    }
    Ok(raw_url.to_string())
}

#[tauri::command]
pub async fn github_gist_raw_content(
    access_token: String,
    raw_url: String,
) -> Result<String, String> {
    let url = normalize_gist_raw_url(&raw_url)?;
    let res = send_with_retry(
        http_client()
            .get(url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("Accept", "application/vnd.github.raw"),
        3,
        "sync.whatGistDownload",
    )
    .await?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| crate::i18n::tr("err.responseReadFailed", &[("err", &e.to_string())]))?;
    if !status.is_success() {
        return Err(crate::i18n::tr(
            "err.gistDownloadFailed",
            &[
                ("status", &status.to_string()),
                ("text", &text[..text.len().min(200)]),
            ],
        ));
    }
    Ok(text)
}

// ---------------------------------------------------------------------------
// GitHub token 持久化（复用 secret_store，落点由前端记录）
// ---------------------------------------------------------------------------

fn token_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| crate::i18n::tr("err.config_dir_failed", &[("err", &e.to_string())]))
}

/// 保存 token：优先钥匙串，失败自动落加密文件，返回实际落点（"keyring" | "file"）
#[tauri::command]
pub fn sync_save_github_token(app: tauri::AppHandle, token: String) -> Result<String, String> {
    let dir = token_dir(&app)?;
    let backend = secret_store::save_secret(&dir, TOKEN_KEY_ID, &token)?;
    log::info!(
        "{}",
        crate::i18n::tr("log.tokenSaved", &[("backend", backend.as_str())])
    );
    Ok(backend.as_str().to_string())
}

/// 读取 token（按前端记录的落点）；不存在返回 None
#[tauri::command]
pub fn sync_load_github_token(
    app: tauri::AppHandle,
    backend: String,
) -> Result<Option<String>, String> {
    let dir = token_dir(&app)?;
    let parsed = SecretBackend::parse(&backend)
        .ok_or_else(|| crate::i18n::tr("err.unknownSecretBackend", &[("backend", &backend)]))?;
    secret_store::load_secret(&dir, TOKEN_KEY_ID, parsed)
}

/// 删除 token（断开连接时调用）；条目不存在视为成功
#[tauri::command]
pub fn sync_delete_github_token(app: tauri::AppHandle, backend: String) -> Result<(), String> {
    let dir = token_dir(&app)?;
    let parsed = SecretBackend::parse(&backend)
        .ok_or_else(|| crate::i18n::tr("err.unknownSecretBackend", &[("backend", &backend)]))?;
    secret_store::delete_secret(&dir, TOKEN_KEY_ID, parsed)?;
    log::info!("{}", crate::i18n::t("log.tokenDeleted"));
    Ok(())
}

// ---------------------------------------------------------------------------
// 同步密码持久化（记住密码：解锁后自动保存，锁定时清除；复用 token 同款设施）
// ---------------------------------------------------------------------------

/// 同步密码在 secret_store 中的 key_id
const SYNC_PASSWORD_KEY_ID: &str = "sync/sync_password";

/// 保存同步密码：优先钥匙串，失败自动落加密文件，返回实际落点（"keyring" | "file"）
#[tauri::command]
pub fn sync_save_sync_password(app: tauri::AppHandle, password: String) -> Result<String, String> {
    let dir = token_dir(&app)?;
    let backend =
        secret_store::save_secret(&dir, SYNC_PASSWORD_KEY_ID, &password).inspect_err(|e| {
            log::warn!(
                "{}",
                crate::i18n::tr("log.syncPasswordSaveFailed", &[("err", &e.to_string())])
            );
        })?;
    Ok(backend.as_str().to_string())
}

/// 读取记住的同步密码（按前端记录的落点）；不存在返回 None
#[tauri::command]
pub fn sync_load_sync_password(
    app: tauri::AppHandle,
    backend: String,
) -> Result<Option<String>, String> {
    let dir = token_dir(&app)?;
    let parsed = SecretBackend::parse(&backend)
        .ok_or_else(|| crate::i18n::tr("err.unknownSecretBackend", &[("backend", &backend)]))?;
    secret_store::load_secret(&dir, SYNC_PASSWORD_KEY_ID, parsed).inspect_err(|e| {
        log::warn!(
            "{}",
            crate::i18n::tr("log.syncPasswordReadFailed", &[("err", &e.to_string())])
        );
    })
}

/// 删除记住的同步密码（锁定时调用）；条目不存在视为成功
#[tauri::command]
pub fn sync_delete_sync_password(app: tauri::AppHandle, backend: String) -> Result<(), String> {
    let dir = token_dir(&app)?;
    let parsed = SecretBackend::parse(&backend)
        .ok_or_else(|| crate::i18n::tr("err.unknownSecretBackend", &[("backend", &backend)]))?;
    secret_store::delete_secret(&dir, SYNC_PASSWORD_KEY_ID, parsed)?;
    log::info!("{}", crate::i18n::t("log.syncPasswordCleared"));
    Ok(())
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/// application/x-www-form-urlencoded 值编码（字母数字与 -*._ 之外全部转义）
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'*' | b'.' | b'_' => {
                out.push(*b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencodes_form_values() {
        assert_eq!(urlencode("abc-123"), "abc-123");
        assert_eq!(urlencode("gist read:user"), "gist%20read%3Auser");
        assert_eq!(urlencode("a+b"), "a%2Bb");
    }

    #[test]
    fn gist_raw_url_origin_check() {
        assert!(normalize_gist_raw_url(
            "https://gist.githubusercontent.com/user/abc/raw/def/dockpilot-vault.json"
        )
        .is_ok());
        // http 降级 / 任意主机 / 非法 URL 一律拒绝（token 会随请求头发出去）
        assert!(normalize_gist_raw_url("http://gist.githubusercontent.com/x").is_err());
        assert!(normalize_gist_raw_url("https://evil.example.com/x").is_err());
        assert!(normalize_gist_raw_url("not a url").is_err());
    }

    /// 真连 GitHub 的集成测试（需网络 + 已启用 Device Flow 的 client_id）。
    /// 运行：VITE_SYNC_GITHUB_CLIENT_ID=xxx cargo test -- --ignored
    /// 验证：device code 签发、poll 透传 authorization_pending（用户尚未授权时）。
    #[tokio::test]
    #[ignore]
    async fn device_flow_real_github() {
        let client_id = std::env::var("VITE_SYNC_GITHUB_CLIENT_ID")
            .or_else(|_| std::env::var("GITHUB_SYNC_CLIENT_ID"))
            .expect("请通过 VITE_SYNC_GITHUB_CLIENT_ID 提供 client_id");
        assert!(!client_id.trim().is_empty(), "client_id 不能为空");

        // 1. 启动：签发 device_code / user_code
        let start = github_device_flow_start(client_id.clone(), None)
            .await
            .expect("device flow start 应成功（检查 client_id 与 Device Flow 开关）");
        assert!(!start.device_code.is_empty());
        assert!(!start.user_code.is_empty());
        assert!(start.interval >= 5, "轮询间隔最低 5 秒");
        assert!(start.expires_at > now_millis(), "过期时间应晚于当前时间");

        // 2. 轮询（用户未授权）→ GitHub 返回 error=authorization_pending，命令原样透传
        let value = github_device_flow_poll(client_id, start.device_code)
            .await
            .expect("pending 状态不应报错");
        assert_eq!(
            value.get("error").and_then(|e| e.as_str()),
            Some("authorization_pending"),
            "未授权时应返回 authorization_pending: {value}"
        );
    }
}
