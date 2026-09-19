use bollard::models::EventMessageTypeEnum;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::sync::broadcast;

use super::conn::{docker, CmdResult};
use super::dto::DockerEventDto;

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

/// 全局事件监听任务：断线自动重连，事件广播给所有订阅者
pub fn spawn_global_listener(tx: broadcast::Sender<DockerEventDto>) {
    tauri::async_runtime::spawn(async move {
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
                        let (id, name) = match &ev.actor {
                            Some(actor) => (
                                actor.id.clone().unwrap_or_default(),
                                actor
                                    .attributes
                                    .as_ref()
                                    .and_then(|m| m.get("name").cloned())
                                    .unwrap_or_default(),
                            ),
                            None => (String::new(), String::new()),
                        };
                        let dto = DockerEventDto {
                            kind: kind.to_string(),
                            action: ev.action.unwrap_or_default(),
                            id,
                            name,
                        };
                        let _ = tx.send(dto);
                    }
                    // 流结束或出错：稍候重连
                    _ => break,
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
}
