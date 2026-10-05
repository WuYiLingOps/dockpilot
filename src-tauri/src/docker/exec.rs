use std::time::Duration;

use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecResults};
use futures::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Manager;

use super::conn::{docker, CmdResult};
use super::state::{ExecSession, ExecSessions, Streams};

/// 终端输出帧（经 Tauri Channel 推给前端 xterm）：
/// data 为正常输出流；ended 表示会话结束，reason 为面向用户的中文原因
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecFrame {
    Data { text: String },
    Ended { reason: String },
}

/// 在容器内创建 exec 实例，返回 exec_id
#[tauri::command]
pub async fn exec_create(id: String, shell: Option<String>) -> CmdResult<String> {
    log::info!(
        "容器 {} 打开终端（{}）",
        super::short_id(&id),
        shell.as_deref().unwrap_or("bash")
    );
    let d = docker().await?;
    let cfg = CreateExecOptions::<String> {
        attach_stdin: Some(true),
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        tty: Some(true),
        cmd: Some(vec![shell.unwrap_or_else(|| "bash".to_string())]),
        env: Some(vec!["TERM=xterm-256color".to_string()]),
        // 不沿用 daemon 默认的 ctrl-p,ctrl-q：vim/less 中 Ctrl+P 是常用上翻键，
        // 误触即静默 detach 造成终端冻结。改用几乎不会按出的双击 ctrl-^，
        // 真需 detach 保留后台进程的场景可直接关闭终端页
        detach_keys: Some("ctrl-^,ctrl-^".to_string()),
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

/// 跨 chunk 增量 UTF-8 解码：Docker TTY 流按网络帧分块，多字节字符（中文/emoji）
/// 可能恰好被切在两帧之间，逐帧 lossy 解码会把残缺尾巴替换成 U+FFFD（乱码）。
/// 此处把残缺序列尾部缓存到下一帧拼接；真正的非法字节仍按 U+FFFD 替换。
struct Utf8Feeder {
    /// 上一帧遗留的残缺序列（UTF-8 不完整序列最长 3 字节）
    tail: Vec<u8>,
}

impl Utf8Feeder {
    fn new() -> Self {
        Self { tail: Vec::new() }
    }

    /// 喂入一帧字节，返回可安全发出的文本（残缺尾部留待下一帧）
    fn feed(&mut self, bytes: &[u8]) -> String {
        // 快路径：无历史尾巴且整帧合法时零拷贝语义直通
        if self.tail.is_empty() {
            if let Ok(s) = std::str::from_utf8(bytes) {
                return s.to_string();
            }
        }
        let mut buf = std::mem::take(&mut self.tail);
        buf.extend_from_slice(bytes);
        let mut text = String::new();
        loop {
            match std::str::from_utf8(&buf) {
                Ok(s) => {
                    text.push_str(s);
                    buf.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        text.push_str(&String::from_utf8_lossy(&buf[..valid]));
                    }
                    let rest = buf.split_off(valid);
                    match e.error_len() {
                        // 不完整序列只可能出现在缓冲末尾：缓存等下一帧拼接
                        None => {
                            self.tail = rest;
                            break;
                        }
                        // 真非法字节：按 U+FFFD 替换后继续处理剩余
                        Some(bad) => {
                            text.push('\u{FFFD}');
                            buf = rest[bad..].to_vec();
                            if buf.is_empty() {
                                break;
                            }
                        }
                    }
                }
            }
        }
        text
    }

    /// 流结束：把残留的残缺序列按 U+FFFD 冲刷出来
    fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.tail);
        String::from_utf8_lossy(&rest).into_owned()
    }
}

/// 输出合帧缓冲：高吞吐（cat 大文件、yes 等）下避免每个网络帧都打一次 IPC。
/// 满 LIMIT 立即取走发送，不足的尾巴由调用方的 16ms 定时器冲刷。
struct OutputBatch {
    text: String,
}

impl OutputBatch {
    const LIMIT: usize = 32 * 1024;

    fn new() -> Self {
        Self {
            text: String::new(),
        }
    }

    /// 追加文本；返回 Some 表示缓冲已满，取走的内容应立即发送
    fn push(&mut self, s: &str) -> Option<String> {
        self.text.push_str(s);
        if self.text.len() >= Self::LIMIT {
            return Some(std::mem::take(&mut self.text));
        }
        None
    }

    /// 取走非空缓冲（定时冲刷用）；空则返回 None 避免空帧
    fn take(&mut self) -> Option<String> {
        (!self.text.is_empty()).then(|| std::mem::take(&mut self.text))
    }
}

/// 启动 exec 并把输出流推给前端（xterm）；stdin 通过 exec_input 写入。
/// 返回 stream_id 供前端取消。
#[tauri::command]
pub async fn exec_attach(
    app: tauri::AppHandle,
    exec_id: String,
    on_chunk: Channel<ExecFrame>,
) -> CmdResult<String> {
    let d = docker().await?;
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let started = match d.start_exec(&exec_id, None).await {
            Ok(r) => r,
            Err(e) => {
                let _ = on_chunk.send(ExecFrame::Ended {
                    reason: format!("终端启动失败: {e}"),
                });
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

                let mut feeder = Utf8Feeder::new();
                let mut batch = OutputBatch::new();
                // 16ms 合帧定时器：输出突发期间攒批发送，闲时把不足一批的尾巴冲给前端
                let mut ticker = tokio::time::interval(Duration::from_millis(16));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

                loop {
                    tokio::select! {
                        _ = token.cancelled() => {
                            // 前端主动取消（关页/切连接）：补一帧结束通知，
                            // 发往已销毁的 channel 无副作用
                            let _ = on_chunk
                                .send(ExecFrame::Ended { reason: "连接已切换".into() });
                            break;
                        }
                        _ = ticker.tick() => {
                            if let Some(pending) = batch.take() {
                                if on_chunk.send(ExecFrame::Data { text: pending }).is_err() {
                                    break;
                                }
                            }
                        }
                        item = output.next() => match item {
                            Some(Ok(out)) => {
                                let bytes = match out {
                                    LogOutput::StdOut { message }
                                    | LogOutput::StdErr { message }
                                    | LogOutput::Console { message } => message,
                                    LogOutput::StdIn { .. } => continue,
                                };
                                if let Some(full) = batch.push(&feeder.feed(&bytes)) {
                                    if on_chunk.send(ExecFrame::Data { text: full }).is_err() {
                                        break;
                                    }
                                }
                            }
                            Some(Err(e)) => {
                                let _ = on_chunk.send(ExecFrame::Ended {
                                    reason: format!("连接中断: {e}"),
                                });
                                break;
                            }
                            None => {
                                // 流自然结束：exec 进程退出（含用户输入 exit），
                                // 先冲出残余输出再通知前端
                                let mut pending = batch.take().unwrap_or_default();
                                pending.push_str(&feeder.finish());
                                if !pending.is_empty() {
                                    let _ =
                                        on_chunk.send(ExecFrame::Data { text: pending });
                                }
                                let _ = on_chunk.send(ExecFrame::Ended {
                                    reason: "进程已退出".into(),
                                });
                                break;
                            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feeder_passes_plain_ascii_through() {
        let mut f = Utf8Feeder::new();
        assert_eq!(f.feed(b"hello world"), "hello world");
        assert_eq!(f.feed(b""), "");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn feeder_reassembles_multibyte_char_across_chunks() {
        // "中" = e4 b8 ad，任意切点都应无损重组
        for split in 1..3 {
            let mut f = Utf8Feeder::new();
            let all = "中中".as_bytes();
            let (a, b) = (&all[..split], &all[split..]);
            let mut got = f.feed(a);
            got.push_str(&f.feed(b));
            got.push_str(&f.finish());
            assert_eq!(got, "中中", "split at {split}");
        }
    }

    #[test]
    fn feeder_reassembles_emoji_across_chunks() {
        let mut f = Utf8Feeder::new();
        // 😀 = f0 9f 98 80（4 字节），跨 3 帧拼接
        assert_eq!(f.feed(&[0xf0]), "");
        assert_eq!(f.feed(&[0x9f, 0x98]), "");
        assert_eq!(f.feed(&[0x80]), "😀");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn feeder_replaces_invalid_bytes_with_replacement_char() {
        let mut f = Utf8Feeder::new();
        assert_eq!(f.feed(b"a\xffb"), "a\u{FFFD}b");
        // 非法字节之后的残缺序列仍正常缓存拼接
        assert_eq!(f.feed(&[0xe4, 0xb8]), "");
        assert_eq!(f.feed(&[0xad]), "中");
    }

    #[test]
    fn feeder_flushes_incomplete_tail_on_finish() {
        let mut f = Utf8Feeder::new();
        assert_eq!(f.feed(&[0xe4, 0xb8]), "");
        // 流结束时残缺尾巴无处拼接，按 U+FFFD 冲出
        assert_eq!(f.finish(), "\u{FFFD}");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn feeder_keeps_chinese_text_intact_across_random_splits() {
        // 整段中文/emoji 按任意边界切块重组后必须与原文一致
        let text = "ab中文测试cd😀ef混合\u{1F600}文本";
        let all = text.as_bytes();
        for split in 1..all.len() {
            let mut f = Utf8Feeder::new();
            let mut got = f.feed(&all[..split]);
            got.push_str(&f.feed(&all[split..]));
            got.push_str(&f.finish());
            assert_eq!(got, text, "split at byte {split}");
        }
    }

    #[test]
    fn batch_flushes_when_limit_reached() {
        let mut b = OutputBatch::new();
        assert_eq!(b.push("abc"), None);
        // 不足上限：不触发；恰好填满时连同先前内容整块取走
        let big = "x".repeat(OutputBatch::LIMIT - 3);
        assert_eq!(b.push(&big), Some(format!("abc{big}")));
        assert_eq!(b.push("y"), None);
        assert_eq!(b.take().as_deref(), Some("y"));
        assert_eq!(b.take(), None);
    }

    #[test]
    fn exec_frame_serializes_with_type_tag() {
        let data = serde_json::to_string(&ExecFrame::Data { text: "hi".into() }).unwrap();
        assert_eq!(data, r#"{"type":"data","text":"hi"}"#);
        let ended = serde_json::to_string(&ExecFrame::Ended {
            reason: "进程已退出".into(),
        })
        .unwrap();
        assert_eq!(ended, r#"{"type":"ended","reason":"进程已退出"}"#);
    }
}
