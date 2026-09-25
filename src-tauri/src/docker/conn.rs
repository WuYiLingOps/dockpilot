use std::path::Path;
use std::sync::RwLock;

use bollard::{API_DEFAULT_VERSION, Docker};
use serde::Serialize;

use crate::docker::tunnel;
use crate::settings::{self, ConnectionProfile};

/// 命令层统一错误类型：字符串直接返回给前端展示
pub type CmdResult<T> = Result<T, String>;

/// 日常命令的 bollard 超时（秒）
const TIMEOUT: u64 = 120;
/// 测试/切换连接时的连通性验证超时（秒），避免不可达地址长时间阻塞 UI
const PROBE_TIMEOUT: u64 = 8;

/// 当前活跃连接：profile 为原始配置；ssh 类型经本地隧道连接，隧道本地端点记录在
/// tunnel_endpoint（unix 为 socket 路径，windows 为 127.0.0.1:port，
/// compose CLI 等子进程复用同一条隧道）
#[derive(Debug, Clone)]
pub struct ActiveConn {
    pub profile: ConnectionProfile,
    pub tunnel_endpoint: Option<String>,
}

impl ActiveConn {
    pub fn new(profile: ConnectionProfile) -> Self {
        Self {
            profile,
            tunnel_endpoint: None,
        }
    }

    pub fn effective_socket(&self) -> String {
        match self.profile.kind.as_str() {
            "local" => {
                if self.profile.socket_path.is_empty() {
                    "/var/run/docker.sock".to_string()
                } else {
                    self.profile.socket_path.clone()
                }
            }
            "ssh" => self.tunnel_endpoint.clone().unwrap_or_default(),
            _ => String::new(),
        }
    }
}

/// 连接状态：current 为当前配置（gen 代数随每次切换递增），docker 为同代连接缓存。
/// 代数用于丢弃切换期间仍在惰性建连的过期结果，避免旧连接覆盖新连接。
#[derive(Default)]
struct ConnState {
    current: Option<(u64, ActiveConn)>,
    docker: Option<(u64, Docker)>,
}

static STATE: RwLock<ConnState> = RwLock::new(ConnState {
    current: None,
    docker: None,
});

/// 启动时初始化活跃连接（setup 中调用，此后由 switch_connection 维护）
pub fn init_active(profile: ConnectionProfile) {
    let mut w = STATE.write().unwrap();
    w.current = Some((0, ActiveConn::new(profile)));
    w.docker = None;
}

/// 当前活跃连接的快照（未初始化时回落默认本地连接）
pub fn active() -> ActiveConn {
    let g = STATE.read().unwrap();
    g.current
        .as_ref()
        .map(|(_, c)| c.clone())
        .unwrap_or_else(|| ActiveConn::new(ConnectionProfile::default_local()))
}

/// 获取当前 Docker 连接（惰性建连并缓存；切换后自动指向新连接）
pub async fn docker() -> CmdResult<Docker> {
    {
        let g = STATE.read().unwrap();
        if let Some((gen, _)) = &g.current {
            if let Some((gen_d, d)) = &g.docker {
                if gen_d == gen {
                    return Ok(d.clone());
                }
            }
        }
    }
    let (gen, conn) = {
        let g = STATE.read().unwrap();
        match &g.current {
            Some((gen, c)) => (*gen, c.clone()),
            None => (0, ActiveConn::new(ConnectionProfile::default_local())),
        }
    };
    let (d, tunnel_endpoint) = build_conn(&conn, TIMEOUT).await?;
    // 仅当活跃连接未在建连期间被切换时才缓存
    let mut w = STATE.write().unwrap();
    if let Some((cur_gen, c)) = w.current.as_mut() {
        if *cur_gen == gen {
            c.tunnel_endpoint = tunnel_endpoint;
            w.docker = Some((gen, d.clone()));
        }
    }
    Ok(d)
}

/// 连接错误统一包装
fn build_err(e: bollard::errors::Error) -> String {
    format!("连接 Docker daemon 失败: {e}")
}

/// 按连接类型构建 bollard 连接；ssh 先建立/复用本地 SSH 隧道再连接。
/// 返回 (连接, 隧道本地端点)。
pub async fn build_conn(conn: &ActiveConn, timeout: u64) -> CmdResult<(Docker, Option<String>)> {
    let p = &conn.profile;
    match p.kind.as_str() {
        // 本地连接依赖 unix socket，Windows 版不支持本地 Docker（含 WSL），仅提供远程连接
        "local" => {
            #[cfg(unix)]
            {
                let path = conn.effective_socket();
                let d = Docker::connect_with_socket(&path, timeout, API_DEFAULT_VERSION)
                    .map_err(|e| format!("连接 Docker daemon 失败（socket: {path}）: {e}"))?;
                Ok((d, None))
            }
            #[cfg(windows)]
            {
                Err(
                    "Windows 版不支持本地 Docker 连接，请在设置中配置远程连接（SSH / TLS / TCP）"
                        .into(),
                )
            }
        }
        "tcp" => {
            let d = Docker::connect_with_http(&format!("tcp://{}", p.host), timeout, API_DEFAULT_VERSION)
                .map_err(build_err)?;
            Ok((d, None))
        }
        "tls" => {
            let dir = Path::new(&p.cert_path);
            if p.cert_path.is_empty() {
                return Err("TLS 连接需要配置证书目录".into());
            }
            let (key, cert, ca) = (dir.join("key.pem"), dir.join("cert.pem"), dir.join("ca.pem"));
            for f in [&key, &cert, &ca] {
                if !f.exists() {
                    return Err(format!(
                        "证书文件缺失: {}（证书目录下需要 ca.pem、cert.pem、key.pem）",
                        f.display()
                    ));
                }
            }
            let d = Docker::connect_with_ssl(
                &format!("tcp://{}", p.host),
                &key,
                &cert,
                &ca,
                timeout,
                API_DEFAULT_VERSION,
            )
            .map_err(build_err)?;
            Ok((d, None))
        }
        "ssh" => {
            // 本地端点：unix 为 socket 文件路径，windows 为 127.0.0.1:port
            let endpoint = tunnel::ensure(p).await?;
            #[cfg(unix)]
            {
                let d = Docker::connect_with_socket(&endpoint, timeout, API_DEFAULT_VERSION)
                    .map_err(|e| format!("经 SSH 隧道连接 Docker daemon 失败: {e}"))?;
                Ok((d, Some(endpoint)))
            }
            #[cfg(windows)]
            {
                let d = Docker::connect_with_http(
                    &format!("tcp://{endpoint}"),
                    timeout,
                    API_DEFAULT_VERSION,
                )
                .map_err(|e| format!("经 SSH 隧道连接 Docker daemon 失败: {e}"))?;
                Ok((d, Some(endpoint)))
            }
        }
        other => Err(format!("未知连接类型: {other}")),
    }
}

/// 连通性验证：实际发起 version 请求（各传输的建连都是惰性的，必须发请求才能暴露不可达）
async fn probe(conn: &ActiveConn) -> Result<(u128, String), String> {
    let start = std::time::Instant::now();
    let (d, _) = build_conn(conn, PROBE_TIMEOUT).await?;
    let v = d
        .version()
        .await
        .map_err(|e| format!("连接不可达: {e}"))?;
    Ok((start.elapsed().as_millis(), v.version.unwrap_or_default()))
}

/// 测试连接结果
#[derive(Debug, Serialize)]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub version: String,
    pub error: String,
}

/// 测试任意连接配置（不落盘、不影响当前连接）
#[tauri::command]
pub async fn test_connection(profile: ConnectionProfile) -> ConnectionTestResult {
    let conn = ActiveConn::new(profile);
    match probe(&conn).await {
        Ok((ms, version)) => {
            // 测试用的 ssh 隧道即时回收（若与当前活跃连接同 id 则保留）
            if conn.profile.kind == "ssh" && active().profile.id != conn.profile.id {
                tunnel::stop(&conn.profile.id);
            }
            ConnectionTestResult {
                ok: true,
                latency_ms: Some(u64::try_from(ms).unwrap_or(u64::MAX)),
                version,
                error: String::new(),
            }
        }
        Err(e) => {
            if conn.profile.kind == "ssh" && active().profile.id != conn.profile.id {
                tunnel::stop(&conn.profile.id);
            }
            ConnectionTestResult {
                ok: false,
                latency_ms: None,
                version: String::new(),
                error: e,
            }
        }
    }
}

/// 切换连接：验证可达 → 清理旧连接资源 → 替换连接与缓存 → 重启事件监听 → 持久化
#[tauri::command]
pub async fn switch_connection(app: tauri::AppHandle, id: String) -> CmdResult<ConnectionProfile> {
    use tauri::Manager;

    let s = settings::load(&app);
    let profile = settings::find_connection(&s, &id)
        .cloned()
        .ok_or_else(|| format!("连接配置不存在: {id}"))?;

    let conn = ActiveConn::new(profile.clone());
    probe(&conn).await.map_err(|e| {
        if profile.kind == "ssh" && active().profile.id != profile.id {
            tunnel::stop(&profile.id);
        }
        format!("切换到「{}」失败: {e}", profile.name)
    })?;

    // 验证通过后按日常超时重建正式连接（探测连接的超时偏短，不适合留给命令层）
    let (d, tunnel_endpoint) = build_conn(&conn, TIMEOUT).await?;

    // 清理旧连接的资源：所有长驻流、终端会话、其他 ssh 隧道
    app.state::<super::state::Streams>().cancel_all();
    app.state::<super::state::ExecSessions>().clear().await;
    tunnel::stop_others(&profile.id);

    let mut w = STATE.write().unwrap();
    let gen = w.current.as_ref().map(|(g, _)| g + 1).unwrap_or(1);
    w.current = Some((
        gen,
        ActiveConn {
            profile: profile.clone(),
            tunnel_endpoint,
        },
    ));
    w.docker = Some((gen, d));
    drop(w);

    // 重启全局事件监听（旧任务持有旧连接句柄）
    super::events::start_global_listener(
        app.state::<tokio::sync::broadcast::Sender<crate::docker::dto::DockerEventDto>>()
            .inner()
            .clone(),
    );

    // 持久化 active_id（整包读改写，保留其他设置）
    let mut s = settings::load(&app);
    s.active_connection_id = profile.id.clone();
    settings::save(&app, &s)?;

    Ok(profile)
}

/// compose 等 docker CLI 子进程所需的环境变量：与 bollard 连接指向同一 daemon。
/// ssh 复用本地隧道（认证与密钥配置与 bollard 保持一致）。
pub fn cli_env(conn: &ActiveConn) -> Vec<(String, String)> {
    let p = &conn.profile;
    match p.kind.as_str() {
        "local" => vec![("DOCKER_HOST".into(), format!("unix://{}", conn.effective_socket()))],
        "tcp" => vec![("DOCKER_HOST".into(), format!("tcp://{}", p.host))],
        "tls" => vec![
            ("DOCKER_HOST".into(), format!("tcp://{}", p.host)),
            ("DOCKER_CERT_PATH".into(), p.cert_path.clone()),
            ("DOCKER_TLS_VERIFY".into(), "1".into()),
        ],
        "ssh" => match &conn.tunnel_endpoint {
            // 隧道端点形态随平台不同：unix 为 socket 路径，windows 为本地 TCP 端口
            #[cfg(unix)]
            Some(sock) => vec![("DOCKER_HOST".into(), format!("unix://{sock}"))],
            #[cfg(windows)]
            Some(endpoint) => vec![("DOCKER_HOST".into(), format!("tcp://{endpoint}"))],
            // 隧道尚未建立时退回 docker CLI 原生 ssh 传输（用用户自己的 ssh 配置）
            None => vec![("DOCKER_HOST".into(), format!("ssh://{}", p.host))],
        },
        _ => vec![],
    }
}

/// 卷/网络名称约束：[a-zA-Z0-9][a-zA-Z0-9_.-]*，与 docker CLI 一致；
/// 提前校验以给出中文可读错误，其余非法值由 daemon 兜底拒绝
pub fn validate_resource_name(name: &str, label: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let valid = match chars.next() {
        Some(c) => {
            c.is_ascii_alphanumeric()
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        }
        None => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "{label}名称只能包含字母、数字、下划线、点和中划线，且以字母或数字开头"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_env_per_kind() {
        let local = ActiveConn::new(ConnectionProfile::default_local());
        assert_eq!(
            cli_env(&local),
            vec![("DOCKER_HOST".into(), "unix:///var/run/docker.sock".into())]
        );

        let custom = ActiveConn::new(ConnectionProfile {
            kind: "local".into(),
            socket_path: "/tmp/my.sock".into(),
            ..Default::default()
        });
        assert_eq!(
            cli_env(&custom),
            vec![("DOCKER_HOST".into(), "unix:///tmp/my.sock".into())]
        );

        let tcp = ActiveConn::new(ConnectionProfile {
            kind: "tcp".into(),
            host: "10.0.0.5:2375".into(),
            ..Default::default()
        });
        assert_eq!(
            cli_env(&tcp),
            vec![("DOCKER_HOST".into(), "tcp://10.0.0.5:2375".into())]
        );

        let tls = ActiveConn::new(ConnectionProfile {
            kind: "tls".into(),
            host: "10.0.0.5:2376".into(),
            cert_path: "/certs".into(),
            ..Default::default()
        });
        assert_eq!(
            cli_env(&tls),
            vec![
                ("DOCKER_HOST".into(), "tcp://10.0.0.5:2376".into()),
                ("DOCKER_CERT_PATH".into(), "/certs".into()),
                ("DOCKER_TLS_VERIFY".into(), "1".into()),
            ]
        );

        // ssh 隧道端点形态随平台不同（unix 为 socket 路径、windows 为本地 TCP 端口），仅 unix 断言
        #[cfg(unix)]
        {
            let mut ssh = ActiveConn::new(ConnectionProfile {
                kind: "ssh".into(),
                host: "root@10.0.0.5".into(),
                ..Default::default()
            });
            ssh.tunnel_endpoint = Some("/tmp/tunnel.sock".into());
            assert_eq!(
                cli_env(&ssh),
                vec![("DOCKER_HOST".into(), "unix:///tmp/tunnel.sock".into())]
            );
        }
    }

    #[test]
    fn active_falls_back_to_default_local() {
        // 未初始化时应回落默认本地连接，而不是 panic
        let conn = active();
        assert_eq!(conn.profile.kind, "local");
        assert_eq!(conn.effective_socket(), "/var/run/docker.sock");
    }
}
