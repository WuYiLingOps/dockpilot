use bollard::models::EventMessageTypeEnum;
use std::sync::{LazyLock, Mutex};
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::sync::broadcast;

use super::conn::{docker, CmdResult};
use super::dto::DockerEventDto;

/// 全局监听任务句柄：切换连接时 abort 旧任务（持有旧连接）并重建
static LISTENER: LazyLock<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>> =
    LazyLock::new(|| Mutex::new(None));

/// 前端订阅 Docker 事件（容器启停、镜像删除等），用于列表实时刷新。
/// 后端在 setup 中维护一条全局监听任务，这里只做广播转发。
#[tauri::command]
pub async fn subscribe_events(
    app: tauri::AppHandle,
    on_event: Channel<DockerEventDto>,
) -> CmdResult<()> {
    let mut rx = {
        let tx = app.state::<broadcast::Sender<DockerEventDto>>();
        tx.subscribe()
    };

    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    if on_event.send(ev).is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    Ok(())
}

fn kind_of(typ: Option<EventMessageTypeEnum>) -> Option<&'static str> {
    match typ {
        Some(EventMessageTypeEnum::CONTAINER) => Some("container"),
        Some(EventMessageTypeEnum::IMAGE) => Some("image"),
        Some(EventMessageTypeEnum::NETWORK) => Some("network"),
        Some(EventMessageTypeEnum::VOLUME) => Some("volume"),
        _ => None,
    }
}

/// 启动全局事件监听任务；若已存在则先终止旧任务（切换连接后调用即为重启）
pub fn start_global_listener(app: &tauri::AppHandle, tx: broadcast::Sender<DockerEventDto>) {
    let mut g = LISTENER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(h) = g.take() {
        h.abort();
    }
    *g = Some(tauri::async_runtime::spawn(listener_loop(app.clone(), tx)));
}

/// 全局事件监听任务：断线自动重连，事件广播给所有订阅者；异常事件按设置弹出系统通知
async fn listener_loop(app: tauri::AppHandle, tx: broadcast::Sender<DockerEventDto>) {
    loop {
        let d = match docker().await {
            Ok(d) => d,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                continue;
            }
        };

        let mut stream = d.events(None::<bollard::system::EventsOptions<String>>);
        use futures::StreamExt;

        loop {
            match stream.next().await {
                Some(Ok(ev)) => {
                    let Some(kind) = kind_of(ev.typ) else {
                        continue;
                    };
                    let (id, name, attrs) = match &ev.actor {
                        Some(actor) => (
                            actor.id.clone().unwrap_or_default(),
                            actor
                                .attributes
                                .as_ref()
                                .and_then(|m| m.get("name").cloned())
                                .unwrap_or_default(),
                            actor.attributes.clone().unwrap_or_default(),
                        ),
                        None => (String::new(), String::new(), Default::default()),
                    };
                    let action = ev.action.unwrap_or_default();
                    let dto = DockerEventDto {
                        kind: kind.to_string(),
                        action: action.clone(),
                        id,
                        name: name.clone(),
                    };
                    let _ = tx.send(dto);
                    if kind == "container" {
                        notify_if_abnormal(&app, &action, &name, &attrs);
                    }
                }
                // 流结束或出错：稍候重连
                _ => break,
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// 容器异常判定与系统通知（设置开关关闭时静默）：
/// die 且退出码非 0（kill/崩溃）、oom（内存不足）、健康检查转为 unhealthy。
/// 用户主动 stop/compose down 的优雅退出码为 0，不会触发，避免噪音。
fn notify_if_abnormal(
    app: &tauri::AppHandle,
    action: &str,
    name: &str,
    attrs: &std::collections::HashMap<String, String>,
) {
    let (title, body) = match action {
        "die" => {
            let code = attrs.get("exitCode").map(|c| c.as_str()).unwrap_or("?");
            if code == "0" {
                return;
            }
            (
                "容器异常退出",
                format!("容器 {name} 已退出（exit code {code}）"),
            )
        }
        "oom" => (
            "容器内存不足（OOM）",
            format!("容器 {name} 因内存不足被终止，可尝试调大内存限制"),
        ),
        "health_status" => {
            if attrs.get("health_status").map(|s| s.as_str()) != Some("unhealthy") {
                return;
            }
            (
                "容器健康检查失败",
                format!("容器 {name} 连续未通过健康检查，已标记为 unhealthy"),
            )
        }
        _ => return,
    };

    if name.is_empty() {
        return;
    }
    let s = crate::settings::load(app);
    if !s.notifications_enabled {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}
