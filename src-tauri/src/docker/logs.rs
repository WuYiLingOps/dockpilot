use bollard::container::{LogOutput, LogsOptions};
use futures::StreamExt;
use tauri::ipc::Channel;
use tauri::Manager;

use super::conn::{docker, CmdResult};
use super::dto::LogChunk;
use super::state::Streams;

/// 跟踪容器日志，按块推送给前端；返回 stream_id 供前端取消
#[tauri::command]
pub async fn stream_logs(
    app: tauri::AppHandle,
    id: String,
    follow: bool,
    tail: String,
    timestamps: bool,
    on_chunk: Channel<LogChunk>,
) -> CmdResult<String> {
    let d = docker().await?;
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let opts = LogsOptions::<String> {
            follow,
            stdout: true,
            stderr: true,
            since: 0,
            until: 0,
            timestamps,
            tail,
        };
        let mut stream = d.logs(&id, Some(opts));

        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                item = stream.next() => match item {
                    Some(Ok(out)) => {
                        let (stream_name, bytes) = match out {
                            LogOutput::StdOut { message } => ("out", message),
                            LogOutput::StdErr { message } => ("err", message),
                            LogOutput::Console { message } => ("out", message),
                            LogOutput::StdIn { .. } => continue,
                        };
                        let chunk = LogChunk {
                            stream: stream_name.to_string(),
                            data: String::from_utf8_lossy(&bytes).into_owned(),
                        };
                        if on_chunk.send(chunk).is_err() {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        }

        app.state::<Streams>().remove(&sid_task);
    });

    Ok(sid)
}

/// 导出容器日志到指定文件：非 follow 按参数（tail/时间戳）拉全量后一次性写入，
/// 返回写入字节数。路径由前端经系统保存对话框取得。
#[tauri::command]
pub async fn export_container_logs(
    id: String,
    tail: String,
    timestamps: bool,
    path: String,
) -> CmdResult<u64> {
    if path.trim().is_empty() {
        return Err("导出路径不能为空".into());
    }
    let d = docker().await?;
    let opts = LogsOptions::<String> {
        follow: false,
        stdout: true,
        stderr: true,
        since: 0,
        until: 0,
        timestamps,
        tail,
    };
    let mut stream = d.logs(&id, Some(opts));
    let mut buf = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(out) => {
                let bytes = match out {
                    LogOutput::StdOut { message } | LogOutput::Console { message } => message,
                    LogOutput::StdErr { message } => message,
                    LogOutput::StdIn { .. } => continue,
                };
                buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            Err(e) => return Err(format!("读取容器日志失败: {e}")),
        }
    }
    let size = buf.len() as u64;
    tokio::fs::write(&path, buf)
        .await
        .map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(size)
}
