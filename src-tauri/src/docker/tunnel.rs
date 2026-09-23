use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use tokio::process::{Child, Command};

use crate::settings::ConnectionProfile;

use super::conn::CmdResult;

/// 活跃的 SSH 隧道：profile_id → 子进程 + 本地 unix socket。
/// 隧道进程随切换/应用退出显式回收，避免遗留孤儿 ssh。
static TUNNELS: LazyLock<std::sync::Mutex<HashMap<String, Tunnel>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

struct Tunnel {
    child: Child,
    socket: PathBuf,
}

fn tunnels() -> std::sync::MutexGuard<'static, HashMap<String, Tunnel>> {
    TUNNELS.lock().unwrap_or_else(|e| e.into_inner())
}

/// 确保 profile 的 SSH 隧道可用，返回本地 socket 路径。
/// 复用已有隧道；进程意外退出时自动重建。
pub async fn ensure(p: &ConnectionProfile) -> CmdResult<String> {
    {
        let mut map = tunnels();
        if let Some(t) = map.get_mut(&p.id) {
            match t.child.try_wait() {
                // 仍在运行：直接复用
                Ok(None) => return Ok(t.socket.to_string_lossy().into_owned()),
                // 已退出或状态异常：清理后重建
                _ => {}
            }
        }
        map.remove(&p.id);
    }
    start(p).await
}

async fn start(p: &ConnectionProfile) -> CmdResult<String> {
    let socket = std::env::temp_dir().join(format!("dockpilot-tunnel-{}.sock", p.id));
    // 清理上次残留的 socket 文件（转发建立后由 ssh 重新创建）
    let _ = std::fs::remove_file(&socket);
    let remote = if p.remote_socket.is_empty() {
        "/var/run/docker.sock"
    } else {
        &p.remote_socket
    };

    let mut cmd = Command::new("ssh");
    cmd.arg("-N")
        // 转发失败立即退出，而不是挂着空连接
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        // 首次连接自动接受新主机密钥；主机密钥变更仍会拒绝
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        // 禁止交互式密码提示（GUI 内无法输入，认证仅支持密钥/agent）
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-L")
        .arg(format!("{}:{remote}", socket.display()));
    if !p.key_path.is_empty() {
        cmd.arg("-i").arg(&p.key_path);
    }
    cmd.arg(&p.host)
        .stdin(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 SSH 客户端失败（请确认系统已安装 ssh）: {e}"))?;

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

    // 等待本地 socket 文件出现（ExitOnForwardFailure 保证出现即转发就绪）
    for _ in 0..60 {
        match child.try_wait() {
            Ok(Some(status)) => {
                let msg = stderr_task.await.unwrap_or_default();
                return Err(format!(
                    "SSH 连接失败（{status}）: {}",
                    stderr_tail(&msg)
                ));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("SSH 进程异常: {e}")),
        }
        if socket.exists() {
            tunnels().insert(
                p.id.clone(),
                Tunnel {
                    child,
                    socket: socket.clone(),
                },
            );
            return Ok(socket.to_string_lossy().into_owned());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let _ = child.kill().await;
    let msg = stderr_task.await.unwrap_or_default();
    Err(format!("SSH 隧道建立超时: {}", stderr_tail(&msg)))
}

/// ssh 的报错通常只有最后几行有用（ Permission denied / Connection refused 等）
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
