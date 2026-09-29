//! 镜像仓库凭据管理：元数据（名称/地址/用户名）存 settings.json，
//! 密码存 secret_store（系统钥匙串，回退机器绑定加密文件）。
//!
//! 阿里云 ACR 与 Harbor 均为 Docker Registry v2 兼容协议：
//! 测试连接按 `/v2/` 探测 + WWW-Authenticate 分派（Bearer token 流 / Basic）。

use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::Manager;

use crate::docker::conn::CmdResult;
use crate::secret_store::{self, SecretBackend};
use crate::settings::{self, AppSettings, RegistryProfile};

/// 发给前端的凭据档案（脱敏，不含密码）
#[derive(Debug, Clone, Serialize)]
pub struct RegistryDto {
    pub id: String,
    pub name: String,
    /// "aliyun" | "harbor" | "generic"
    pub kind: String,
    pub registry: String,
    pub username: String,
    /// 密钥实际存储位置："keyring" | "file"
    pub secret_backend: String,
    /// 测试连接时跳过 TLS 证书校验（自签名 Harbor 用）
    pub skip_tls_verify: bool,
    pub created_at: i64,
}

impl From<&RegistryProfile> for RegistryDto {
    fn from(p: &RegistryProfile) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            kind: p.kind.clone(),
            registry: p.registry.clone(),
            username: p.username.clone(),
            secret_backend: p.secret_backend.clone(),
            skip_tls_verify: p.skip_tls_verify,
            created_at: p.created_at,
        }
    }
}

/// 前端提交的保存规格；id 为 Some 且已存在时为编辑，否则新建。
/// password 为空串/None 表示"不修改密码"（编辑时）。
#[derive(Debug, Clone, Deserialize)]
pub struct RegistrySpec {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub registry: String,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub skip_tls_verify: bool,
}

/// 测试连接结果（同 ConnectionTestResult 风格：结构化返回而非抛错）
#[derive(Debug, Clone, Serialize)]
pub struct RegistryTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
    /// 经 HTTP（非 HTTPS）访问成功：推送前需在 daemon.json 配置 insecure-registries
    pub via_http: bool,
}

fn secret_key(profile_id: &str) -> String {
    format!("registry/{profile_id}")
}

fn find_profile<'a>(s: &'a AppSettings, id: &str) -> Result<&'a RegistryProfile, String> {
    s.registries
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "仓库凭据不存在或已被删除".to_string())
}

#[tauri::command]
pub async fn list_registries(app: tauri::AppHandle) -> CmdResult<Vec<RegistryDto>> {
    let s = settings::load(&app);
    Ok(s.registries.iter().map(RegistryDto::from).collect())
}

/// 新建或编辑凭据；密码仅在非空时更新（编辑留空 = 保留原密码）
#[tauri::command]
pub async fn save_registry(app: tauri::AppHandle, spec: RegistrySpec) -> CmdResult<RegistryDto> {
    let registry = settings::normalize_registry_host(&spec.registry);
    if registry.is_empty() {
        return Err("请填写仓库地址".into());
    }
    if registry.contains(char::is_whitespace) || registry.contains('/') {
        return Err("仓库地址应为域名[:端口]，如 registry.cn-hangzhou.aliyuncs.com".into());
    }
    let username = spec.username.trim().to_string();
    if username.is_empty() {
        return Err("请填写用户名".into());
    }
    let kind = spec.kind.trim().to_string();

    let mut s = settings::load(&app);
    let existing = spec
        .id
        .as_deref()
        .and_then(|id| s.registries.iter().find(|r| r.id == id).cloned());

    let (mut profile, is_new) = match existing {
        Some(p) => (p, false),
        None => (
            RegistryProfile {
                id: uuid::Uuid::new_v4().to_string(),
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
                ..Default::default()
            },
            true,
        ),
    };

    profile.name = spec.name.trim().to_string();
    profile.kind = kind;
    profile.registry = registry;
    profile.username = username;
    profile.skip_tls_verify = spec.skip_tls_verify;

    // 密码：非空才写入密钥库；新建必须提供
    let password = spec.password.unwrap_or_default();
    if !password.is_empty() {
        let dir = secret_store::config_dir(&app)?;
        let backend = secret_store::save_secret(&dir, &secret_key(&profile.id), &password)?;
        profile.secret_backend = backend.as_str().to_string();
    } else if is_new {
        return Err("请填写密码或访问令牌".into());
    }

    s.registries.retain(|r| r.id != profile.id);
    s.registries.push(profile.clone());
    settings::save(&app, &s)?;
    Ok(RegistryDto::from(&profile))
}

/// 删除凭据档案并尽力清理密钥；密钥清理失败时如实报错（档案已删除）
#[tauri::command]
pub async fn remove_registry(app: tauri::AppHandle, id: String) -> CmdResult<()> {
    let mut s = settings::load(&app);
    let profile = find_profile(&s, &id)?.clone();
    s.registries.retain(|r| r.id != id);
    settings::save(&app, &s)?;

    let dir = secret_store::config_dir(&app)?;
    let backend = SecretBackend::parse(&profile.secret_backend).unwrap_or(SecretBackend::Keyring);
    if let Err(e) = secret_store::delete_secret(&dir, &secret_key(&id), backend) {
        return Err(format!("已删除仓库配置，但清理密钥失败: {e}"));
    }
    Ok(())
}

/// 测试仓库连通性与凭据有效性（HTTPS 失败时自动尝试 HTTP 并标记 via_http）
#[tauri::command]
pub async fn test_registry(
    app: tauri::AppHandle,
    id: String,
    skip_tls_verify: Option<bool>,
) -> CmdResult<RegistryTestResult> {
    let s = settings::load(&app);
    let profile = find_profile(&s, &id)?.clone();

    let dir = secret_store::config_dir(&app)?;
    let backend = SecretBackend::parse(&profile.secret_backend).unwrap_or(SecretBackend::Keyring);
    let password = secret_store::load_secret(&dir, &secret_key(&id), backend)?
        .ok_or_else(|| "未找到已保存的密码，请重新编辑并保存凭据".to_string())?;

    // 未显式指定时使用凭据档案中保存的开关
    let skip_tls = skip_tls_verify.unwrap_or(profile.skip_tls_verify);
    Ok(probe_registry(&profile.registry, &profile.username, &password, skip_tls).await)
}

/// 按标准 Docker Registry v2 探测：/v2/ 未认证请求 → 按 WWW-Authenticate 分派验证
async fn probe_registry(
    registry: &str,
    username: &str,
    password: &str,
    skip_tls_verify: bool,
) -> RegistryTestResult {
    let start = Instant::now();
    let (result, via_http) = for_https_then_http(registry, username, password, skip_tls_verify).await;

    RegistryTestResult {
        ok: result.is_ok(),
        latency_ms: start.elapsed().as_millis() as u64,
        error: result.err().map(|e| {
            if let Some(hint) = crate::docker::push::push_error_hint(&e) {
                format!("{e}\n提示：{hint}")
            } else {
                e
            }
        }),
        via_http,
    }
}

/// 传输层失败（连接不上/TLS 异常）错误的前缀；据此决定是否回退 HTTP 重试
const TRANSPORT_ERR_PREFIX: &str = "连接仓库失败";

fn build_client(skip_tls_verify: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(skip_tls_verify)
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

async fn for_https_then_http(
    registry: &str,
    username: &str,
    password: &str,
    skip_tls_verify: bool,
) -> (Result<(), String>, bool) {
    let mut last_err = String::new();
    for (scheme, via_http) in [("https", false), ("http", true)] {
        let base = format!("{scheme}://{registry}");
        match probe_base(&base, username, password, skip_tls_verify).await {
            Ok(()) => return (Ok(()), via_http),
            Err(e) => {
                last_err = e;
                // 仅传输层错误才值得再试 HTTP；认证失败等应用层错误直接返回
                if !last_err.starts_with(TRANSPORT_ERR_PREFIX) {
                    return (Err(last_err), false);
                }
            }
        }
    }
    (Err(last_err), false)
}

async fn probe_base(
    base: &str,
    username: &str,
    password: &str,
    skip_tls_verify: bool,
) -> Result<(), String> {
    let client = build_client(skip_tls_verify)?;
    let resp = client
        .get(format!("{base}/v2/"))
        .send()
        .await
        .map_err(|e| format!("连接仓库失败: {e}"))?;

    match resp.status() {
        reqwest::StatusCode::OK => Ok(()),
        reqwest::StatusCode::UNAUTHORIZED => {
            let www_auth = resp
                .headers()
                .get(reqwest::header::WWW_AUTHENTICATE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            verify_with_challenge(&client, base, username, password, &www_auth).await
        }
        status => Err(format!("仓库响应异常: HTTP {status}")),
    }
}

/// 按 WWW-Authenticate 挑战验证凭据：Bearer 走 token 流，Basic 直接重试
async fn verify_with_challenge(
    client: &reqwest::Client,
    base: &str,
    username: &str,
    password: &str,
    www_auth: &str,
) -> Result<(), String> {
    if let Some(realm) = parse_challenge_param(www_auth, "realm") {
        // Bearer token 流（阿里云 ACR / Harbor / distribution 均此流程）
        let mut url = reqwest::Url::parse(&realm).map_err(|e| format!("认证服务地址异常: {e}"))?;
        if let Some(service) = parse_challenge_param(www_auth, "service") {
            url.query_pairs_mut().append_pair("service", &service);
        }
        url.query_pairs_mut().append_pair("account", username);

        let token_resp = client
            .get(url)
            .basic_auth(username, Some(password))
            .send()
            .await
            .map_err(|e| format!("请求认证服务失败: {e}"))?;

        if token_resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("认证失败：用户名或密码不正确（HTTP 401）".into());
        }
        if !token_resp.status().is_success() {
            return Err(format!("认证服务响应异常: HTTP {}", token_resp.status()));
        }
        #[derive(Deserialize)]
        struct TokenResp {
            #[serde(default)]
            token: Option<String>,
            #[serde(default)]
            access_token: Option<String>,
        }
        let tr: TokenResp = token_resp
            .json()
            .await
            .map_err(|e| format!("解析认证响应失败: {e}"))?;
        let token = tr
            .token
            .or(tr.access_token)
            .ok_or_else(|| "认证服务未返回令牌".to_string())?;

        let ping = client
            .get(format!("{base}/v2/"))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| format!("连接仓库失败: {e}"))?;
        if ping.status() == reqwest::StatusCode::OK {
            return Ok(());
        }
        return Err(format!(
            "认证未通过（HTTP {}）：请检查用户名与密码/令牌",
            ping.status()
        ));
    }

    // Basic 认证或未知挑战：带凭据重试 /v2/
    let resp = client
        .get(format!("{base}/v2/"))
        .basic_auth(username, Some(password))
        .send()
        .await
        .map_err(|e| format!("连接仓库失败: {e}"))?;
    match resp.status() {
        reqwest::StatusCode::OK => Ok(()),
        reqwest::StatusCode::UNAUTHORIZED => {
            Err("认证失败：用户名或密码不正确（HTTP 401）".into())
        }
        status => Err(format!("仓库响应异常: HTTP {status}")),
    }
}

/// 从 `Bearer realm="…",service="…"` 中取参数值（容忍单/双引号与参数顺序）。
/// 在小写副本中定位 key、回原串切片取值，保持值的大小写。
fn parse_challenge_param(www_auth: &str, key: &str) -> Option<String> {
    let lower = www_auth.to_lowercase();
    let key_prefix = format!("{key}=");
    let idx = lower.find(&key_prefix)?;
    let rest = www_auth[idx + key_prefix.len()..].trim_start();
    for q in ['"', '\''] {
        if let Some(inner) = rest.strip_prefix(q) {
            let end = inner.find(q)?;
            return Some(inner[..end].to_string());
        }
    }
    // 无引号：取到逗号或结尾
    let end = rest.find(',').unwrap_or(rest.len());
    Some(rest[..end].trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_param_parses_bearer_header() {
        let h = r#"Bearer realm="https://auth.example.com/token",service="registry.docker.io",scope="repository:foo/bar:pull""#;
        assert_eq!(parse_challenge_param(h, "realm").as_deref(), Some("https://auth.example.com/token"));
        assert_eq!(parse_challenge_param(h, "service").as_deref(), Some("registry.docker.io"));
        assert_eq!(parse_challenge_param(h, "scope").as_deref(), Some("repository:foo/bar:pull"));
        assert_eq!(parse_challenge_param(h, "missing"), None);
    }

    #[test]
    fn challenge_param_handles_single_quotes_and_order() {
        let h = "Bearer service='harbor.local', realm='https://harbor.local/service/token'";
        assert_eq!(parse_challenge_param(h, "realm").as_deref(), Some("https://harbor.local/service/token"));
        assert_eq!(parse_challenge_param(h, "service").as_deref(), Some("harbor.local"));
        // 无引号 + 逗号分隔
        let h2 = "Basic realm=restricted, charset=UTF-8";
        assert_eq!(parse_challenge_param(h2, "realm").as_deref(), Some("restricted"));
    }
}
