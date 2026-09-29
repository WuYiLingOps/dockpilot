use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecResults};
use futures::StreamExt;
use tauri::ipc::Channel;
use tauri::Manager;

use super::conn::{docker, CmdResult};
use super::state::{ExecSession, ExecSessions, Streams};

/// 在容器内创建 exec 实例，返回 exec_id
#[tauri::command]
pub async fn exec_create(id: String, shell: Option<String>) -> CmdResult<String> {
    let d = docker().await?;
    let cfg = CreateExecOptions::<String> {
        attach_stdin: Some(true),
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        tty: Some(true),
        cmd: Some(vec![shell.unwrap_or_else(|| "bash".to_string())]),
        env: Some(vec!["TERM=xterm-256color".to_string()]),
        detach_keys: None,
        privileged: None,
        user: None,
        working_dir: None,
    };
    let res = d
        .create_exec(&id, cfg)
        .await
        .map_err(|e| format!("创建终端会话失败: {e}"))?;
    Ok(res.id)
}

/// 启动 exec 并把输出流推给前端（xterm）；stdin 通过 exec_input 写入。
/// 返回 stream_id 供前端取消。
#[tauri::command]
pub async fn exec_attach(
    app: tauri::AppHandle,
    exec_id: String,
    on_chunk: Channel<String>,
) -> CmdResult<String> {
    let d = docker().await?;
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let started = match d.start_exec(&exec_id, None).await {
            Ok(r) => r,
            Err(e) => {
                let _ = on_chunk.send(format!("\r\n\x1b[31m[终端启动失败] {e}\x1b[0m"));
                app.state::<Streams>().remove(&sid_task);
                return;
            }
        };

        match started {
            StartExecResults::Attached { mut output, input } => {
                app.state::<ExecSessions>()
                    .0
                    .lock()
                    .await
                    .insert(exec_id.clone(), ExecSession { input });

                loop {
                    tokio::select! {
                        _ = token.cancelled() => break,
                        item = output.next() => match item {
                            Some(Ok(out)) => {
                                let bytes = match out {
                                    LogOutput::StdOut { message }
                                    | LogOutput::StdErr { message }
                                    | LogOutput::Console { message } => message,
                                    LogOutput::StdIn { .. } => continue,
                                };
                                if on_chunk
                                    .send(String::from_utf8_lossy(&bytes).into_owned())
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            _ => break,
                        }
                    }
                }

                app.state::<ExecSessions>().0.lock().await.remove(&exec_id);
                app.state::<Streams>().remove(&sid_task);
            }
            StartExecResults::Detached => {
                app.state::<Streams>().remove(&sid_task);
            }
        }
    });

    Ok(sid)
}

/// 向终端 stdin 写入数据（键盘输入）
#[tauri::command]
pub async fn exec_input(
    exec_id: String,
    data: String,
    sessions: tauri::State<'_, ExecSessions>,
) -> CmdResult<()> {
    use tokio::io::AsyncWriteExt;

    let mut map = sessions.0.lock().await;
    let session = map
        .get_mut(&exec_id)
        .ok_or_else(|| "终端会话不存在或已关闭".to_string())?;
    session
        .input
        .write_all(data.as_bytes())
        .await
        .map_err(|e| format!("写入终端失败: {e}"))?;
    let _ = session.input.flush().await;
    Ok(())
}

/// 调整终端 TTY 尺寸（前端窗口变化时调用）
#[tauri::command]
pub async fn exec_resize(exec_id: String, width: u16, height: u16) -> CmdResult<()> {
    let d = docker().await?;
    d.resize_exec(&exec_id, ResizeExecOptions { width, height })
        .await
        .map_err(|e| format!("调整终端尺寸失败: {e}"))
}
