//! 网络查询：容器创建时的网络下拉数据源；后续网络管理功能在此基础上扩展
use bollard::network::ListNetworksOptions;

use super::conn::{docker, CmdResult};
use super::dto::NetworkDto;

/// 列出 daemon 上的全部网络（内置 bridge/host/none + 用户自定义 + compose 网络）
#[tauri::command]
pub async fn list_networks() -> CmdResult<Vec<NetworkDto>> {
    let d = docker().await?;
    let list = d
        .list_networks(None::<ListNetworksOptions<String>>)
        .await
        .map_err(|e| format!("获取网络列表失败: {e}"))?;
    let mut networks: Vec<NetworkDto> = list
        .into_iter()
        .map(|n| NetworkDto {
            id: n.id.unwrap_or_default(),
            name: n.name.unwrap_or_default(),
            driver: n.driver.unwrap_or_default(),
        })
        .collect();
    networks.sort_by(|a, b| a.name.cmp(&b.name));
    networks.dedup_by(|a, b| a.name == b.name);
    Ok(networks)
}
