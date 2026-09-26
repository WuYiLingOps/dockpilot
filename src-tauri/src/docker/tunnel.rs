use std::collections::HashMap;
#[cfg(unix)]
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use tokio::process::{Child, Command};

use crate::settings::ConnectionProfile;

use super::conn::CmdResult;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Windows 下优先使用系统 OpenSSH，避免命中 WindowsApps 的 ssh 应用别名。
/// 那个别名会弹出窗口并立即退出，测试结果无法回到界面。
#[cfg(windows)]
fn ssh_program() -> CmdResult<std::path::PathBuf> {
    let system = std::path::PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe");
    if system.is_file() {
        return Ok(system);
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(';') {
            if dir.to_ascii_lowercase().contains("windowsapps") {
                continue;
            }
            let candidate = std::path::Path::new(dir).join("ssh.exe");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("未找到 OpenSSH 客户端。请在「设置 → 应用 → 可选功能」中启用 OpenSSH 客户端后重试".into())
}

#[cfg(unix)]
fn ssh_program() -> CmdResult<&'static str> {
    Ok("ssh")
}

/// 活跃的 SSH 隧道：profile_id → 子进程 + 本地端点。
/// 隧道进程随切换/应用退出显式回收，避免遗留孤儿 ssh。
static TUNNELS: LazyLock<std::sync::Mutex<HashMap<String, Tunnel>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// 隧道的本地端点：unix 为 socket 文件路径（bollard/compose CLI 经 unix:// 使用），
/// windows 为 127.0.0.1:port（Windows OpenSSH 不支持本地 unix socket 转发，本地侧走 TCP）
struct Tunnel {
    child: Child,
    #[cfg(unix)]
    socket: PathBuf,
    #[cfg(windows)]
    port: u16,
}

fn tunnels() -> std::sync::MutexGuard<'static, HashMap<String, Tunnel>> {
    TUNNELS.lock().unwrap_or_else(|e| e.into_inner())
}

/// 隧道本地端点的对外表示（unix 为 socket 路径，windows 为 127.0.0.1:port）
#[cfg(unix)]
fn endpoint_of(t: &Tunnel) -> String {
    t.socket.to_string_lossy().into_owned()
}

#[cfg(windows)]
fn endpoint_of(t: &Tunnel) -> String {
    format!("127.0.0.1:{}", t.port)
}

/// 确保 profile 的 SSH 隧道可用，返回本地端点。
/// 复用已有隧道；进程意外退出时自动重建。
pub async fn ensure(p: &ConnectionProfile) -> CmdResult<String> {
    {
        let mut map = tunnels();
        if let Some(t) = map.get_mut(&p.id) {
            match t.child.try_wait() {
                // 仍在运行：直接复用
                Ok(None) => return Ok(endpoint_of(t)),
                // 已退出或状态异常：清理后重建
                _ => {}
            }
        }
        map.remove(&p.id);
    }
    start(p).await
}

/// 远端 daemon socket 的默认路径（远程主机为 Linux）
fn remote_socket(p: &ConnectionProfile) -> &str {
    if p.remote_socket.is_empty() {
        "/var/run/docker.sock"
    } else {
        &p.remote_socket
    }
}

/// 探测一个空闲的本地 TCP 端口：bind 127.0.0.1:0 读取分配端口后立即释放。
/// 释放到 ssh 实际绑定之间存在微小竞态窗口；冲突时 ssh 因 ExitOnForwardFailure 退出并报错，可重试
#[cfg(windows)]
fn free_local_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// 本地端口是否已被 ssh 监听（转发就绪）
#[cfg(windows)]
fn tcp_ready(port: u16) -> bool {
    let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// ssh 客户端缺失时的错误提示按平台给出安装指引
#[cfg(unix)]
fn spawn_ssh_err(e: std::io::Error) -> String {
    format!("启动 SSH 客户端失败（请确认系统已安装 ssh）: {e}")
}

#[cfg(windows)]
fn spawn_ssh_err(e: std::io::Error) -> String {
    format!(
        "启动 SSH 客户端失败（Windows 可在「设置 → 应用 → 可选功能」中启用 OpenSSH 客户端）: {e}"
    )
}

/// 组装 ssh 选项参数（除程序名、目标主机与 stdio 之外的固定部分），纯函数便于单测。
/// -N 不执行远端命令；ExitOnForwardFailure 保证转发失败立即退出；
/// accept-new 自动接受新主机密钥（变更仍拒绝）；BatchMode 禁交互式密码提示（GUI 内无法输入）
fn build_args(p: &ConnectionProfile, forward: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-N".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-L".into(),
        forward.into(),
    ];
    let key_path = p.key_path.trim();
    if !key_path.is_empty() {
        args.push("-i".into());
        args.push(key_path.into());
    }
    let jump = p.jump_host.trim();
    if !jump.is_empty() {
        args.push("-J".into());
        args.push(jump.into());
    }
    args
}

async fn start(p: &ConnectionProfile) -> CmdResult<String> {
    let remote = remote_socket(p);

    // 平台各自的本地端点与对应 -L 转发规格（本地侧：unix 为 socket 文件，windows 为 TCP 端口）
    #[cfg(unix)]
    let local = {
        let socket = std::env::temp_dir().join(format!("dockpilot-tunnel-{}.sock", p.id));
        // 清理上次残留的 socket 文件（转发建立后由 ssh 重新创建）
        let _ = std::fs::remove_file(&socket);
        socket
    };
    #[cfg(windows)]
    let local = free_local_port().map_err(|e| format!("探测本地空闲端口失败: {e}"))?;

    #[cfg(unix)]
    let forward = format!("{}:{remote}", local.display());
    #[cfg(windows)]
    let forward = format!("127.0.0.1:{local}:{remote}");

    let key_path = p.key_path.trim();
    if key_path.to_ascii_lowercase().ends_with(".pub") {
        return Err(
            "私钥路径指向了 .pub 公钥文件，请改用对应的私钥（例如 id_rsa，而不是 id_rsa.pub）"
                .into(),
        );
    }

    let mut cmd = Command::new(ssh_program()?);
    cmd.args(build_args(p, &forward))
        .arg(&p.host)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| spawn_ssh_err(e))?;

    // 捕获 stderr，失败时把 ssh 的诊断信息带回给前端
    let stderr = child.stderr.take();
    let stderr_task = tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = String::new();
        if let Some(mut s) = stderr {
            let _ = s.read_to_string(&mut buf).await;
        }
        buf
    });

    // 等待转发就绪：unix 看本地 socket 文件出现，windows 看本地 TCP 可连
    // （ExitOnForwardFailure 保证监听出现即转发就绪）
    for _ in 0..60 {
        match child.try_wait() {
            Ok(Some(status)) => {
                let msg = stderr_task.await.unwrap_or_default();
                return Err(format!("SSH 连接失败（{status}）: {}", stderr_tail(&msg)));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("SSH 进程异常: {e}")),
        }
        #[cfg(unix)]
        let ready = local.exists();
        #[cfg(windows)]
        let ready = tcp_ready(local);
        if ready {
            #[cfg(unix)]
            let t = Tunnel { child, socket: local };
            #[cfg(windows)]
            let t = Tunnel { child, port: local };
            let endpoint = endpoint_of(&t);
            tunnels().insert(p.id.clone(), t);
            return Ok(endpoint);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let _ = child.kill().await;
    let msg = stderr_task.await.unwrap_or_default();
    Err(format!("SSH 隧道建立超时: {}", stderr_tail(&msg)))
}

/// ssh 的报错通常只有最后几行有用（Permission denied / Connection refused 等）
fn stderr_tail(msg: &str) -> String {
    let trimmed = msg.trim();
    if trimmed.is_empty() {
        return "无诊断输出".to_string();
    }
    let lines: Vec<&str> = trimmed.lines().collect();
    let start = lines.len().saturating_sub(3);
    lines[start..].join("；")
}

/// 停止指定 profile 的隧道（幂等）
pub fn stop(profile_id: &str) {
    if let Some(mut t) = tunnels().remove(profile_id) {
        let _ = t.child.start_kill();
        // unix 下还需清理 socket 文件；windows 的 TCP 端口随进程退出自动释放
        #[cfg(unix)]
        let _ = std::fs::remove_file(&t.socket);
    }
}

/// 停止除 keep_id 外的所有隧道（切换连接时回收旧隧道）
pub fn stop_others(keep_id: &str) {
    let stale: Vec<String> = tunnels()
        .keys()
        .filter(|id| id.as_str() != keep_id)
        .cloned()
        .collect();
    for id in stale {
        stop(&id);
    }
}

/// 应用退出时回收全部隧道
pub fn stop_all() {
    let ids: Vec<String> = tunnels().keys().cloned().collect();
    for id in ids {
        stop(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(host: &str, key_path: &str, jump_host: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: "t-test".into(),
            kind: "ssh".into(),
            host: host.into(),
            key_path: key_path.into(),
            jump_host: jump_host.into(),
            ..Default::default()
        }
    }

    #[test]
    fn args_contain_forward_and_defaults() {
        let args = build_args(&profile("root@10.0.0.5", "", ""), "/tmp/t.sock:/var/run/docker.sock");
        assert!(args.windows(2).any(|w| w[0] == "-L" && w[1] == "/tmp/t.sock:/var/run/docker.sock"));
        assert!(args.contains(&"-N".into()), "不执行远端命令");
        assert!(args.windows(2).any(|w| w[0] == "-o" && w[1] == "BatchMode=yes"), "应禁交互式密码");
        assert!(!args.contains(&"-i".into()), "未配置私钥时不应带 -i");
        assert!(!args.contains(&"-J".into()), "未配置跳板机时不应带 -J");
    }

    #[test]
    fn args_include_key_and_jump_host() {
        let args = build_args(&profile("root@10.0.0.5", "/home/me/.ssh/id_rsa", "jump@10.0.0.1:2222"), "f");
        assert!(args.windows(2).any(|w| w[0] == "-i" && w[1] == "/home/me/.ssh/id_rsa"));
        assert!(args.windows(2).any(|w| w[0] == "-J" && w[1] == "jump@10.0.0.1:2222"), "跳板机应经 -J 传入");
    }
}
