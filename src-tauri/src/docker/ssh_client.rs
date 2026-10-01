//! 内置 SSH 引擎（russh，纯 Rust）：SSH 连接的默认传输实现。
//!
//! 承接原系统 ssh 的全部职责：
//! - 隧道转发：本地 unix socket（unix）/ 127.0.0.1 随机端口（Windows）→
//!   远程 docker.sock（direct-streamlocal 通道）
//! - 远程命令执行（M3 起）：compose 探测/操作、compose 文件读写
//!
//! 认证：密码（含 keyboard-interactive 回退）、显式私钥（含口令）、
//! ssh-agent、默认私钥。密码/口令经 secret_store 存取（见 ssh_secrets）。
//!
//! 主机密钥：TOFU（首次自动记录，变更拒绝并由前端确认），见 ssh_known_hosts。
//!
//! 依赖注意：russh 必须启用 ring 特性（而非默认的 aws-lc-rs），与本项目的
//! rustls ring provider 保持一致——两者共存曾导致建连时 provider 二义性 panic。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use russh::client::{self, Handle};
#[cfg(unix)]
use russh::keys::agent::client::AgentClient;
use russh::keys::{self, load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use tokio::sync::Mutex;

use crate::settings::ConnectionProfile;
use crate::ssh_secrets;

use super::ssh_known_hosts::{self, dest_key, Decision};

/// 连接超时（对齐原系统 ssh 的 ConnectTimeout=10）
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// keyboard-interactive 问答轮数上限（防 PAM 多轮提示拖死认证）
const KI_MAX_STEPS: usize = 4;

// ---------------------------------------------------------------------------
// 引擎所需的配置目录：连接层调用链（docker() → build_conn → ensure）没有 AppHandle，
// 在 lib.rs setup 时缓存一次，供引擎读取密钥与主机指纹
// ---------------------------------------------------------------------------

static CONFIG_DIR: LazyLock<std::sync::OnceLock<PathBuf>> = LazyLock::new(std::sync::OnceLock::new);

/// setup 时缓存配置目录（连接引擎无 AppHandle，只能启动时解析一次）
pub fn init_config_dir(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = CONFIG_DIR.set(dir);
    }
}

/// 测试专用：测试进程无 AppHandle，直接指定配置目录（进程内仅首次设置生效）
#[cfg(test)]
pub(crate) fn init_config_dir_for_test(dir: PathBuf) {
    let _ = CONFIG_DIR.set(dir);
}

fn config_dir() -> Result<&'static PathBuf, String> {
    CONFIG_DIR
        .get()
        .ok_or_else(|| "配置目录尚未初始化".to_string())
}

// ---------------------------------------------------------------------------
// 错误类型：结构化区分失败原因，前端按类型给出可操作提示
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum SshError {
    /// 主机指纹变更（Display 携带 [HOST_KEY_CHANGED] 前缀 + JSON 载荷供前端解析）
    HostKeyChanged {
        dest: String,
        stored: String,
        new: String,
        algo: String,
    },
    /// 网络层失败（DNS / 拒绝 / 超时）
    Connect(String),
    /// 认证失败（detail 区分密码错误 / 密钥被拒 / 未保存密码）
    Auth(String),
    /// 通道打开或转发失败
    Channel(String),
    /// 协议层错误
    Protocol(russh::Error),
}

impl std::fmt::Display for SshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshError::HostKeyChanged {
                dest,
                stored,
                new,
                algo,
            } => {
                let payload = serde_json::json!({
                    "dest": dest, "stored": stored, "new": new, "algo": algo
                });
                write!(f, "[HOST_KEY_CHANGED]{payload}")
            }
            SshError::Connect(e) => write!(f, "SSH 连接失败: {e}"),
            SshError::Auth(e) => write!(f, "SSH 认证失败: {e}"),
            SshError::Channel(e) => write!(f, "SSH 通道失败: {e}"),
            SshError::Protocol(e) => write!(f, "SSH 协议错误: {e}"),
        }
    }
}

impl std::error::Error for SshError {}

impl From<russh::Error> for SshError {
    fn from(e: russh::Error) -> Self {
        SshError::Protocol(e)
    }
}

// ---------------------------------------------------------------------------
// 连接与认证
// ---------------------------------------------------------------------------

/// 测试连接时可绕过密钥库的瞬态密码/口令（仅内存使用，不落盘不进日志）
#[derive(Debug, Clone, Default)]
pub struct TransientSecrets {
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

pub(crate) struct ClientHandler {
    /// known_hosts 条目标识（dest_key 形态）
    dest: String,
    dir: PathBuf,
}

impl client::Handler for ClientHandler {
    type Error = SshError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // 证书主机密钥取证书内公钥计算指纹（少见形态，与普通密钥同一 TOFU 语义）
        let (fingerprint, algo) = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => (
                key.fingerprint(HashAlg::Sha256).to_string(),
                key.algorithm().as_str().to_string(),
            ),
            PublicKeyOrCertificate::Certificate(cert) => {
                let key = keys::PublicKey::new(cert.public_key().clone(), "");
                (
                    key.fingerprint(HashAlg::Sha256).to_string(),
                    cert.public_key().algorithm().as_str().to_string(),
                )
            }
        };
        match ssh_known_hosts::check(&self.dir, &self.dest, &fingerprint, &algo) {
            Ok(Decision::Match) => Ok(true),
            Ok(Decision::New) => {
                ssh_known_hosts::record(&self.dir, &self.dest, &fingerprint, &algo)
                    .map_err(SshError::Channel)?;
                log::info!("已记录主机 {}（{algo}）的指纹 {fingerprint}", self.dest);
                Ok(true)
            }
            Ok(Decision::Mismatch { stored }) => Err(SshError::HostKeyChanged {
                dest: self.dest.clone(),
                stored,
                new: fingerprint,
                algo,
            }),
            Err(e) => Err(SshError::Channel(e)),
        }
    }
}

fn client_config() -> client::Config {
    client::Config {
        // keepalive 超限后会话任务自行退出，ensure() 据此判定隧道失效并重建
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    }
}

/// 拆分 ssh 地址的端口后缀：user@host:2222 → (user@host, Some("2222"))。
/// 仅当冒号后为纯数字（≤5 位）且前缀不含冒号时视为端口，避免误拆 IPv6 字面量。
pub(crate) fn split_dest_port(host: &str) -> (&str, Option<&str>) {
    match host.rsplit_once(':') {
        Some((h, p))
            if !p.is_empty()
                && p.len() <= 5
                && p.chars().all(|c| c.is_ascii_digit())
                && !h.contains(':') =>
        {
            (h, Some(p))
        }
        _ => (host, None),
    }
}

/// 远端 daemon socket 的默认路径（远程主机为 Linux）
pub(crate) fn remote_socket(p: &ConnectionProfile) -> &str {
    if p.remote_socket.is_empty() {
        "/var/run/docker.sock"
    } else {
        &p.remote_socket
    }
}

/// "user@host[:port]" → (user, host, port)，纯函数便于单测。
/// 端口拆分复用 split_dest_port（IPv6 字面量不误拆）。
fn parse_dest_with(host: &str, fallback_user: &str) -> Result<(String, String, u16), String> {
    let (user, rest) = match host.split_once('@') {
        Some((u, r)) => (u.trim().to_string(), r.trim().to_string()),
        None => (fallback_user.to_string(), host.trim().to_string()),
    };
    if user.is_empty() {
        return Err("缺少 SSH 用户名，请使用 user@host 形式".into());
    }
    let (host_part, port_str) = split_dest_port(&rest);
    if host_part.is_empty() {
        return Err("缺少 SSH 主机地址".into());
    }
    let port = match port_str {
        Some(p) => p.parse::<u16>().map_err(|_| format!("SSH 端口无效: {p}"))?,
        None => 22,
    };
    Ok((user, host_part.to_string(), port))
}

/// 缺 user 时回落本机登录名（对齐 OpenSSH 行为），无法确定时要求显式给出
pub(crate) fn parse_dest(host: &str) -> Result<(String, String, u16), String> {
    parse_dest_with(host, &default_user())
}

fn default_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

enum AuthMethod {
    Password(String),
    Key {
        path: PathBuf,
        passphrase: Option<String>,
    },
    Agent,
    /// 依次尝试 ~/.ssh 下的默认私钥（无口令；加密私钥交给 agent 或显式配置）
    DefaultKeys,
}

/// 目标主机的认证方式解析（auth 字段 + 瞬态/已存密钥）
fn resolve_auth(
    p: &ConnectionProfile,
    secrets: &TransientSecrets,
    dir: &Path,
) -> Result<AuthMethod, SshError> {
    if p.auth == "password" {
        let pass = secrets
            .password
            .clone()
            .or_else(|| ssh_secrets::load(dir, p, "password"))
            .ok_or_else(|| SshError::Auth("尚未保存密码，请编辑连接并填写".into()))?;
        return Ok(AuthMethod::Password(pass));
    }
    let key_path = p.key_path.trim();
    if !key_path.is_empty() {
        if key_path.to_ascii_lowercase().ends_with(".pub") {
            return Err(SshError::Auth(
                "私钥路径指向了 .pub 公钥文件，请改用对应的私钥（例如 id_rsa，而不是 id_rsa.pub）"
                    .into(),
            ));
        }
        let passphrase = secrets
            .passphrase
            .clone()
            .or_else(|| ssh_secrets::load(dir, p, "key_passphrase"));
        return Ok(AuthMethod::Key {
            path: PathBuf::from(key_path),
            passphrase,
        });
    }
    // 无显式私钥：优先 agent（可处理加密私钥），其次默认私钥
    if std::env::var_os("SSH_AUTH_SOCK")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        return Ok(AuthMethod::Agent);
    }
    Ok(AuthMethod::DefaultKeys)
}

fn default_key_paths() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let Some(home) = home.filter(|h| !h.as_os_str().is_empty()) else {
        return Vec::new();
    };
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|n| home.join(".ssh").join(n))
        .filter(|p| p.is_file())
        .collect()
}

/// 建立连接并完成认证
async fn connect_and_auth(
    p: &ConnectionProfile,
    secrets: &TransientSecrets,
    dir: &Path,
) -> Result<Arc<Handle<ClientHandler>>, SshError> {
    let config = Arc::new(client_config());
    let (user, host, port) = parse_dest(&p.host).map_err(SshError::Connect)?;
    let handler = ClientHandler {
        dest: dest_key(&host, port),
        dir: dir.to_path_buf(),
    };
    let mut handle = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (host.as_str(), port), handler),
    )
    .await
    .map_err(|_| SshError::Connect(format!("连接 {host}:{port} 超时（10s 内未完成握手）")))??;
    authenticate(&mut handle, &user, resolve_auth(p, secrets, dir)?).await?;
    Ok(Arc::new(handle))
}

/// 认证执行：密码失败时回退 keyboard-interactive（PAM 服务器常见）；
/// 密钥先试 rsa-sha2-256，被拒后回退 SHA1（兼容老服务器）
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    method: AuthMethod,
) -> Result<(), SshError> {
    match method {
        AuthMethod::Password(pass) => {
            let r = handle
                .authenticate_password(user, &pass)
                .await
                .map_err(|e| SshError::Auth(e.to_string()))?;
            if r.success() {
                return Ok(());
            }
            ki_authenticate(handle, user, &pass).await
        }
        AuthMethod::Key { path, passphrase } => {
            let key = load_secret_key(&path, passphrase.as_deref()).map_err(|e| {
                let hint = if passphrase.is_none() {
                    "（若私钥有口令，请在连接设置中填写并保存）"
                } else {
                    "（口令可能不正确）"
                };
                SshError::Auth(format!("加载私钥 {} 失败: {e}{hint}", path.display()))
            })?;
            pubkey_auth(handle, user, key).await
        }
        AuthMethod::Agent => auth_by_agent(handle, user).await,
        AuthMethod::DefaultKeys => try_default_keys(handle, user).await,
    }
}

/// 依次尝试 ~/.ssh 下的默认私钥（无口令；加密私钥由 agent 或显式配置覆盖）
async fn try_default_keys(handle: &mut Handle<ClientHandler>, user: &str) -> Result<(), SshError> {
    let paths = default_key_paths();
    if paths.is_empty() {
        return Err(SshError::Auth(
            "未配置私钥且未找到 ~/.ssh 下的默认私钥（id_ed25519 / id_ecdsa / id_rsa）".into(),
        ));
    }
    for path in paths {
        let Ok(key) = load_secret_key(&path, None) else {
            continue;
        };
        if pubkey_auth(handle, user, key).await.is_ok() {
            return Ok(());
        }
    }
    Err(SshError::Auth(
        "默认私钥均未被服务器接受（若私钥有口令请通过 agent 加载，或在连接设置中显式指定）".into(),
    ))
}

/// 尝试经 ssh-agent 认证（逐个尝试 agent 中的密钥）。
/// 仅 unix：russh 的 AgentClient::connect_env 走 SSH_AUTH_SOCK（unix 专属 API），
/// Windows 无此端点形态（OpenSSH agent 为命名管道），按已知限制直接走默认私钥
#[cfg(unix)]
async fn try_agent_auth(handle: &mut Handle<ClientHandler>, user: &str) -> Result<(), SshError> {
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| SshError::Auth(format!("连接 ssh-agent 失败: {e}")))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::Auth(format!("读取 agent 密钥失败: {e}")))?;
    if identities.is_empty() {
        return Err(SshError::Auth(
            "ssh-agent 中没有已加载的密钥（请先 ssh-add，或在连接设置中指定私钥路径）".into(),
        ));
    }
    for id in identities {
        let pk = id.public_key().into_owned();
        if let Ok(r) = handle
            .authenticate_publickey_with(user, pk, Some(HashAlg::Sha256), &mut agent)
            .await
        {
            if r.success() {
                return Ok(());
            }
        }
    }
    Err(SshError::Auth("服务器拒绝了 agent 中的全部密钥".into()))
}

/// Agent 认证的统一入口：agent 已配置但不可用/无密钥时回退默认私钥，而不是直接报错。
/// unix 走 ssh-agent；Windows 无 SSH_AUTH_SOCK 形态，直接走默认私钥
#[cfg(unix)]
async fn auth_by_agent(handle: &mut Handle<ClientHandler>, user: &str) -> Result<(), SshError> {
    match try_agent_auth(handle, user).await {
        Ok(()) => Ok(()),
        Err(agent_err) => try_default_keys(handle, user).await.map_err(|_| agent_err),
    }
}

#[cfg(not(unix))]
async fn auth_by_agent(handle: &mut Handle<ClientHandler>, user: &str) -> Result<(), SshError> {
    try_default_keys(handle, user).await
}

/// 公钥认证：优先 rsa-sha2-256（现代服务器），被拒回退 SHA1（老服务器兼容）
async fn pubkey_auth(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    key: keys::PrivateKey,
) -> Result<(), SshError> {
    let modern = PrivateKeyWithHashAlg::new(Arc::new(key.clone()), Some(HashAlg::Sha256));
    let r = handle
        .authenticate_publickey(user, modern)
        .await
        .map_err(|e| SshError::Auth(e.to_string()))?;
    if r.success() {
        return Ok(());
    }
    let legacy = PrivateKeyWithHashAlg::new(Arc::new(key), None);
    let r = handle
        .authenticate_publickey(user, legacy)
        .await
        .map_err(|e| SshError::Auth(e.to_string()))?;
    if r.success() {
        return Ok(());
    }
    Err(SshError::Auth("服务器拒绝了该私钥".into()))
}

/// keyboard-interactive：把密码作为非回显提示的回答（典型 PAM 场景）
async fn ki_authenticate(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    pass: &str,
) -> Result<(), SshError> {
    let mut reply = handle
        .authenticate_keyboard_interactive_start(user, None)
        .await
        .map_err(|e| SshError::Auth(e.to_string()))?;
    for _ in 0..KI_MAX_STEPS {
        match reply {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(()),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => break,
            client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let responses = prompts
                    .iter()
                    .map(|p| {
                        if p.echo {
                            String::new()
                        } else {
                            pass.to_string()
                        }
                    })
                    .collect();
                reply = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(|e| SshError::Auth(e.to_string()))?;
            }
        }
    }
    Err(SshError::Auth(
        "密码未被服务器接受（密码认证与 keyboard-interactive 均已尝试）".into(),
    ))
}

// ---------------------------------------------------------------------------
// 隧道：本地端点监听 + direct-streamlocal 转发
// ---------------------------------------------------------------------------

#[cfg(unix)]
type LocalListener = tokio::net::UnixListener;
#[cfg(windows)]
type LocalListener = tokio::net::TcpListener;

/// 活跃的 russh SSH 会话：profile_id → 会话与本地端点。
/// handle 丢弃后 sender 关闭，会话任务随之退出并关闭 TCP 连接。
struct SshTunnel {
    handle: Arc<Handle<ClientHandler>>,
    endpoint: String,
    listener_task: tokio::task::JoinHandle<()>,
    #[cfg(unix)]
    socket_path: Option<PathBuf>,
}

static TUNNELS: LazyLock<Mutex<HashMap<String, SshTunnel>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn tunnels() -> tokio::sync::MutexGuard<'static, HashMap<String, SshTunnel>> {
    TUNNELS.lock().await
}

/// 确保 profile 的 SSH 会话可用（russh 路径），返回本地端点。
/// 复用未断开的会话；keepalive 超限断开的会话自动重建。
pub async fn ensure(p: &ConnectionProfile) -> Result<String, SshError> {
    ensure_with(p, &TransientSecrets::default()).await
}

/// 同 ensure，但允许携带瞬态密码/口令（测试未保存的连接时使用）
pub async fn ensure_with(
    p: &ConnectionProfile,
    secrets: &TransientSecrets,
) -> Result<String, SshError> {
    {
        let mut map = tunnels().await;
        if let Some(t) = map.get(&p.id) {
            if !t.handle.is_closed() {
                return Ok(t.endpoint.clone());
            }
        }
        map.remove(&p.id);
    }
    let dir = config_dir().map_err(SshError::Channel)?;
    let handle = connect_and_auth(p, secrets, dir).await?;
    let (endpoint, listener) = bind_local(p).await?;
    let remote = remote_socket(p).to_string();
    let listener_task = tokio::spawn(accept_loop(listener, handle.clone(), remote));
    log::info!("SSH 会话已建立（russh）：{} → 本地端点 {endpoint}", p.host);
    tunnels().await.insert(
        p.id.clone(),
        SshTunnel {
            handle,
            endpoint: endpoint.clone(),
            listener_task,
            #[cfg(unix)]
            socket_path: Some(local_socket_path(p)),
        },
    );
    Ok(endpoint)
}

/// 取指定 profile 的已认证会话句柄（无会话时先建立），供远程命令执行复用。
/// 渠道打开是短临界区操作，与转发监听共享同一连接互不阻塞。
pub(crate) async fn session_handle(
    p: &ConnectionProfile,
) -> Result<Arc<Handle<ClientHandler>>, SshError> {
    ensure(p).await?;
    tunnels()
        .await
        .get(&p.id)
        .map(|t| t.handle.clone())
        .ok_or_else(|| SshError::Channel("SSH 会话意外丢失".into()))
}

// ---------------------------------------------------------------------------
// 远程命令执行（compose 探测/操作、compose 文件读写）
// ---------------------------------------------------------------------------

/// 一次性远程命令的执行结果
pub(crate) struct ExecOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl ExecOutput {
    /// 退出码是否为 0
    pub(crate) fn success(&self) -> bool {
        self.exit_code == 0
    }
}

/// 打开会话通道并启动远程命令（不读取输出），调用方按需 pump。
/// 失败的 EPIPE 写入（远端提前退出）由退出码兜底判定。
async fn exec_channel(
    p: &ConnectionProfile,
    remote_cmd: &str,
) -> Result<russh::Channel<client::Msg>, SshError> {
    let handle = session_handle(p).await?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::Channel(format!("打开远程会话通道失败: {e}")))?;
    channel
        .exec(true, remote_cmd)
        .await
        .map_err(|e| SshError::Channel(format!("远程命令启动失败: {e}")))?;
    Ok(channel)
}

/// 消费通道消息直到关闭，收集 stdout/stderr 与退出码。
/// 仅以 Close（或通道耗尽）收尾，避免 Eof 抢先于 ExitStatus 丢失退出码。
async fn drain_channel(mut channel: russh::Channel<client::Msg>) -> (Vec<u8>, String, Option<i32>) {
    let mut stdout = Vec::new();
    let mut stderr = String::new();
    let mut code: Option<i32> = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
            ChannelMsg::ExtendedData { ref data, .. } => {
                stderr.push_str(&String::from_utf8_lossy(data))
            }
            ChannelMsg::ExitStatus { exit_status } => {
                code = Some(i32::try_from(exit_status).unwrap_or(-1))
            }
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    (stdout, stderr, code)
}

/// 执行一次性远程命令并收集完整输出（超时兜底，防远端命令挂死）
pub(crate) async fn exec(
    p: &ConnectionProfile,
    remote_cmd: &str,
    timeout: Duration,
) -> Result<ExecOutput, SshError> {
    let channel = exec_channel(p, remote_cmd).await?;
    let fut = drain_channel(channel);
    let (stdout, stderr, code) = tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| SshError::Channel(format!("远程命令超时（超过 {timeout:?}）")))?;
    Ok(ExecOutput {
        exit_code: code.unwrap_or(-1),
        stdout,
        stderr,
    })
}

/// 执行远程命令并写入 stdin（远端 `cat > 路径` 等场景），返回退出码与 stderr。
/// 远端提前退出时写入失败不视为错误，由退出码兜底（对齐系统 ssh 路径语义）。
pub(crate) async fn exec_write(
    p: &ConnectionProfile,
    remote_cmd: &str,
    content: Vec<u8>,
    timeout: Duration,
) -> Result<ExecOutput, SshError> {
    let handle = session_handle(p).await?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::Channel(format!("打开远程会话通道失败: {e}")))?;
    channel
        .exec(true, remote_cmd)
        .await
        .map_err(|e| SshError::Channel(format!("远程命令启动失败: {e}")))?;
    // 写入失败静默：远端 `cat` 提前退出即 EPIPE，与系统 ssh 管道行为一致
    let _ = channel.data_bytes(content).await;
    let _ = channel.eof().await;

    let (stdout, stderr, code) = tokio::time::timeout(timeout, drain_channel(channel))
        .await
        .map_err(|_| SshError::Channel(format!("写入远程文件超时（超过 {timeout:?}）")))?;
    Ok(ExecOutput {
        exit_code: code.unwrap_or(-1),
        stdout,
        stderr,
    })
}

/// 停止指定 profile 的会话（幂等）：断开 SSH 连接并中止本地监听
pub async fn stop(profile_id: &str) {
    if let Some(t) = tunnels().await.remove(profile_id) {
        t.listener_task.abort();
        let _ = t
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        #[cfg(unix)]
        if let Some(path) = t.socket_path {
            let _ = std::fs::remove_file(path);
        }
        log::info!("SSH 会话已停止: {profile_id}");
    }
}

/// 停止除 keep_id 外的所有会话（切换连接时回收旧隧道）
pub async fn stop_others(keep_id: &str) {
    let stale: Vec<String> = {
        let map = tunnels().await;
        map.keys()
            .filter(|id| id.as_str() != keep_id)
            .cloned()
            .collect()
    };
    for id in stale {
        stop(&id).await;
    }
}

/// 应用退出时回收全部会话
pub async fn stop_all() {
    let ids: Vec<String> = tunnels().await.keys().cloned().collect();
    for id in ids {
        stop(&id).await;
    }
}

/// 本地端点：unix 为 $TMPDIR/dockpilot-tunnel-{id}.sock（与系统 ssh 路径同形，
/// bollard/compose CLI 经 unix:// 使用）；windows 为 127.0.0.1 内核分配的随机端口
/// （直接 bind :0 由内核分配，无探测-释放竞态）
#[cfg(unix)]
fn local_socket_path(p: &ConnectionProfile) -> PathBuf {
    std::env::temp_dir().join(format!("dockpilot-tunnel-{}.sock", p.id))
}

#[cfg(unix)]
async fn bind_local(p: &ConnectionProfile) -> Result<(String, LocalListener), SshError> {
    let path = local_socket_path(p);
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path)
        .map_err(|e| SshError::Channel(format!("绑定本地 unix socket 失败: {e}")))?;
    Ok((path.to_string_lossy().into_owned(), listener))
}

#[cfg(windows)]
async fn bind_local(_p: &ConnectionProfile) -> Result<(String, LocalListener), SshError> {
    // tokio 的 TcpListener::bind 为异步（与 std 不同；local_addr 是同步的）
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| SshError::Channel(format!("绑定本地端口失败: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| SshError::Channel(format!("读取本地端口失败: {e}")))?
        .port();
    Ok((format!("127.0.0.1:{port}"), listener))
}

/// 接受本地连接并经 direct-streamlocal 通道转发到远程 docker.sock。
/// direct-streamlocal 与平台无关（Windows 侧同样转发到远程 unix socket）。
async fn accept_loop(listener: LocalListener, handle: Arc<Handle<ClientHandler>>, remote: String) {
    loop {
        match listener.accept().await {
            Ok((mut stream, _)) => {
                let handle = handle.clone();
                let remote = remote.clone();
                tokio::spawn(async move {
                    match handle.channel_open_direct_streamlocal(remote).await {
                        Ok(ch) => {
                            let mut ch = ch.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut stream, &mut ch).await;
                        }
                        Err(e) => log::warn!(
                            "SSH 转发通道打开失败（检查远程 docker.sock 路径与 sshd AllowTcpForwarding）: {e}"
                        ),
                    }
                });
            }
            Err(e) => {
                log::warn!("SSH 隧道本地监听异常退出: {e}");
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_dest_splits_user_host_port() {
        assert_eq!(
            parse_dest_with("root@10.0.0.5:2222", "me").unwrap(),
            ("root".into(), "10.0.0.5".into(), 2222)
        );
        assert_eq!(
            parse_dest_with("root@10.0.0.5", "me").unwrap(),
            ("root".into(), "10.0.0.5".into(), 22)
        );
        // 缺 user 回落 fallback
        assert_eq!(
            parse_dest_with("10.0.0.5:2223", "me").unwrap(),
            ("me".into(), "10.0.0.5".into(), 2223)
        );
        // IPv6 字面量不误拆端口
        assert_eq!(
            parse_dest_with("root@2001:db8::1", "me").unwrap(),
            ("root".into(), "2001:db8::1".into(), 22)
        );
        // 空白容忍
        assert_eq!(
            parse_dest_with(" root @ 10.0.0.5 ", "me").unwrap(),
            ("root".into(), "10.0.0.5".into(), 22)
        );
    }

    #[test]
    fn parse_dest_rejects_missing_user_and_bad_port() {
        assert!(
            parse_dest_with("10.0.0.5", "").is_err(),
            "无法确定用户名时应报错"
        );
        assert!(parse_dest_with("root@:2222", "me").is_err());
        assert!(parse_dest_with("root@", "me").is_err());
        // 端口超 u16 范围
        assert!(parse_dest_with("root@10.0.0.5:99999", "me").is_err());
        // 非数字后缀按 split_dest_port 契约留在主机段（与 OpenSSH 行为一致，
        // 交由连接阶段的域名解析报错），确认不会被当成端口或报端口错误
        assert_eq!(
            parse_dest_with("root@10.0.0.5:abc", "me").unwrap(),
            ("root".into(), "10.0.0.5:abc".into(), 22)
        );
    }

    #[test]
    fn split_dest_port_variants() {
        assert_eq!(
            split_dest_port("root@10.0.0.5:2222"),
            ("root@10.0.0.5", Some("2222"))
        );
        assert_eq!(split_dest_port("root@10.0.0.5"), ("root@10.0.0.5", None));
        // IPv6 字面量（冒号后虽是数字但前缀仍含冒号）不误拆
        assert_eq!(
            split_dest_port("root@2001:db8::1"),
            ("root@2001:db8::1", None)
        );
        // 非数字后缀不视为端口
        assert_eq!(split_dest_port("user@host:abc"), ("user@host:abc", None));
    }

    #[test]
    fn remote_socket_falls_back_to_default_path() {
        let mut p = ConnectionProfile {
            id: "t".into(),
            kind: "ssh".into(),
            host: "root@10.0.0.5".into(),
            ..Default::default()
        };
        assert_eq!(remote_socket(&p), "/var/run/docker.sock");
        p.remote_socket = "/run/user/1000/docker.sock".into();
        assert_eq!(remote_socket(&p), "/run/user/1000/docker.sock");
    }
}
