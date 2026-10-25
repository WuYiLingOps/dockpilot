//! 进程级界面语言与消息表：后端用户可见文案（错误消息、托盘菜单、系统通知、
//! 使用日志）的中英双语出口。
//!
//! 语言是进程级单例（AtomicU8）而非逐层传参：多数命令不持有 AppHandle，
//! 且大量用户可见错误在深层模块（ssh_client、registries 等）与 Display
//! 实现里产生，拿不到任何调用上下文。语言由三条路径更新：
//! ① setup 加载设置后初始化；② set_ui_language 命令（前端上报按
//! navigator.language 解析后的结果，覆盖「跟随系统」场景）；③ set_settings
//! 保存时 diff 显式值兜底。

use std::sync::atomic::{AtomicU8, Ordering};

/// 界面语言。settings.language 为 "system" 时后端无法感知系统语言，
/// 默认按中文处理，前端解析完成后经 set_ui_language 上报覆盖
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
}

static LANG: AtomicU8 = AtomicU8::new(0);

impl Lang {
    /// settings.language 的后端侧解析："en" → 英文，其余（含 "system"/"zh"）→ 中文
    pub fn from_setting(s: &str) -> Self {
        if s == "en" {
            Lang::En
        } else {
            Lang::Zh
        }
    }
}

/// 读取当前界面语言
pub fn lang() -> Lang {
    match LANG.load(Ordering::Relaxed) {
        1 => Lang::En,
        _ => Lang::Zh,
    }
}

/// 更新当前界面语言
pub fn set_global(l: Lang) {
    LANG.store(
        match l {
            Lang::Zh => 0,
            Lang::En => 1,
        },
        Ordering::Relaxed,
    );
}

/// 当前语言下的消息（未登记的 key 原样返回，便于迁移期渐进替换）
pub fn t(key: &str) -> &str {
    t_of(lang(), key)
}

/// 返回值与输入 key 同生命周期：登记消息来自 'static 消息表，未登记时原样返回 key
pub fn t_of(l: Lang, key: &str) -> &str {
    let idx = match l {
        Lang::Zh => 0,
        Lang::En => 1,
    };
    MSGS.iter()
        .find(|(k, _)| *k == key)
        .map(|(_, texts)| texts[idx])
        .unwrap_or(key)
}

/// {name} 占位符插值：未提供的占位符原样保留
fn interpolate(template: &str, args: &[(&str, &str)]) -> String {
    let mut s = template.to_string();
    for (name, value) in args {
        s = s.replace(&format!("{{{name}}}"), value);
    }
    s
}

/// 当前语言下的消息 + {name} 占位符插值
pub fn tr(key: &str, args: &[(&str, &str)]) -> String {
    interpolate(t(key), args)
}

// ------------------------------------------------------------------
// 托盘菜单：文案随语言变化，语言更新后整体重建
// ------------------------------------------------------------------

/// 构建托盘菜单（setup 初始化与语言变化重建共用）
pub fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};
    let show = MenuItem::with_id(app, "show", t("tray.show"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t("tray.quit"), true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}

/// 语言变化后重建托盘菜单（托盘以 id "tray" 注册；未启用托盘时静默跳过）
pub fn rebuild_tray_menu(app: &tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id("tray") {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// 前端上报解析后的界面语言（"en" 之外的值按中文处理）。
/// 全局语言实际变化时同步重建托盘菜单，保证菜单与界面语言一致
#[tauri::command]
pub fn set_ui_language(app: tauri::AppHandle, language: String) {
    let next = Lang::from_setting(&language);
    let changed = lang() != next;
    set_global(next);
    if changed {
        rebuild_tray_menu(&app);
    }
}

/// 消息表：一行 = (key, [中文, 英文])。新增消息中英对照写在同一行，便于评审。
/// key 按域前缀命名（tray.* / cleanup.* / err.* / log.* …）
const MSGS: &[(&str, [&str; 2])] = &[
    ("tray.show", ["显示 DockPilot", "Show DockPilot"]),
    ("tray.quit", ["退出", "Quit"]),
    // ---- 空间清理 ----
    ("cleanup.dangling_images", ["悬空镜像", "dangling images"]),
    ("cleanup.unused_images", ["未使用镜像", "unused images"]),
    ("cleanup.stopped_containers", ["已停止容器", "stopped containers"]),
    ("cleanup.unused_volumes", ["未使用卷", "unused volumes"]),
    ("cleanup.build_cache", ["构建缓存", "build cache"]),
    ("cleanup.start", ["空间清理：{kinds}", "Cleanup: {kinds}"]),
    ("cleanup.kindDone", ["空间清理 {kind}：删除 {removed} 项，回收 {space}", "Cleanup {kind}: removed {removed} item(s), reclaimed {space}"]),
    ("cleanup.kindFailed", ["空间清理 {kind} 失败: {err}", "Cleanup {kind} failed: {err}"]),
    ("cleanup.done", ["空间清理完成：共回收 {space}", "Cleanup finished: {space} reclaimed in total"]),
    ("err.disk_usage_failed", ["获取磁盘占用失败: {err}", "Failed to get disk usage: {err}"]),
    // ---- 容器异常通知（events.rs）----
    ("notify.containerDied", ["容器异常退出", "Container exited abnormally"]),
    ("notify.containerDiedBody", ["容器 {name} 已退出（exit code {code}）", "Container {name} exited (exit code {code})"]),
    ("notify.containerOom", ["容器内存不足（OOM）", "Container out of memory (OOM)"]),
    ("notify.containerOomBody", ["容器 {name} 因内存不足被终止，可尝试调大内存限制", "Container {name} was killed because it ran out of memory — consider raising its memory limit"]),
    ("notify.containerUnhealthy", ["容器健康检查失败", "Container health check failed"]),
    ("notify.containerUnhealthyBody", ["容器 {name} 连续未通过健康检查，已标记为 unhealthy", "Container {name} keeps failing its health check and has been marked unhealthy"]),
    // ---- 设置 ----
    ("err.config_dir_failed", ["获取配置目录失败: {err}", "Failed to resolve the config directory: {err}"]),
    ("err.config_path_invalid", ["配置文件路径异常", "Invalid config file path"]),
    ("err.config_mkdir_failed", ["创建配置目录失败: {err}", "Failed to create the config directory: {err}"]),
    ("err.settings_serialize_failed", ["序列化设置失败: {err}", "Failed to serialize settings: {err}"]),
    ("err.settings_write_failed", ["写入设置失败: {err}", "Failed to write settings: {err}"]),
    ("err.settings_save_failed", ["保存设置失败: {err}", "Failed to save settings: {err}"]),
    ("log.settingsUpdated", ["设置已更新：{keys}", "Settings updated: {keys}"]),
    ("err.unknownCloseAction", ["未知的关闭行为: {action}", "Unknown close action: {action}"]),
    // ---- 容器（containers.rs）----
    ("err.list_containers_failed", ["获取容器列表失败: {err}", "Failed to list containers: {err}"]),
    ("err.inspect_container_failed", ["查看容器失败: {err}", "Failed to inspect the container: {err}"]),
    ("err.container_top_failed", ["查看容器进程失败: {err}", "Failed to get container processes: {err}"]),
    ("log.containerAction", ["容器 {id} 执行 {action}{force}", "Container {id} running {action}{force}"]),
    ("log.forceSuffix", ["（force）", " (force)"]),
    ("err.unknownAction", ["未知操作: {action}", "Unknown action: {action}"]),
    ("log.containerActionFailed", ["容器 {id} {action} 失败: {err}", "Container {id} {action} failed: {err}"]),
    ("err.containerActionFailed", ["容器执行 {action} 失败: {err}", "Failed to {action} the container: {err}"]),
    ("log.containerUpdateConfig", ["容器 {id} 更新配置", "Container {id}: config updated"]),
    ("log.containerUpdateConfigFailed", ["容器 {id} 更新配置失败: {err}", "Container {id}: failed to update config: {err}"]),
    ("err.update_config_failed", ["更新容器配置失败: {err}", "Failed to update container config: {err}"]),
    ("err.unknownRestartPolicy", ["未知重启策略: {policy}", "Unknown restart policy: {policy}"]),
    ("err.cmdParseFailed", ["命令解析失败: {err}", "Failed to parse the command: {err}"]),
    ("err.memPositiveWith", ["内存上限必须是正数（收到 {v} MB）", "Memory limit must be positive (got {v} MB)"]),
    ("err.cpuPositiveWith", ["CPU 核数必须是正数（收到 {v}）", "CPU cores must be positive (got {v})"]),
    ("err.imageRequired", ["镜像不能为空", "Image name is required"]),
    ("log.createContainer", ["创建容器：{name}（镜像 {image}）", "Creating container: {name} (image {image})"]),
    ("log.autoName", ["<自动命名>", "<auto-generated>"]),
    ("err.autoRemoveConflict", ["自动移除与重启策略不能同时启用", "Auto-remove and a restart policy cannot be enabled together"]),
    ("err.create_container_failed", ["创建容器失败: {err}", "Failed to create the container: {err}"]),
    ("err.create_start_failed", ["容器已创建但启动失败（可在容器列表查看或删除）: {err}", "The container was created but failed to start (see it in the container list or delete it): {err}"]),
    ("err.memEmpty", ["内存值不能为空", "Memory value cannot be empty"]),
    ("err.memInvalid", ["内存值不合法: {v}", "Invalid memory value: {v}"]),
    ("err.memTooSmall", ["内存值太小（至少 1MB）: {v}", "Memory value too small (min 1MB): {v}"]),
    ("err.memPositive", ["内存值必须为正: {v}", "Memory value must be positive: {v}"]),
    ("err.portMissingHost", ["端口映射 {v} 未指定宿主端口（DockPilot 需要显式端口，如 -p 8080:80）", "Port mapping {v} has no host port (DockPilot requires an explicit port, e.g. -p 8080:80)"]),
    ("err.portInvalid", ["端口映射不合法: {v}", "Invalid port mapping: {v}"]),
    ("err.hostPortInvalid", ["宿主端口不合法: {host}（{v}）", "Invalid host port: {host} ({v})"]),
    ("err.containerPortInvalid", ["容器端口不合法: {container}（{v}）", "Invalid container port: {container} ({v})"]),
    ("err.bindMissingContainer", ["卷挂载 {v} 缺少容器路径（DockPilot 需要 host:container 形式）", "Volume mount {v} is missing the container path (DockPilot requires host:container)"]),
    ("err.envMissingValue", ["环境变量/标签 {v} 缺少值（请写成 KEY=VALUE 形式，无法从当前环境透传）", "Env/label {v} is missing a value (use KEY=VALUE; values cannot be passed through from the host environment)"]),
    ("err.flagMissingValue", ["选项 {flag} 缺少值", "Option {flag} is missing a value"]),
    ("err.cpuInvalid", ["CPU 核数不合法: {v}", "Invalid CPU core count: {v}"]),
    ("err.unsupportedFlag", ["暂不支持的 docker run 选项: {flag}（可手动删除后重新导入）", "Unsupported docker run option: {flag} (remove it and re-import)"]),
    ("err.imageNotFoundInCmd", ["命令中未找到镜像名", "No image name found in the command"]),
    ("err.emptyCommand", ["命令为空", "The command is empty"]),
    // ---- 镜像仓库凭据（registries.rs）----
    ("err.registryNotFound", ["仓库凭据不存在或已被删除", "The registry credential does not exist or was deleted"]),
    ("err.registryAddrRequired", ["请填写仓库地址", "Registry address is required"]),
    ("err.registryAddrFormat", ["仓库地址应为域名[:端口]，如 registry.cn-hangzhou.aliyuncs.com", "The registry address should be domain[:port], e.g. registry.cn-hangzhou.aliyuncs.com"]),
    ("err.registryUserRequired", ["请填写用户名", "Username is required"]),
    ("err.registryPasswordRequired", ["请填写密码或访问令牌", "Password or access token is required"]),
    ("log.registrySaved", ["{op}镜像仓库凭据：{name}（{registry}）", "{op} registry credential: {name} ({registry})"]),
    ("log.registryUpdate", ["更新", "Updated"]),
    ("log.registryAdd", ["添加", "Added"]),
    ("log.registryDeleted", ["删除镜像仓库凭据：{name}", "Registry credential deleted: {name}"]),
    ("err.registryKeyCleanupFailed", ["已删除仓库配置，但清理密钥失败: {err}", "The registry was deleted, but cleaning up the secret failed: {err}"]),
    ("err.registryNoSavedPassword", ["未找到已保存的密码，请重新编辑并保存凭据", "No saved password found — edit and save the credential again"]),
    ("log.registryTestOk", ["测试仓库「{name}」成功：{ms} ms{http}", "Tested registry \"{name}\" OK: {ms} ms{http}"]),
    ("log.registryHttpFallback", ["（HTTP 回退）", " (HTTP fallback)"]),
    ("log.registryTestFailed", ["测试仓库「{name}」失败：{err}", "Testing registry \"{name}\" failed: {err}"]),
    ("err.unknown", ["未知错误", "unknown error"]),
    ("err.registryTransport", ["连接仓库失败", "Failed to connect to the registry"]),
    ("err.httpClientCreateFailed", ["创建 HTTP 客户端失败: {err}", "Failed to create the HTTP client: {err}"]),
    ("err.registryProbeFailed", ["连接仓库失败: {err}", "Failed to connect to the registry: {err}"]),
    ("err.registryBadStatus", ["仓库响应异常: HTTP {status}", "Unexpected registry response: HTTP {status}"]),
    ("err.authRealmInvalid", ["认证服务地址异常: {err}", "Invalid auth server URL: {err}"]),
    ("err.authRequestFailed", ["请求认证服务失败: {err}", "Failed to reach the auth server: {err}"]),
    ("err.authUnauthorized401", ["认证失败：用户名或密码不正确（HTTP 401）", "Authentication failed: incorrect username or password (HTTP 401)"]),
    ("err.authBadStatus", ["认证服务响应异常: HTTP {status}", "Unexpected auth server response: HTTP {status}"]),
    ("err.authParseFailed", ["解析认证响应失败: {err}", "Failed to parse the auth response: {err}"]),
    ("err.authNoToken", ["认证服务未返回令牌", "The auth server did not return a token"]),
    ("err.registryAuthRejected", ["认证未通过（HTTP {status}）：请检查用户名与密码/令牌", "Authentication rejected (HTTP {status}): check the username and password/token"]),
    // ---- SSH 引擎（ssh_client.rs）----
    ("err.configDirNotInit", ["配置目录尚未初始化", "The config directory has not been initialized"]),
    ("err.sshConnect", ["SSH 连接失败: {err}", "SSH connection failed: {err}"]),
    ("err.sshAuth", ["SSH 认证失败: {err}", "SSH authentication failed: {err}"]),
    ("err.sshChannel", ["SSH 通道失败: {err}", "SSH channel failed: {err}"]),
    ("err.sshProtocol", ["SSH 协议错误: {err}", "SSH protocol error: {err}"]),
    ("log.sshFingerprintSaved", ["已记录主机 {dest}（{algo}）的指纹 {fp}", "Recorded fingerprint {fp} for host {dest} ({algo})"]),
    ("err.sshUserMissing", ["缺少 SSH 用户名，请使用 user@host 形式", "SSH username is missing — use the user@host form"]),
    ("err.sshHostMissing", ["缺少 SSH 主机地址", "SSH host address is missing"]),
    ("err.sshPortInvalid", ["SSH 端口无效: {port}", "Invalid SSH port: {port}"]),
    ("err.sshNoSavedPassword", ["尚未保存密码，请编辑连接并填写", "No password saved yet — edit the connection and set one"]),
    ("err.sshKeychainKeyMissing", ["钥匙串私钥不存在，请到「SSH 凭证」重新导入或改用文件路径", "The keychain key does not exist — re-import it in SSH credentials or use a file path"]),
    ("err.sshPubKeySelected", ["私钥路径指向了 .pub 公钥文件，请改用对应的私钥（例如 id_rsa，而不是 id_rsa.pub）", "The key path points to a .pub public key file — use the private key instead (e.g. id_rsa, not id_rsa.pub)"]),
    ("err.sshIdentityKeyMissing", ["身份关联的钥匙串私钥不存在，请到「SSH 凭证」检查", "The keychain key linked to the identity does not exist — check SSH credentials"]),
    ("err.sshIdentityNoPassword", ["身份未设置密码，请到「SSH 凭证」补全", "The identity has no password set — complete it in SSH credentials"]),
    ("err.sshConnectTimeout", ["连接 {host}:{port} 超时（10s 内未完成握手）", "Connecting to {host}:{port} timed out (no handshake within 10s)"]),
    ("err.sshKeyPassphraseHint", ["（若私钥有口令，请在连接设置中填写并保存）", "(if the key has a passphrase, set and save it in the connection settings)"]),
    ("err.sshKeyWrongPassphraseHint", ["（口令可能不正确）", "(the passphrase may be incorrect)"]),
    ("err.sshKeyFileLoadFailed", ["加载私钥 {path} 失败: {err}{hint}", "Failed to load the private key {path}: {err}{hint}"]),
    ("err.sshKeyPemParseFailed", ["解析导入的私钥失败: {err}{hint}", "Failed to parse the imported private key: {err}{hint}"]),
    ("err.sshDefaultKeyMissingUnix", ["未配置私钥且未找到 ~/.ssh 下的默认私钥（id_ed25519 / id_ecdsa / id_rsa）", "No key configured and no default key found under ~/.ssh (id_ed25519 / id_ecdsa / id_rsa)"]),
    ("err.sshDefaultKeyMissingWindows", ["未配置私钥且未找到 .ssh 目录下的默认私钥（id_ed25519 / id_ecdsa / id_rsa）；Windows 版不支持 ssh-agent，请在连接设置中配置私钥路径或改用密码认证", "No key configured and no default key found in .ssh (id_ed25519 / id_ecdsa / id_rsa); the Windows build does not support ssh-agent — configure a key path in the connection settings or use password auth"]),
    ("err.sshDefaultKeyRejectedHint", ["（若私钥有口令请通过 agent 加载，或在连接设置中显式指定）", "(if the key has a passphrase, load it via an agent or specify it explicitly in the connection settings)"]),
    ("err.sshDefaultKeyRejectedHintWin", ["（若私钥有口令，请在连接设置中指定私钥并填写保存口令，或改用密码认证；Windows 版不支持 ssh-agent）", "(if the key has a passphrase, specify the key and save its passphrase in the connection settings, or use password auth; the Windows build does not support ssh-agent)"]),
    ("err.sshDefaultKeysRejected", ["默认私钥均未被服务器接受{hint}", "The server rejected all default keys{hint}"]),
    ("err.sshAgentConnectFailed", ["连接 ssh-agent 失败: {err}", "Failed to connect to ssh-agent: {err}"]),
    ("err.sshAgentListFailed", ["读取 agent 密钥失败: {err}", "Failed to list agent keys: {err}"]),
    ("err.sshAgentNoKeys", ["ssh-agent 中没有已加载的密钥（请先 ssh-add，或在连接设置中指定私钥路径）", "No keys loaded in ssh-agent (run ssh-add first, or specify a key path in the connection settings)"]),
    ("err.sshAgentKeysRejected", ["服务器拒绝了 agent 中的全部密钥", "The server rejected all keys from the agent"]),
    ("err.sshKeyRejected", ["服务器拒绝了该私钥", "The server rejected this private key"]),
    ("err.sshPasswordRejected", ["密码未被服务器接受（密码认证与 keyboard-interactive 均已尝试）", "The password was not accepted by the server (both password auth and keyboard-interactive were tried)"]),
    ("log.sshSessionEstablished", ["SSH 会话已建立（russh）：{host} → 本地端点 {endpoint}", "SSH session established (russh): {host} → local endpoint {endpoint}"]),
    ("err.sshSessionLost", ["SSH 会话意外丢失", "The SSH session was lost unexpectedly"]),
    ("err.sshOpenChannelFailed", ["打开远程会话通道失败: {err}", "Failed to open the remote session channel: {err}"]),
    ("err.sshCommandStartFailed", ["远程命令启动失败: {err}", "Failed to start the remote command: {err}"]),
    ("err.sshCommandTimeout", ["远程命令超时（超过 {timeout}）", "The remote command timed out (over {timeout})"]),
    ("err.sshWriteTimeout", ["写入远程文件超时（超过 {timeout}）", "Writing to the remote file timed out (over {timeout})"]),
    ("log.sshSessionStopped", ["SSH 会话已停止: {id}", "SSH session stopped: {id}"]),
    ("err.sshBindUnixFailed", ["绑定本地 unix socket 失败: {err}", "Failed to bind the local unix socket: {err}"]),
    ("err.sshBindPortFailed", ["绑定本地端口失败: {err}", "Failed to bind the local port: {err}"]),
    ("err.sshLocalPortReadFailed", ["读取本地端口失败: {err}", "Failed to read the local port: {err}"]),
    ("err.sshForwardOpenFailed", ["SSH 转发通道打开失败（检查远程 docker.sock 路径与 sshd AllowTcpForwarding）: {err}", "Failed to open the SSH forwarding channel (check the remote docker.sock path and sshd AllowTcpForwarding): {err}"]),
    ("log.sshTunnelListenEnded", ["SSH 隧道本地监听异常退出: {err}", "The SSH tunnel local listener exited unexpectedly: {err}"]),
    // ---- Docker 连接（conn.rs）----
    ("err.dockerConnectFailed", ["连接 Docker daemon 失败: {err}", "Failed to connect to the Docker daemon: {err}"]),
    ("err.dockerConnectSocketFailed", ["连接 Docker daemon 失败（socket: {path}）: {err}", "Failed to connect to the Docker daemon (socket: {path}): {err}"]),
    ("err.windowsNoLocalDocker", ["Windows 版不支持本地 Docker 连接，请在设置中配置远程连接（SSH / TLS / TCP）", "The Windows build does not support local Docker connections — configure a remote connection (SSH / TLS / TCP) in Settings"]),
    ("err.tlsCertDirRequired", ["TLS 连接需要配置证书目录", "TLS connections require a certificate directory"]),
    ("err.tlsCertMissing", ["证书文件缺失: {path}（证书目录下需要 ca.pem、cert.pem、key.pem）", "Missing certificate file: {path} (the certificate directory must contain ca.pem, cert.pem and key.pem)"]),
    ("err.dockerViaSshFailed", ["经 SSH 隧道连接 Docker daemon 失败: {err}", "Failed to connect to the Docker daemon via the SSH tunnel: {err}"]),
    ("err.unknownConnKind", ["未知连接类型: {kind}", "Unknown connection kind: {kind}"]),
    ("err.connUnreachable", ["连接不可达: {err}", "The connection is unreachable: {err}"]),
    ("log.connTestStart", ["测试连接「{name}」（{kind}）", "Testing connection \"{name}\" ({kind})"]),
    ("log.connTestOk", ["测试连接成功：{ms} ms，Docker {version}", "Connection test OK: {ms} ms, Docker {version}"]),
    ("log.connTestFailed", ["测试连接失败: {err}", "Connection test failed: {err}"]),
    ("err.connNotFound", ["连接配置不存在: {id}", "Connection profile not found: {id}"]),
    ("err.connSwitchFailed", ["切换到「{name}」失败: {err}", "Failed to switch to \"{name}\": {err}"]),
    ("log.connSwitched", ["连接已切换：{name}（{kind}）", "Connection switched: {name} ({kind})"]),
    ("err.resourceNameInvalid", ["{label}名称只能包含字母、数字、下划线、点和中划线，且以字母或数字开头", "The {label} name may only contain letters, digits, underscores, dots and dashes, and must start with a letter or digit"]),
    ("err.unsafeArchivePath", ["归档内出现不安全路径: {path}", "Unsafe path found in the archive: {path}"]),
    // ---- 镜像（images.rs）----
    ("hint.pullRateLimit", ["Docker Hub 匿名拉取额度已用尽：可稍后再试，或在 daemon 侧登录账号提升额度（docker login）", "Docker Hub anonymous pull rate limit exhausted: try again later, or log in on the daemon side to raise the limit (docker login)"]),
    ("hint.pullAuthRequired", ["需要认证：私有仓库镜像请在设置中添加对应仓库凭据（保存后拉取会自动匹配使用）", "Authentication required: add matching registry credentials in Settings for private images (pulls pick them up automatically once saved)"]),
    ("log.pullWithCredential", ["拉取镜像 {ref} 使用凭据「{name}」（{registry}）", "Pulling {ref} with credential \"{name}\" ({registry})"]),
    ("err.list_images_failed", ["获取镜像列表失败: {err}", "Failed to list images: {err}"]),
    ("log.imageRemoved", ["删除镜像 {id}{force}", "Image {id} removed{force}"]),
    ("err.image_remove_failed", ["删除镜像失败: {err}", "Failed to remove image: {err}"]),
    ("err.imageNameRequired", ["请填写镜像名称", "Image name is required"]),
    ("log.imagePullStart", ["拉取镜像 {ref}", "Pulling {ref}"]),
    ("log.imagePullFailed", ["拉取镜像 {ref} 失败: {err}", "Pulling {ref} failed: {err}"]),
    ("log.imagePullCancelled", ["拉取镜像 {ref} 已取消", "Pull of {ref} cancelled"]),
    ("log.imagePullDone", ["拉取镜像 {ref} 完成", "Pull of {ref} finished"]),
    ("log.hintPrefix", ["\n提示：{hint}", "\nHint: {hint}"]),
    ("err.exportPathRequired", ["导出路径不能为空", "Export path is required"]),
    ("err.exportSelectionRequired", ["请选择要导出的镜像", "Select at least one image to export"]),
    ("log.imageExportStart", ["导出镜像 ×{n} → {path}", "Exporting {n} image(s) → {path}"]),
    ("err.exportWriteFailed", ["写入文件失败: {err}", "Failed to write the file: {err}"]),
    ("err.imageExportFailed", ["导出镜像失败: {err}", "Failed to export images: {err}"]),
    ("err.exportFileCreateFailed", ["创建文件失败: {err}", "Failed to create the file: {err}"]),
    ("log.imageExportFailed", ["导出镜像失败（{path}）: {err}", "Image export failed ({path}): {err}"]),
    ("log.imageExportCancelled", ["导出镜像已取消（{path}）", "Image export cancelled ({path})"]),
    ("log.imageExportDone", ["导出镜像完成：{n} 个镜像，{size} → {path}", "Export finished: {n} image(s), {size} → {path}"]),
    ("err.importPathRequired", ["导入路径不能为空", "Import path is required"]),
    ("log.imageImportStart", ["导入镜像：{path}", "Importing images: {path}"]),
    ("err.imageImportFailed", ["导入镜像失败: {err}", "Failed to import images: {err}"]),
    ("err.importFileReadFailed", ["读取文件失败: {err}", "Failed to read the file: {err}"]),
    ("log.imageImportCancelled", ["导入镜像已取消（{path}）", "Image import cancelled ({path})"]),
    ("log.imageImportFailed", ["导入镜像失败（{path}）: {err}", "Image import failed ({path}): {err}"]),
    ("log.imageImportDone", ["导入镜像完成：{path}", "Image import finished: {path}"]),
    ("err.imageRefRequired", ["请填写镜像引用", "Image reference is required"]),
    ("err.imageRefWhitespace", ["镜像引用不能包含空白: {ref}", "Image reference cannot contain whitespace: {ref}"]),
    ("err.digestTagUnsupported", ["暂不支持以 digest（@sha256:…）引用打标签，请使用名称:标签", "Tagging by digest (@sha256:…) is not supported yet — use name:tag"]),
    ("err.imageRefInvalid", ["镜像引用不合法: {ref}", "Invalid image reference: {ref}"]),
    ("log.imageTagged", ["镜像打标签：{id} → {ref}", "Image tagged: {id} → {ref}"]),
    ("err.tag_failed", ["打标签失败: {err}", "Failed to tag image: {err}"]),
    ("log.imageUntagged", ["移除镜像标签：{ref}", "Image tag removed: {ref}"]),
    ("err.untagRefRequired", ["镜像引用不能为空", "Image reference is required"]),
    ("err.untag_failed", ["移除标签失败: {err}", "Failed to remove tag: {err}"]),
    // ---- 推送（push.rs）----
    ("err.repoNameRequired", ["请填写仓库名（如 namespace/myapp）", "Repository name is required (e.g. namespace/myapp)"]),
    ("err.repoNameWhitespace", ["仓库名不能包含空白: {repo}", "Repository name cannot contain whitespace: {repo}"]),
    ("err.repoNameNoScheme", ["仓库名不需要协议前缀，填 namespace/myapp 即可", "The repository name needs no scheme prefix — just namespace/myapp"]),
    ("err.repoNameNoTag", ["仓库名不应包含标签，请把标签填到单独的输入框", "The repository name should not contain a tag — put the tag in its own input"]),
    ("err.repoNameLowercase", ["仓库名必须为小写（Docker 规范）", "The repository name must be lowercase (Docker spec)"]),
    ("err.tagInvalid", ["标签不合法: {tag}", "Invalid tag: {tag}"]),
    ("err.registryHostEmpty", ["仓库地址为空，请检查凭据配置", "The registry address is empty — check the credential config"]),
    ("hint.pushAuthFailed", ["认证失败：请检查用户名与密码/令牌（Harbor 机器人账户需已启用且未过期；阿里云需使用登录账号或仓库固定密码）", "Authentication failed: check the username and password/token (Harbor robot accounts must be enabled and unexpired; Alibaba Cloud needs the login account or a registry-fixed password)"]),
    ("hint.pushDenied", ["无推送权限：Harbor 需项目已存在且账号有写权限；阿里云需命名空间已创建", "Push denied: for Harbor the project must exist and the account need write access; for Alibaba Cloud the namespace must be created"]),
    ("hint.pushInsecureRegistry", ["目标仓库为 HTTP 服务：需在 Docker daemon 的 daemon.json 中将仓库地址加入 insecure-registries 并重启 Docker（应用内\"设置-镜像加速\"旁可编辑 daemon.json）", "The registry is an HTTP service: add the registry address to insecure-registries in the Docker daemon's daemon.json and restart Docker (editable next to Settings → Registry mirrors in the app)"]),
    ("hint.pushTlsFailed", ["TLS 证书校验失败：自签名证书需在 daemon.json 的 insecure-registries 中加入仓库地址，或向系统导入 CA 证书", "TLS certificate verification failed: for self-signed certificates add the registry to insecure-registries in daemon.json, or import a CA certificate into the system"]),
    ("hint.pushUnreachable", ["无法连接仓库：检查网络与仓库地址；远程连接时需远端 Docker 宿主机可访问该仓库", "Cannot reach the registry: check the network and registry address; with a remote connection the remote Docker host must be able to reach it"]),
    ("log.pushFailedWithHint", ["推送失败: {raw}\n提示：{hint}", "Push failed: {raw}\nHint: {hint}"]),
    ("log.pushFailed", ["推送失败: {raw}", "Push failed: {raw}"]),
    ("err.pushSelectionRequired", ["请选择要推送的镜像", "Select at least one image to push"]),
    ("err.pushCredentialMissing", ["仓库凭据不存在或已被删除", "The registry credential does not exist or was deleted"]),
    ("err.pushNoSavedPassword", ["未找到已保存的密码，请到设置中重新编辑该凭据", "No saved password found — edit the credential in Settings"]),
    ("log.pushStart", ["推送镜像 {ref} → {target}", "Pushing {ref} → {target}"]),
    ("err.autotag_failed", ["自动打标签失败: {err}", "Failed to tag automatically: {err}"]),
    ("log.pushCancelled", ["推送镜像 {target} 已取消", "Push of {target} cancelled"]),
    ("log.pushFailedLog", ["推送镜像 {target} 失败: {err}", "Pushing {target} failed: {err}"]),
    ("log.pushDone", ["推送镜像 {target} 完成", "Push of {target} finished"]),
    // ---- 卷 / 网络 / 系统（volumes.rs / networks.rs / system.rs）----
    ("err.list_containers_generic", ["获取容器列表失败: {err}", "Failed to list containers: {err}"]),
    ("err.list_volumes_failed", ["获取卷列表失败: {err}", "Failed to list volumes: {err}"]),
    ("err.disk_usage_generic", ["获取磁盘占用失败: {err}", "Failed to get disk usage: {err}"]),
    ("label.volume", ["卷", "volume"]),
    ("log.volumeCreated", ["创建卷：{name}（驱动 {driver}）", "Volume created: {name} (driver {driver})"]),
    ("err.volume_create_failed", ["创建卷失败: {err}", "Failed to create volume: {err}"]),
    ("log.volumeRemoved", ["删除卷：{name}{force}", "Volume removed: {name}{force}"]),
    ("err.volumeInUsePrune", ["卷 {name} 正在被 {n} 个容器使用，请先卸载相关容器", "Volume {name} is used by {n} container(s) — unmount it from them first"]),
    ("err.volume_remove_failed", ["删除卷失败: {err}", "Failed to remove volume: {err}"]),
    ("err.dockerVersionFailed", ["获取 Docker 版本失败: {err}", "Failed to get the Docker version: {err}"]),
    ("err.dockerInfoFailed", ["获取 Docker 信息失败: {err}", "Failed to get Docker info: {err}"]),
    ("err.runningContainersFailed", ["获取运行中容器失败: {err}", "Failed to get running containers: {err}"]),
    ("err.inspectContainerFailed", ["查看容器详情失败: {err}", "Failed to inspect the container: {err}"]),
    ("err.inspectImageFailed", ["查看镜像详情失败: {err}", "Failed to inspect the image: {err}"]),
    ("err.inspectNetworkFailed", ["查看网络详情失败: {err}", "Failed to inspect the network: {err}"]),
    ("err.inspectVolumeFailed", ["查看卷详情失败: {err}", "Failed to inspect the volume: {err}"]),
    ("err.unknownInspectKind", ["未知 inspect 类型: {kind}", "Unknown inspect kind: {kind}"]),
    ("err.list_networks_failed", ["获取网络列表失败: {err}", "Failed to list networks: {err}"]),
    ("label.network", ["网络", "network"]),
    ("log.networkCreated", ["创建网络：{name}（驱动 {driver}）", "Network created: {name} (driver {driver})"]),
    ("err.network_create_failed", ["创建网络失败: {err}", "Failed to create network: {err}"]),
    ("log.networkRemoved", ["删除网络：{name}", "Network removed: {name}"]),
    ("err.network_remove_failed", ["删除网络失败: {err}", "Failed to remove network: {err}"]),
    ("st.builtInNoDelete", ["内置网络不可删除", "Built-in networks cannot be deleted"]),
    ("log.networkConnected", ["网络 {network} 接入容器 {container}", "Container {container} connected to network {network}"]),
    ("err.network_connect_failed", ["连接网络失败: {err}", "Failed to connect to the network: {err}"]),
    ("log.networkDisconnected", ["网络 {network} 断开容器 {container}{force}", "Container {container} disconnected from network {network}{force}"]),
    ("err.network_disconnect_failed", ["断开网络失败: {err}", "Failed to disconnect from the network: {err}"]),
    // ---- 诊断 / 日志（diagnostics.rs）----
    ("diag.unknownPanicPayload", ["未知 panic（payload 非字符串）", "Unknown panic (payload is not a string)"]),
    ("diag.noCauseCaptured", ["未捕获到原因", "No cause captured"]),
    ("log.lastExitAbnormal", ["上次会话异常退出（{kind}）：{summary}", "Last session exited abnormally ({kind}): {summary}"]),
    ("err.logDirNotInit", ["日志目录未初始化", "The log directory has not been initialized"]),
    ("err.readLogFailed", ["读取日志失败: {err}", "Failed to read logs: {err}"]),
    ("err.logFileNameInvalid", ["非法的日志文件名: {name}", "Invalid log file name: {name}"]),
    ("err.openLogFailed", ["打开日志失败: {err}", "Failed to open the log file: {err}"]),
    ("err.seekLogFailed", ["定位日志失败: {err}", "Failed to seek in the log file: {err}"]),
    ("log.debugLoggingToggled", ["调试日志已{state}", "Debug logging {state}"]),
    ("diag.debugOn2", ["开启", "enabled"]),
    ("diag.debugOff2", ["关闭", "disabled"]),
    ("err.diagStateReadFailed", ["诊断状态读取失败", "Failed to read the diagnostics state"]),
    ("err.logPackFailed", ["打包诊断数据失败: {err}", "Failed to bundle diagnostics data: {err}"]),
    ("err.diagWriteFailed", ["写入诊断包失败: {err}", "Failed to write the diagnostics bundle: {err}"]),
    ("log.diagExported", ["诊断包已导出: {path}", "Diagnostics bundle exported: {path}"]),
    ("err.logCopyFailed", ["导出日志失败: {err}", "Failed to export the log file: {err}"]),
    ("log.logCopied", ["日志 {file} 已导出到 {dest}（{n} 字节）", "Log {file} exported to {dest} ({n} bytes)"]),
    ("log.logCleanupDone", ["日志清理：删除 {n} 个过期日志文件（{size}）", "Log cleanup: removed {n} expired log file(s) ({size})"]),
    // ---- 密钥库（secret_store.rs）----
    ("err.keyringEntryCreateFailed", ["创建钥匙串条目失败: {err}", "Failed to create the keyring entry: {err}"]),
    ("err.keyringWriteFailed", ["写入钥匙串失败: {err}", "Failed to write to the keyring: {err}"]),
    ("err.keyringReadFailed", ["读取钥匙串失败: {err}", "Failed to read from the keyring: {err}"]),
    ("err.keyringDeleteFailed", ["删除钥匙串条目失败: {err}", "Failed to delete the keyring entry: {err}"]),
    ("err.machineUidFailed", ["获取机器标识失败: {err}", "Failed to get the machine identifier: {err}"]),
    ("err.keyFileParseFailed", ["解析密钥文件失败: {err}", "Failed to parse the key file: {err}"]),
    ("err.keyFileReadFailed", ["读取密钥文件失败: {err}", "Failed to read the key file: {err}"]),
    ("err.keyFileSerializeFailed", ["序列化密钥文件失败: {err}", "Failed to serialize the key file: {err}"]),
    ("err.keyFileWriteFailed", ["写入密钥文件失败: {err}", "Failed to write the key file: {err}"]),
    ("err.keyFileSaveFailed", ["保存密钥文件失败: {err}", "Failed to save the key file: {err}"]),
    ("err.encryptFailed", ["加密失败: {err}", "Encryption failed: {err}"]),
    ("err.nonceDecodeFailed", ["解码 nonce 失败: {err}", "Failed to decode the nonce: {err}"]),
    ("err.ciphertextDecodeFailed", ["解码密文失败: {err}", "Failed to decode the ciphertext: {err}"]),
    ("err.decryptWrongMachine", ["解密失败：密钥文件可能来自其他机器或系统重装，请重新录入密码", "Decryption failed: the key file may come from another machine or a reinstalled system — re-enter the password"]),
    ("err.decryptMalformed", ["解密结果异常: {err}", "Unexpected decryption result: {err}"]),
    // ---- GitHub 同步（github_sync.rs）----
    ("sync.reqCloneFailed", ["{what}: 请求体无法克隆以供重试", "{what}: the request body cannot be cloned for retry"]),
    ("sync.reqTimeout", ["{what}: 连接 github.com 超时（网络不稳定或被间歇性阻断，已自动重试 {attempts} 次）。可稍后重试；若本机需要代理访问 GitHub，请设置 HTTPS_PROXY 环境变量后重启应用", "{what}: connecting to github.com timed out (unstable or intermittently blocked network, retried {attempts} times automatically). Try again later; if this machine needs a proxy for GitHub, set the HTTPS_PROXY environment variable and restart the app"]),
    ("sync.reqFailed", ["{what}: {err}", "{what}: {err}"]),
    ("err.noClientId", ["缺少 GitHub OAuth App 的 client_id（构建期 VITE_SYNC_GITHUB_CLIENT_ID）", "Missing the GitHub OAuth App client_id (build-time VITE_SYNC_GITHUB_CLIENT_ID)"]),
    ("log.deviceFlowStart", ["开始 GitHub 设备码授权", "Starting GitHub device-code authorization"]),
    ("sync.whatDeviceCodeReq", ["请求 GitHub device code", "Requesting the GitHub device code"]),
    ("err.responseReadFailed", ["读取响应失败: {err}", "Failed to read the response: {err}"]),
    ("err.deviceFlowFailed", ["GitHub device flow 失败: {status} - {text}", "GitHub device flow failed: {status} - {text}"]),
    ("err.deviceFlowBadJson", ["GitHub device flow 响应不是合法 JSON: {status} - {text}", "The GitHub device flow response is not valid JSON: {status} - {text}"]),
    ("err.deviceFlowParamsMissing", ["缺少 client_id 或 device_code", "Missing client_id or device_code"]),
    ("sync.whatTokenReq", ["请求 GitHub token", "Requesting the GitHub token"]),
    ("err.tokenPollBadJson", ["GitHub token 轮询响应不是合法 JSON: {status} - {text}", "The GitHub token polling response is not valid JSON: {status} - {text}"]),
    ("err.tokenPollFailed", ["GitHub token 轮询失败: {status} - {text}", "GitHub token polling failed: {status} - {text}"]),
    ("err.gistRawUrlInvalid", ["Gist raw URL 必须是 https://gist.githubusercontent.com/ 前缀", "The Gist raw URL must start with https://gist.githubusercontent.com/"]),
    ("sync.whatGistDownload", ["下载 Gist 完整内容", "Downloading the full Gist content"]),
    ("err.gistDownloadFailed", ["下载 Gist 完整内容失败: {status} - {text}", "Failed to download the full Gist content: {status} - {text}"]),
    ("log.tokenSaved", ["GitHub 令牌已保存（{backend}）", "GitHub token saved ({backend})"]),
    ("err.unknownSecretBackend", ["未知的密钥存储位置: {backend}", "Unknown secret storage location: {backend}"]),
    ("log.tokenDeleted", ["GitHub 令牌已删除（断开云同步）", "GitHub token deleted (cloud sync disconnected)"]),
    ("log.syncPasswordSaveFailed", ["保存同步密码失败，本次解锁仅内存持有: {err}", "Failed to save the sync password — it will be held in memory only for this unlock: {err}"]),
    ("log.syncPasswordReadFailed", ["读取记住的同步密码失败: {err}", "Failed to read the remembered sync password: {err}"]),
    ("log.syncPasswordCleared", ["已清除记住的同步密码", "Remembered sync password cleared"]),
    // ---- 编排（compose.rs）----
    ("err.composeCliMissing", ["未检测到 Docker Compose CLI，请先安装（Debian/Ubuntu：sudo apt install docker-compose-plugin）", "Docker Compose CLI not found — install it first (Debian/Ubuntu: sudo apt install docker-compose-plugin)"]),
    ("err.composeCliMissingRemote", ["远程服务器未检测到 Docker Compose CLI，请在服务器上安装（Debian/Ubuntu：sudo apt install docker-compose-plugin）", "Docker Compose CLI not found on the remote server — install it there (Debian/Ubuntu: sudo apt install docker-compose-plugin)"]),
    ("err.remoteFileWriteFailed", ["写入远程文件失败", "Failed to write the remote file"]),
    ("err.remoteFileWriteFailedDetail", ["写入远程文件失败: {detail}", "Failed to write the remote file: {detail}"]),
    ("err.list_containers_generic2", ["获取容器列表失败: {err}", "Failed to list containers: {err}"]),
    ("err.composeProjectContainersNotFound", ["未找到项目 {project} 的容器，无法确定 compose 配置", "No containers found for project {project} — cannot determine its compose config"]),
    ("log.composeDone", ["compose {label} 完成", "compose {label} finished"]),
    ("log.composeFailedExit", ["compose {label} 失败（退出码 {code}）", "compose {label} failed (exit code {code})"]),
    ("log.composeCancelled", ["compose {label} 已取消", "compose {label} cancelled"]),
    ("err.operationCancelled", ["操作已取消", "Operation cancelled"]),
    ("log.composeStartFailed", ["compose {label} 启动失败: {err}", "Failed to start compose {label}: {err}"]),
    ("err.composeStartFailed", ["启动 compose 命令失败: {err}", "Failed to start the compose command: {err}"]),
    ("err.sshOpenChannelFailed2", ["打开远程会话通道失败: {err}", "Failed to open the remote session channel: {err}"]),
    ("err.composeRemoteStartFailed", ["启动远程 compose 失败: {err}", "Failed to start remote compose: {err}"]),
    ("log.trackedSaveFailed", ["保存编排跟踪记录失败: {err}", "Failed to save the compose tracking record: {err}"]),
    ("err.composeConfigLabelMissing", ["项目 {project} 缺少 compose 配置文件标签，无法执行 CLI 操作", "Project {project} has no compose config file label — CLI operations are unavailable"]),
    ("log.composeActionStart", ["compose 项目 {project} 执行 {action}（服务：{services}）", "compose project {project} running {action} (services: {services})"]),
    ("diag.allServices", ["全部", "all"]),
    ("err.composePathRequired", ["请填写 compose 文件路径", "Compose file path is required"]),
    ("err.composeExtRequired", ["请选择 .yml / .yaml 编排文件", "Select a .yml / .yaml compose file"]),
    ("err.composeNameDeriveFailed", ["无法从文件推导项目名，请手动填写", "Cannot derive the project name from the file — enter it manually"]),
    ("log.composeRegistered", ["手动注册编排项目 {project}（{path}）", "Compose project {project} registered manually ({path})"]),
    ("err.composeNotTracked", ["项目 {name} 没有本地跟踪记录", "Project {name} has no local tracking record"]),
    ("err.noScanDirsConfigured", ["当前连接尚未配置扫描目录", "No scan directories configured for the current connection"]),
    ("err.scanResultSaveFailed", ["保存扫描结果失败: {err}", "Failed to save the scan result: {err}"]),
    ("log.scanDone", ["编排扫描完成：发现 {discovered} 个新项目（共 {found} 个文件）", "Compose scan finished: {discovered} new project(s) found ({found} files)"]),
    ("err.composeViewExtRequired", ["仅支持查看 .yml / .yaml 文件", "Only .yml / .yaml files can be viewed"]),
    ("err.fileReadFailed", ["读取文件失败", "Failed to read the file"]),
    ("err.fileTooLarge", ["文件超过 2MB，不予显示", "The file exceeds 2MB and is not displayed"]),
    ("err.notUtf8", ["文件不是有效的 UTF-8 文本", "The file is not valid UTF-8 text"]),
    ("err.fileReadFailedDetail", ["读取文件失败: {err}", "Failed to read the file: {err}"]),
    ("err.composeEditExtRequired", ["仅支持编辑 .yml / .yaml 文件", "Only .yml / .yaml files can be edited"]),
    ("err.fileContentEmpty", ["文件内容不能为空", "The file content cannot be empty"]),
    ("log.composeFileSaving", ["保存 compose 文件：{path}", "Saving compose file: {path}"]),
    ("err.fileTooLargeSave", ["文件超过 2MB，不予保存", "The file exceeds 2MB and is not saved"]),
    ("diag.composeCheckFailed", ["compose 文件校验未通过", "compose file validation failed"]),
    ("diag.saveRemoteFailed", ["保存远程文件失败", "Failed to save the remote file"]),
    ("err.tmpFileWriteFailed", ["写入临时文件失败: {err}", "Failed to write the temp file: {err}"]),
    ("err.syntaxCheckTimeout", ["语法预检超时", "Syntax pre-check timed out"]),
    ("err.syntaxCheckFailed", ["语法预检执行失败: {err}", "The syntax pre-check failed to run: {err}"]),
    ("err.composeValidateFailed", ["compose 文件校验未通过：{err}", "compose file validation failed: {err}"]),
    ("err.backupOriginalFailed", ["备份原文件失败: {err}", "Failed to back up the original file: {err}"]),
    ("err.fileSaveFailed", ["保存文件失败: {err}", "Failed to save the file: {err}"]),
    // ---- 应用更新（app_update.rs）----
    ("log.updateCheckStart", ["检查应用更新（当前 v{version}）", "Checking for app updates (current v{version})"]),
    ("sync.whatUpdateCheck", ["检查应用更新", "Checking for app updates"]),
    ("err.updateNoReleases", ["检查应用更新: 仓库尚未发布任何版本", "Update check: the repository has not published any release yet"]),
    ("err.updateRateLimited", ["检查应用更新: 请求被 GitHub 拒绝（403，匿名请求可能已达限流上限，约 1 小时后恢复）", "Update check: the request was rejected by GitHub (403 — the anonymous rate limit is probably exhausted; it resets in about an hour)"]),
    ("err.updateBadStatus", ["检查应用更新: GitHub 返回 {status}", "Update check: GitHub returned {status}"]),
    ("err.updateParseFailed", ["检查应用更新: 解析响应失败: {err}", "Update check: failed to parse the response: {err}"]),
    ("err.updateNoVersion", ["检查应用更新: GitHub 返回的 release 缺少版本号", "Update check: the GitHub release has no version tag"]),
    ("err.cacheDirFailed", ["获取缓存目录失败: {err}", "Failed to resolve the cache directory: {err}"]),
    ("log.portableLeftoverCleaned", ["已清理便携版替换残留: {path}", "Cleaned up the portable-replace leftover: {path}"]),
    ("log.portableLeftoverCleanFailed", ["清理便携版替换残留失败 {path}: {err}", "Failed to clean up the portable-replace leftover {path}: {err}"]),
    ("log.updatesDirCleaned", ["已清理更新目录残留: {path}", "Cleaned up the update directory leftover: {path}"]),
    ("log.updatesDirCleanFailed", ["清理更新目录失败 {path}: {err}", "Failed to clean up the update directory {path}: {err}"]),
    ("err.updatesDirCreateFailed", ["创建更新目录失败: {err}", "Failed to create the update directory: {err}"]),
    ("err.updatesDirReadFailed", ["读取更新目录失败: {err}", "Failed to read the update directory: {err}"]),
    ("err.downloadUrlInvalid", ["下载更新: 非法的下载链接", "Download update: invalid download URL"]),
    ("err.downloadFileNameInvalid", ["下载更新: 非法的安装包文件名", "Download update: invalid installer file name"]),
    ("log.downloadStart", ["开始下载更新安装包: {file}", "Downloading the update package: {file}"]),
    ("err.downloadNetworkFailed", ["下载更新: {err}", "Download update: {err}"]),
    ("err.downloadBadStatus", ["下载更新: GitHub 返回 {status}", "Download update: GitHub returned {status}"]),
    ("err.downloadTmpCreateFailed", ["下载更新: 创建临时文件失败: {err}", "Download update: failed to create the temp file: {err}"]),
    ("err.downloadWriteFailed", ["下载更新: 写入磁盘失败", "Download update: failed to write to disk"]),
    ("err.downloadSaveFailed", ["下载更新: 落盘失败: {err}", "Download update: failed to finalize the file: {err}"]),
    ("log.downloadDone", ["更新安装包下载完成: {path}", "Update package downloaded: {path}"]),
    ("err.installerMissing", ["安装包不存在，可能已被清理，请重新下载", "The installer is missing — it may have been cleaned up; download it again"]),
    ("err.invalidFilePath", ["非法的文件路径", "Invalid file path"]),
    ("diag.portableManualReplace", ["该发行形态无系统安装器：新版本已下载到 {path}，请手动用它替换当前程序文件后重新打开应用", "This distribution has no system installer: the new version was downloaded to {path} — replace the current program file with it manually and reopen the app"]),
    ("log.installerLaunched", ["拉起更新安装包: {path}", "Launched the update installer: {path}"]),
    ("err.openInstallerFailed", ["打开安装包失败: {err}", "Failed to open the installer: {err}"]),
    ("log.installStart", ["开始应用更新（{form}）: {path}", "Applying the update ({form}): {path}"]),
    ("err.startInstallerFailed", ["启动安装程序失败: {err}", "Failed to start the installer: {err}"]),
    ("err.unknownForm", ["无法识别当前发行形态，请前往下载页手动更新", "Cannot detect this distribution — update manually from the download page"]),
    ("err.formPlatformMismatch", ["发行形态与运行平台不匹配", "The distribution does not match the running platform"]),
    ("err.installTimeout", ["安装超时，请检查 polkit 授权窗口状态", "Installation timed out — check the polkit authorization window"]),
    ("err.installAuthCancelled", ["已取消安装授权", "Installation authorization cancelled"]),
    ("err.installFailed", ["安装更新失败: {err}", "Failed to install the update: {err}"]),
    ("diag.dpkgExitCode", ["dpkg 退出码 {code}", "dpkg exit code {code}"]),
    ("log.installedPkgCleanFailed", ["清理已安装的更新包失败 {path}: {err}", "Failed to clean up the installed update package {path}: {err}"]),
    ("log.installDone", ["更新安装完成，重启应用", "Update installed — restarting the app"]),
    ("err.currentExeFailed", ["定位当前程序失败: {err}", "Failed to locate the current executable: {err}"]),
    ("err.renameOldExeFailed", ["旧程序改名失败: {err}（可能被安全软件占用，请手动更新）", "Failed to rename the old executable: {err} (it may be locked by security software — update manually)"]),
    ("log.portableReplaced", ["便携版已替换为 {path}，拉起新版本", "Portable build replaced with {path} — launching the new version"]),
    ("err.copyNewVersionFailed", ["拷贝新版本失败: {err}（目标目录可能只读，请手动更新）", "Failed to copy the new version: {err} (the target directory may be read-only — update manually)"]),
    ("err.moveNewVersionFailed", ["移入新版本失败: {err}（目标目录可能只读，请手动更新）", "Failed to move the new version in: {err} (the target directory may be read-only — update manually)"]),
    ("err.launchNewVersionFailed", ["拉起新版本失败: {err}", "Failed to launch the new version: {err}"]),
    ("log.newVersionLaunched", ["新版本已拉起，退出当前进程", "New version launched — exiting the current process"]),
    // ---- 容器文件管理（files.rs）----
    ("err.pathEmpty", ["路径不能为空", "The path cannot be empty"]),
    ("err.pathMustBeAbsolute", ["请使用绝对路径（以 / 开头）：{path}", "Use an absolute path (starting with /): {path}"]),
    ("err.pathParentDir", ["路径不能包含 .. 分量", "The path cannot contain .. components"]),
    ("err.containerCmdCreateFailed", ["在容器内创建命令失败: {err}", "Failed to create a command inside the container: {err}"]),
    ("err.containerCmdExecFailed", ["在容器内执行命令失败: {err}", "Failed to execute a command inside the container: {err}"]),
    ("err.containerCmdStreamError", ["容器内命令输出流出错: {err}", "The command output stream inside the container failed: {err}"]),
    ("err.containerCmdResultFailed", ["查询容器内命令结果失败: {err}", "Failed to get the command result from the container: {err}"]),
    ("err.listDirFailed", ["列目录失败（容器需在运行中）: {err}", "Failed to list the directory (the container must be running): {err}"]),
    ("err.chooseSaveLocation", ["请先选择保存位置", "Choose a save location first"]),
    ("log.fileDownloadStart", ["容器 {id} 下载文件：{src} → {dest}", "Container {id}: downloading {src} → {dest}"]),
    ("err.fileTooLargeTransfer", ["文件超过 512MB，暂不支持在应用内传输（可在终端中操作）", "The file exceeds 512MB and cannot be transferred in the app (use a terminal instead)"]),
    ("err.downloadContainerFileFailed", ["下载容器文件失败: {err}", "Failed to download the container file: {err}"]),
    ("err.archiveParseFailed", ["解析归档失败: {err}", "Failed to parse the archive: {err}"]),
    ("err.archiveEntryParseFailed", ["解析归档条目失败: {err}", "Failed to parse the archive entry: {err}"]),
    ("err.mkdirFailedAt", ["创建目录失败（{path}）: {err}", "Failed to create the directory ({path}): {err}"]),
    ("err.mkdirFailed", ["创建目录失败: {err}", "Failed to create the directory: {err}"]),
    ("err.writeFileFailedAt", ["写出文件失败（{path}）: {err}", "Failed to write the file ({path}): {err}"]),
    ("err.writeFileFailedAt2", ["写入文件失败（{path}）: {err}", "Failed to write the file ({path}): {err}"]),
    ("err.chooseFilesToUpload", ["请选择要上传的文件", "Select the files to upload"]),
    ("log.fileUploadStart", ["容器 {id} 上传 {n} 个文件到 {dir}", "Container {id}: uploading {n} file(s) to {dir}"]),
    ("err.pathMissingFileName", ["路径缺少文件名: {path}", "The path is missing a file name: {path}"]),
    ("err.packDirFailed", ["打包目录失败（{path}）: {err}", "Failed to pack the directory ({path}): {err}"]),
    ("err.packFileFailed", ["打包文件失败（{path}）: {err}", "Failed to pack the file ({path}): {err}"]),
    ("err.pathNotFound", ["路径不存在: {path}", "Path does not exist: {path}"]),
    ("err.uploadArchiveFailed", ["生成上传归档失败: {err}", "Failed to build the upload archive: {err}"]),
    ("err.packTaskFailed", ["打包任务失败: {err}", "The packing task failed: {err}"]),
    ("err.uploadTooLarge", ["上传内容超过 512MB，暂不支持在应用内传输（可在终端中操作）", "The upload exceeds 512MB and cannot be transferred in the app (use a terminal instead)"]),
    ("err.uploadToContainerFailed", ["上传到容器失败: {err}", "Failed to upload to the container: {err}"]),
    ("err.cannotDeleteRoot", ["不能删除根目录", "The root directory cannot be deleted"]),
    ("log.fileDelete", ["容器 {id} 删除文件：{path}{recursive}", "Container {id}: deleting {path}{recursive}"]),
    ("log.recursiveSuffix", ["（递归）", " (recursive)"]),
    ("err.deleteFailed", ["删除失败: {err}", "Failed to delete: {err}"]),
    // ---- SSH 凭证存取（ssh_secrets.rs）----
    ("err.unknownSshSecretKind", ["未知的 ssh 凭证类型: {kind}", "Unknown SSH credential type: {kind}"]),
    ("err.syncConnNotFound", ["同步凭证对应的 SSH 连接不存在: {id}", "The SSH connection for this synced credential does not exist: {id}"]),
    ("log.importedConnSecret", ["已导入 SSH 凭证 {id} 的{kind}（{backend}）", "Imported {kind} for SSH connection {id} ({backend})"]),
    ("log.importSkipped", ["{err}，跳过", "{err} — skipped"]),
    ("log.keychainEntryNotLocal", ["钥匙串条目 {id} 不在本机元数据中，跳过该凭证", "Keychain entry {id} is not in the local metadata — skipping this credential"]),
    ("log.importedKeychainSecret", ["已导入钥匙串凭证 {id} 的{kind}（{backend}）", "Imported {kind} for keychain credential {id} ({backend})"]),
    ("log.identityNotLocal", ["身份 {id} 不在本机元数据中，跳过该凭证", "Identity {id} is not in the local metadata — skipping this credential"]),
    ("log.importedIdentityPassword", ["已导入身份 {id} 的密码（{backend}）", "Imported the password for identity {id} ({backend})"]),
    ("log.unknownSshSecretSkipped", ["未知的 ssh 凭证类型: {kind}，跳过", "Unknown SSH credential type: {kind} — skipped"]),
    ("err.unknownSshKeyKind", ["未知的 ssh 密钥类型: {kind}（钥匙串条目请用 save_ssh_key_entry）", "Unknown SSH key type: {kind} (use save_ssh_key_entry for keychain entries)"]),
    ("err.connProfileNotFound", ["连接配置不存在: {id}", "Connection profile not found: {id}"]),
    ("err.onlySshSupportsSecret", ["仅 SSH 连接支持保存密码 / 私钥口令", "Only SSH connections support saving a password / key passphrase"]),
    ("log.connSecretCleared", ["已清除 SSH 连接 {id} 的{kind}密钥", "Cleared the {kind} secret for SSH connection {id}"]),
    ("log.connSecretSaved", ["已保存 SSH 连接 {id} 的{kind}密钥（{backend}）", "Saved the {kind} secret for SSH connection {id} ({backend})"]),
    ("err.pubKeyNotPrivate", ["指向了 .pub 公钥文件，请选择对应的私钥（例如 id_rsa，而不是 id_rsa.pub）", "points to a .pub public key file — select the private key instead (e.g. id_rsa, not id_rsa.pub)"]),
    ("err.readPrivateKeyFailed", ["读取私钥文件失败: {err}", "Failed to read the private key file: {err}"]),
    ("err.notAFile", ["所选路径不是文件", "The selected path is not a file"]),
    ("err.keyFileTooLarge", ["私钥文件过大（>256KB），请确认选择的是正确的私钥文件", "The private key file is too large (>256KB) — make sure you selected the right file"]),
    ("err.readPrivateKeyFailedBinary", ["读取私钥文件失败（含非文本内容?）: {err}", "Failed to read the private key file (non-text content?): {err}"]),
    ("err.notAPrivateKey", ["文件不像私钥（缺少 PEM 头），请确认选择的是私钥文件", "The file does not look like a private key (missing PEM header) — select a private key file"]),
    ("err.keyLabelRequired", ["请填写私钥名称", "Key name is required"]),
    ("err.keychainEntryMissing", ["钥匙串条目不存在: {id}", "Keychain entry does not exist: {id}"]),
    ("err.keyParseFailed", ["私钥解析失败：内容不是有效的私钥，或口令不正确", "Failed to parse the private key: the content is not a valid key, or the passphrase is wrong"]),
    ("err.selectKeyFile", ["请选择要导入的私钥文件", "Select the private key file to import"]),
    ("log.keySaved", ["已保存钥匙串私钥「{label}」（{id}）", "Keychain key \"{label}\" saved ({id})"]),
    ("err.keyInUseRefs", ["该私钥正被 {n} 个连接引用，请先在连接设置中改用其他私钥来源", "This key is referenced by {n} connection(s) — switch them to another key source first"]),
    ("log.keyDeleted", ["已删除钥匙串私钥 {id}", "Keychain key {id} deleted"]),
    ("err.identityNameRequired", ["请填写身份名称", "Identity name is required"]),
    ("err.usernameRequired2", ["请填写用户名", "Username is required"]),
    ("err.identityMissing", ["身份不存在: {id}", "Identity does not exist: {id}"]),
    ("err.linkedKeyMissing", ["关联的钥匙串私钥不存在: {id}", "The linked keychain key does not exist: {id}"]),
    ("err.identityNeedsPasswordOrKey", ["请填写密码，或关联一把钥匙串私钥", "Enter a password or link a keychain key"]),
    ("log.identitySaved", ["已保存 SSH 身份「{label}」（{id}）", "SSH identity \"{label}\" saved ({id})"]),
    ("err.identityInUseRefs", ["该身份正被 {n} 个连接引用，请先在连接设置中解除", "This identity is referenced by {n} connection(s) — remove it from them first"]),
    ("log.identityDeleted", ["已删除 SSH 身份 {id}", "SSH identity {id} deleted"]),
    ("log.keychainMigrationSaveFailed", ["钥匙串迁移结果保存失败: {err}", "Failed to save the keychain migration result: {err}"]),
    ("log.keychainMigrationDone", ["钥匙串迁移完成：{n} 个连接", "Keychain migration finished: {n} connection(s)"]),
    ("diag.keyLabelSuffix", ["{name} 的私钥", "{name}'s private key"]),
    ("log.embeddedKeyMigrated", ["已迁移连接 {id} 的导入式私钥到钥匙串", "Migrated the embedded key of connection {id} to the keychain"]),
    ("log.removedConnSecretsCleanFailed", ["清理已删除 SSH 连接 {id} 的密钥失败: {err}", "Failed to clean up the secrets of deleted SSH connection {id}: {err}"]),
    ("log.removedConnSecretsCleaned", ["已清理已删除 SSH 连接 {id} 的密钥", "Cleaned up the secrets of deleted SSH connection {id}"]),
    // ---- 终端会话（exec.rs）----
    ("log.terminalOpen", ["容器 {id} 打开终端（{shell}）", "Container {id}: opening a terminal ({shell})"]),
    ("err.terminalCreateFailed", ["创建终端会话失败: {err}", "Failed to create the terminal session: {err}"]),
    ("err.terminalStartFailed", ["终端启动失败: {err}", "The terminal failed to start: {err}"]),
    ("err.connSwitched", ["连接已切换", "The connection was switched"]),
    ("err.connInterrupted", ["连接中断: {err}", "The connection was interrupted: {err}"]),
    ("err.processExited", ["进程已退出", "The process has exited"]),
    ("err.terminalSessionGone", ["终端会话不存在或已关闭", "The terminal session does not exist or was closed"]),
    ("err.terminalWriteFailed", ["写入终端失败: {err}", "Failed to write to the terminal: {err}"]),
    ("err.terminalResizeFailed", ["调整终端尺寸失败: {err}", "Failed to resize the terminal: {err}"]),
    // ---- 容器日志导出（logs.rs）----
    ("err.exportPathRequired2", ["导出路径不能为空", "Export path is required"]),
    ("log.containerLogExportStart", ["容器 {id} 导出日志（tail {tail}）→ {path}", "Container {id}: exporting logs (tail {tail}) → {path}"]),
    ("err.readContainerLogsFailed", ["读取容器日志失败: {err}", "Failed to read the container logs: {err}"]),
    ("err.writeFileFailed", ["写入文件失败: {err}", "Failed to write the file: {err}"]),
    // ---- 主机指纹存储（ssh_known_hosts.rs）----
    ("err.hostKeysSerializeFailed", ["序列化主机指纹失败: {err}", "Failed to serialize the host keys: {err}"]),
    ("err.hostKeysWriteFailed", ["写入主机指纹失败: {err}", "Failed to write the host keys: {err}"]),
    ("err.hostKeysSaveFailed", ["保存主机指纹失败: {err}", "Failed to save the host keys: {err}"]),
    ("log.hostKeyAccepted", ["已接受主机 {dest}（{algo}）的指纹 {fp}", "Accepted fingerprint {fp} for host {dest} ({algo})"]),
    // ---- 启动日志（lib.rs）----
    ("log.appStarted", ["DockPilot v{version} 启动（{os} {arch}，日志级别 {level}）", "DockPilot v{version} started ({os} {arch}, log level {level})"]),
    ("log.scheduledLogCleanup", ["日志定时清理：删除 {n} 个过期文件（{size}）", "Scheduled log cleanup: removed {n} expired file(s) ({size})"]),
    ("log.scheduledLogCleanupFailed", ["日志定时清理失败: {err}", "Scheduled log cleanup failed: {err}"]),
    ("log.connInit", ["初始化连接：{name}（{kind}）", "Initializing connection: {name} ({kind})"]),
    ("log.connInitFallback", ["未找到活跃连接配置，使用默认本地连接", "No active connection profile found — using the default local connection"]),
    ("log.sshKeychainMigrated", ["SSH 钥匙串迁移完成：{n} 个连接", "SSH keychain migration finished: {n} connection(s)"]),
    ("log.appExited", ["DockPilot 正常退出", "DockPilot exited normally"]),
    // ---- daemon.json 编辑（daemon_config.rs，仅 Linux）----
    ("err.daemonReadFailed", ["读取 {path} 失败: {err}", "Failed to read {path}: {err}"]),
    ("diag.jsonSyntaxError", ["JSON 语法错误: {err}", "JSON syntax error: {err}"]),
    ("diag.topLevelObject", ["顶层必须是 JSON 对象（花括号形式）", "The top level must be a JSON object"]),
    ("diag.mirrorsMustBeArray", ["registry-mirrors 必须是字符串数组", "registry-mirrors must be an array of strings"]),
    ("diag.mirrorsEmptyEntry", ["registry-mirrors 存在空字符串条目，daemon 将忽略", "registry-mirrors contains empty entries — the daemon will ignore them"]),
    ("diag.hostsKeyWarning", ["检测到 hosts 键：systemd 部署的 Docker 与其 ExecStart 的 -H 参数冲突，可能导致 daemon 无法启动", "A hosts key was detected: it conflicts with the -H argument in systemd's ExecStart for Docker and may prevent the daemon from starting"]),
    ("diag.keyChangeWarning", ["{key} 与当前配置不同：切换后既有的镜像/容器可能不可见，请确认后再应用", "{key} differs from the current config: existing images/containers may become invisible after switching — review before applying"]),
    ("diag.dockerdValidateFailed", ["dockerd 校验失败: {combined}", "dockerd validation failed: {combined}"]),
    ("err.linuxOnly", ["该功能仅支持 Linux 本机 Docker", "This feature only supports local Docker on Linux"]),
    ("err.tmpWriteFailed", ["写入临时文件失败: {err}", "Failed to write the temp file: {err}"]),
    ("err.pkexecStartFailed", ["无法启动 pkexec: {err}（请确认系统安装了 polkit）", "Failed to start pkexec: {err} (make sure polkit is installed)"]),
    ("log.authCancelled", ["已取消授权，未修改配置", "Authorization cancelled — config unchanged"]),
    ("log.daemonJsonWriteFailed", ["daemon.json 写入失败：{stderr}", "daemon.json write failed: {stderr}"]),
    ("err.daemonJsonWriteFailed2", ["写入 daemon.json 失败: {stderr}（可在下方改用终端命令手动执行）", "Failed to write daemon.json: {stderr} (use the terminal command below instead)"]),
    ("log.daemonJsonWritten", ["daemon.json 已写入（{what}）", "daemon.json written ({what})"]),
    ("diag.bakNote", ["原文件已备份为 {bak}", "The original file was backed up as {bak}"]),
    ("diag.newConfig", ["新建配置", "new config"]),
    ("log.dockerRestartStart", ["重启 Docker 服务（systemctl restart docker）", "Restarting the Docker service (systemctl restart docker)"]),
    ("err.dockerRestartTimeout", ["重启超时，请检查 systemd 状态", "Restart timed out — check the systemd status"]),
    ("err.dockerRestartFailed", ["重启 Docker 失败: {err}", "Failed to restart Docker: {err}"]),
    ("log.dockerRestarted", ["Docker 服务已重启", "Docker service restarted"]),
    ("err.mirrorUrlEmpty", ["地址为空", "The address is empty"]),
    ("err.mirrorUnreachable", ["{url} 不可达: {err}", "{url} is unreachable: {err}"]),
    ("log.mirrorSpeedTest", ["镜像源测速：{url} → {ms} ms", "Mirror speed test: {url} → {ms} ms"]),
    ("log.closeWindow", ["关闭窗口：{action}{remember}", "Window closed: {action}{remember}"]),
    ("log.closeWindowRemembered", ["（记住选择）", " (remembered)"]),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_setting_only_en_is_english() {
        assert_eq!(Lang::from_setting("en"), Lang::En);
        assert_eq!(Lang::from_setting("zh"), Lang::Zh);
        assert_eq!(Lang::from_setting("system"), Lang::Zh);
        assert_eq!(Lang::from_setting(""), Lang::Zh);
    }

    #[test]
    fn t_returns_registered_message_by_lang() {
        assert_eq!(t_of(Lang::Zh, "tray.show"), "显示 DockPilot");
        assert_eq!(t_of(Lang::En, "tray.show"), "Show DockPilot");
        // 未登记的 key 原样返回（迁移期渐进替换的兜底）
        assert_eq!(t_of(Lang::En, "not.registered"), "not.registered");
    }

    #[test]
    fn msg_table_keys_unique_and_translations_nonempty() {
        let mut seen = std::collections::HashSet::new();
        for (key, texts) in MSGS {
            assert!(seen.insert(*key), "消息 key 重复: {key}");
            assert!(!key.is_empty());
            for text in texts {
                assert!(!text.is_empty(), "消息 {key} 存在空翻译");
            }
        }
    }

    #[test]
    fn msg_table_placeholders_are_named_only() {
        // interpolate 只替换 {name} 命名占位符；位置占位符 {} 会原样输出成字面量，
        // 这里守住消息表不混入位置占位符（真实 bug 曾出现过）
        for (key, texts) in MSGS {
            for text in texts {
                for (i, c) in text.char_indices() {
                    if c == '{' {
                        let rest = &text[i + 1..];
                        let name_end = rest.find('}').expect("消息含未闭合的 {{: {key}");
                        let name = &rest[..name_end];
                        assert!(
                            !name.is_empty()
                                && name
                                    .chars()
                                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_'),
                            "消息 {key} 存在位置占位符或非法占位符名: {name:?}"
                        );
                    }
                }
            }
        }
    }
}
