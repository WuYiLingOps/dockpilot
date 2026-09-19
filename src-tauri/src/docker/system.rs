use super::conn::{docker, CmdResult};
use super::dto::DockerInfoDto;

#[tauri::command]
pub async fn docker_info() -> CmdResult<DockerInfoDto> {
    let d = docker().await?;
    let v = d
        .version()
        .await
        .map_err(|e| format!("获取 Docker 版本失败: {e}"))?;
    let info = d
        .info()
        .await
        .map_err(|e| format!("获取 Docker 信息失败: {e}"))?;

    Ok(DockerInfoDto {
        version: v.version.unwrap_or_default(),
        api_version: v.api_version.unwrap_or_default(),
        os: v.os.unwrap_or_default(),
        arch: v.arch.unwrap_or_default(),
        containers: info.containers.unwrap_or(0).max(0) as u64,
        running: info.containers_running.unwrap_or(0).max(0) as u64,
        paused: info.containers_paused.unwrap_or(0).max(0) as u64,
        stopped: info.containers_stopped.unwrap_or(0).max(0) as u64,
        images: info.images.unwrap_or(0).max(0) as u64,
    })
}
