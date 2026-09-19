use bollard::container::{
    ListContainersOptions, RemoveContainerOptions, RestartContainerOptions, StopContainerOptions,
};
use bollard::models::ContainerSummary;

use super::conn::{docker, CmdResult};
use super::dto::{ContainerDto, PortDto};

fn map_container(c: &ContainerSummary) -> ContainerDto {
    ContainerDto {
        id: c.id.clone().unwrap_or_default(),
        name: c
            .names
            .as_ref()
            .and_then(|v| v.first())
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default(),
        image: c.image.clone().unwrap_or_default(),
        state: c.state.as_ref().map(|s| s.to_string()).unwrap_or_default(),
        status: c.status.clone().unwrap_or_default(),
        created: c.created.unwrap_or(0),
        ports: c
            .ports
            .as_ref()
            .map(|ps| {
                ps.iter()
                    .map(|p| PortDto {
                        ip: p.ip.clone(),
                        private_port: p.private_port,
                        public_port: p.public_port,
                        proto: p.typ.as_ref().map(|t| t.to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[tauri::command]
pub async fn list_containers(all: bool) -> CmdResult<Vec<ContainerDto>> {
    let d = docker().await?;
    let list = d
        .list_containers(Some(ListContainersOptions::<String> {
            all,
            ..Default::default()
        }))
        .await
        .map_err(|e| format!("获取容器列表失败: {e}"))?;
    Ok(list.iter().map(map_container).collect())
}

/// action: start | stop | restart | pause | unpause | remove
#[tauri::command]
pub async fn container_action(id: String, action: String, force: bool) -> CmdResult<()> {
    let d = docker().await?;
    match action.as_str() {
        "start" => d
            .start_container(&id, None::<bollard::container::StartContainerOptions<String>>)
            .await,
        "stop" => d
            .stop_container(&id, Some(StopContainerOptions { t: 10 }))
            .await,
        "restart" => d
            .restart_container(&id, Some(RestartContainerOptions { t: 10 }))
            .await,
        "pause" => d.pause_container(&id).await,
        "unpause" => d.unpause_container(&id).await,
        "remove" => d
            .remove_container(
                &id,
                Some(RemoveContainerOptions {
                    force,
                    v: true,
                    link: false,
                }),
            )
            .await,
        _ => return Err(format!("未知操作: {action}")),
    }
    .map_err(|e| format!("容器执行 {action} 失败: {e}"))
}
