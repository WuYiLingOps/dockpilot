//! 卷管理：列表（合并 df 占用与容器挂载明细）、创建、删除
use std::collections::HashMap;

use bollard::container::ListContainersOptions;
use bollard::models::{MountPointTypeEnum, VolumeCreateOptions};
use bollard::query_parameters::{DataUsageOptions, ListVolumesOptions, RemoveVolumeOptions};

use super::conn::{docker, validate_resource_name, CmdResult};
use super::dto::{KeyValueDto, VolumeCreateSpec, VolumeDto};

/// 汇总容器列表中 type=volume 的挂载点：卷名 → 使用它的容器名列表。
/// 容器列表接口自带 mounts，无需逐个 inspect
async fn volume_users(d: &bollard::Docker) -> Result<HashMap<String, Vec<String>>, String> {
    let list = d
        .list_containers(Some(ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        }))
        .await
        .map_err(|e| format!("获取容器列表失败: {e}"))?;

    let mut users: HashMap<String, Vec<String>> = HashMap::new();
    for c in &list {
        let name = c
            .names
            .as_ref()
            .and_then(|v| v.first())
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default();
        for m in c.mounts.iter().flatten() {
            if m.typ == Some(MountPointTypeEnum::VOLUME) {
                if let Some(v) = &m.name {
                    users.entry(v.clone()).or_default().push(name.clone());
                }
            }
        }
    }
    Ok(users)
}

/// 列出全部卷；占用大小与引用计数来自 /system/df（非 local 驱动拿不到 size，记 0）
#[tauri::command]
pub async fn list_volumes() -> CmdResult<Vec<VolumeDto>> {
    let d = docker().await?;
    let users = volume_users(&d).await?;

    let (list, df) = tokio::join!(
        async {
            d.list_volumes(None::<ListVolumesOptions>)
                .await
                .map_err(|e| format!("获取卷列表失败: {e}"))
        },
        async {
            d.df(None::<DataUsageOptions>)
                .await
                .map_err(|e| format!("获取磁盘占用失败: {e}"))
        }
    );
    let list = list?;
    let df = df?;

    // 卷名 → (size, ref_count)；ref_count 为 -1 表示引用计数不可用
    let usage: HashMap<&str, (u64, i64)> = df
        .volumes
        .iter()
        .flatten()
        .map(|v| {
            let u = v.usage_data.as_ref();
            (
                v.name.as_str(),
                (
                    u.map(|x| x.size.max(0)).unwrap_or(0) as u64,
                    u.map(|x| x.ref_count).unwrap_or(-1),
                ),
            )
        })
        .collect();

    Ok(list
        .volumes
        .unwrap_or_default()
        .iter()
        .map(|v| {
            let (size, df_ref) = usage.get(v.name.as_str()).copied().unwrap_or((0, 0));
            let used_by = users.get(&v.name).cloned().unwrap_or_default();
            // df 的 ref_count 口径更全（含异常挂载），used_by 用于展示容器名
            let ref_count = (df_ref.max(0) as u64).max(used_by.len() as u64);
            VolumeDto {
                name: v.name.clone(),
                driver: v.driver.clone(),
                scope: v.scope.as_ref().map(|s| s.to_string()).unwrap_or_default(),
                mountpoint: v.mountpoint.clone(),
                created: v.created_at.clone(),
                size,
                ref_count,
                in_use: ref_count > 0,
                used_by,
                labels: v
                    .labels
                    .iter()
                    .map(|(k, value)| KeyValueDto {
                        key: k.clone(),
                        value: value.clone(),
                    })
                    .collect(),
            }
        })
        .collect())
}

/// 创建卷（驱动缺省 local；driver_opts 暂未开放，由 daemon 默认处理）
#[tauri::command]
pub async fn create_volume(spec: VolumeCreateSpec) -> CmdResult<()> {
    let name = spec.name.trim();
    validate_resource_name(name, "卷")?;

    let driver = spec
        .driver
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("local")
        .to_string();
    let mut labels = HashMap::new();
    for item in &spec.labels {
        let key = item.key.trim();
        if !key.is_empty() {
            labels.insert(key.to_string(), item.value.clone());
        }
    }

    let d = docker().await?;
    d.create_volume(VolumeCreateOptions {
        name: Some(name.to_string()),
        driver: Some(driver),
        labels: (!labels.is_empty()).then_some(labels),
        ..Default::default()
    })
    .await
    .map_err(|e| format!("创建卷失败: {e}"))?;
    Ok(())
}

/// 删除卷；被容器引用时拒绝（force 时跳过本地检查，交给 daemon 强制删除）
#[tauri::command]
pub async fn remove_volume(name: String, force: bool) -> CmdResult<()> {
    let d = docker().await?;
    if !force {
        let users = volume_users(&d).await?;
        if let Some(cs) = users.get(name.as_str()) {
            if !cs.is_empty() {
                return Err(format!(
                    "卷 {name} 正在被 {} 个容器使用，请先卸载相关容器",
                    cs.len()
                ));
            }
        }
    }
    d.remove_volume(&name, Some(RemoveVolumeOptions { force }))
        .await
        .map_err(|e| format!("删除卷失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::conn::validate_resource_name;

    #[test]
    fn volume_name_validation() {
        assert!(validate_resource_name("app-data", "卷").is_ok());
        assert!(validate_resource_name("db_2026.v2", "卷").is_ok());
        assert!(validate_resource_name("", "卷").is_err());
        assert!(validate_resource_name("-lead", "卷").is_err());
        assert!(validate_resource_name("has space", "卷").is_err());
        assert!(validate_resource_name("colon:name", "卷").is_err());
    }
}
