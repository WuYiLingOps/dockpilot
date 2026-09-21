//! 网络查询与管理：列表（含连接明细与 IPAM）、创建、删除、连接/断开容器
use std::collections::HashMap;

use bollard::models::{
    Ipam, IpamConfig, NetworkConnectRequest, NetworkCreateRequest, NetworkDisconnectRequest,
};
use bollard::network::ListNetworksOptions;
use bollard::query_parameters::InspectNetworkOptions;
use futures::future::join_all;

use super::conn::{docker, validate_resource_name, CmdResult};
use super::dto::{KeyValueDto, NetworkContainerDto, NetworkCreateSpec, NetworkDto};

/// 内置网络不可删除；docker_gwbridge 等系统网络由 daemon 兜底拒绝
fn is_builtin(name: &str) -> bool {
    matches!(name, "bridge" | "host" | "none")
}

/// 列出 daemon 上的全部网络（内置 bridge/host/none + 用户自定义 + compose 网络）。
/// 逐个 inspect 补全已连接容器与 IPAM 明细（网络数量少，开销可接受）
#[tauri::command]
pub async fn list_networks() -> CmdResult<Vec<NetworkDto>> {
    let d = docker().await?;
    let list = d
        .list_networks(None::<ListNetworksOptions<String>>)
        .await
        .map_err(|e| format!("获取网络列表失败: {e}"))?;

    let mut networks: Vec<NetworkDto> = join_all(list.iter().map(|n| {
        let d = d.clone();
        let id = n.id.clone().unwrap_or_default();
        let name = n.name.clone().unwrap_or_default();
        async move {
            // inspect 失败按空连接明细处理，不让单个网络拖垮整个列表
            let detail = d
                .inspect_network(&id, None::<InspectNetworkOptions>)
                .await
                .ok();
            let ipam_cfg = detail
                .as_ref()
                .and_then(|x| x.ipam.as_ref())
                .and_then(|i| i.config.as_ref())
                .and_then(|c| c.first().cloned());
            NetworkDto {
                containers: detail
                    .as_ref()
                    .and_then(|x| x.containers.clone())
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(cid, c)| {
                        let id = cid;
                        NetworkContainerDto {
                            name: c
                                .name
                                .clone()
                                .unwrap_or_else(|| id.get(..12).unwrap_or(&id).to_string()),
                            id,
                            ipv4: c.ipv4_address.clone().unwrap_or_default(),
                            mac: c.mac_address.clone().unwrap_or_default(),
                        }
                    })
                    .collect(),
                id,
                built_in: is_builtin(&name),
                name,
                driver: n.driver.clone().unwrap_or_default(),
                scope: n.scope.clone().unwrap_or_default(),
                internal: n.internal.unwrap_or(false),
                attachable: n.attachable.unwrap_or(false),
                enable_ipv6: n.enable_ipv6.unwrap_or(false),
                created: n.created.clone(),
                subnet: ipam_cfg.as_ref().and_then(|c| c.subnet.clone()),
                gateway: ipam_cfg.as_ref().and_then(|c| c.gateway.clone()),
                labels: n
                    .labels
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(key, value)| KeyValueDto { key, value })
                    .collect(),
            }
        }
    }))
    .await;
    networks.sort_by(|a, b| a.name.cmp(&b.name));
    networks.dedup_by(|a, b| a.name == b.name);
    Ok(networks)
}

/// 创建用户自定义网络；填写子网/网关时走手动 IPAM，否则由 daemon 自动分配
#[tauri::command]
pub async fn create_network(spec: NetworkCreateSpec) -> CmdResult<String> {
    let name = spec.name.trim();
    validate_resource_name(name, "网络")?;

    let driver = spec
        .driver
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("bridge")
        .to_string();
    let subnet = spec
        .subnet
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let gateway = spec
        .gateway
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let mut labels = HashMap::new();
    for item in &spec.labels {
        let key = item.key.trim();
        if !key.is_empty() {
            labels.insert(key.to_string(), item.value.clone());
        }
    }

    let ipam = subnet.map(|s| Ipam {
        driver: Some("default".into()),
        config: Some(vec![IpamConfig {
            subnet: Some(s),
            gateway: gateway.clone(),
            ..Default::default()
        }]),
        options: None,
    });

    let d = docker().await?;
    let created = d
        .create_network(NetworkCreateRequest {
            name: name.to_string(),
            driver: Some(driver),
            internal: Some(spec.internal),
            attachable: Some(spec.attachable),
            enable_ipv6: Some(spec.enable_ipv6),
            ipam,
            labels: (!labels.is_empty()).then_some(labels),
            ..Default::default()
        })
        .await
        .map_err(|e| format!("创建网络失败: {e}"))?;
    Ok(created.id)
}

/// 删除网络；内置网络（bridge/host/none）直接拒绝
#[tauri::command]
pub async fn remove_network(name: String) -> CmdResult<()> {
    if is_builtin(&name) {
        return Err("内置网络不可删除".into());
    }
    let d = docker().await?;
    d.remove_network(&name)
        .await
        .map_err(|e| format!("删除网络失败: {e}"))?;
    Ok(())
}

/// 将容器接入网络（容器须存在；运行状态等由 daemon 校验）
#[tauri::command]
pub async fn connect_network(network: String, container: String) -> CmdResult<()> {
    let d = docker().await?;
    d.connect_network(
        &network,
        NetworkConnectRequest {
            container: Some(container),
            endpoint_config: None,
        },
    )
    .await
    .map_err(|e| format!("连接网络失败: {e}"))?;
    Ok(())
}

/// 将容器从网络断开；force 时忽略活动端点错误
#[tauri::command]
pub async fn disconnect_network(network: String, container: String, force: bool) -> CmdResult<()> {
    let d = docker().await?;
    d.disconnect_network(
        &network,
        NetworkDisconnectRequest {
            container: Some(container),
            force: Some(force),
        },
    )
    .await
    .map_err(|e| format!("断开网络失败: {e}"))?;
    Ok(())
}
