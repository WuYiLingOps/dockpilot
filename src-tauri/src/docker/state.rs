use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Mutex;

use tauri::Manager;
use tokio::io::AsyncWrite;
use tokio_util::sync::CancellationToken;

/// 所有长驻流（日志/统计/终端输出/拉取进度）的取消句柄注册表。
/// 前端拿到 stream_id 后在清理时调用 cancel_stream 停止后端任务，
/// 避免切页后仍有无主的流在后台推送。
#[derive(Default)]
pub struct Streams(pub Mutex<HashMap<String, CancellationToken>>);

impl Streams {
    pub fn register(&self) -> (String, CancellationToken) {
        let id = uuid::Uuid::new_v4().to_string();
        let token = CancellationToken::new();
        self.0.lock().unwrap().insert(id.clone(), token.clone());
        (id, token)
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.0.lock().unwrap().remove(id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }

    /// 取消全部长驻流（切换连接时调用：旧连接上的流已无意义）
    pub fn cancel_all(&self) {
        for (_, token) in self.0.lock().unwrap().drain() {
            token.cancel();
        }
    }
}

/// 活跃终端会话：exec_id -> stdin 写入端
#[derive(Default)]
pub struct ExecSessions(pub tokio::sync::Mutex<HashMap<String, ExecSession>>);

pub struct ExecSession {
    pub input: Pin<Box<dyn AsyncWrite + Send>>,
}

impl ExecSessions {
    /// 清空全部终端会话（切换连接时调用：旧连接上的 exec 已无意义，
    /// 丢弃 stdin 写入端后对应的 attach 任务会自然结束）
    pub async fn clear(&self) {
        self.0.lock().await.clear();
    }
}

/// 取消一个由 stream_* / pull_image / exec_attach 注册的后台流任务
#[tauri::command]
pub async fn cancel_stream(stream_id: String, app: tauri::AppHandle) {
    app.state::<Streams>().cancel(&stream_id);
}
