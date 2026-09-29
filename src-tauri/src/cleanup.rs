use std::collections::{HashMap, HashSet};

use bollard::models::ContainerSummaryStateEnum;
use bollard::query_parameters::{
    DataUsageOptions, PruneBuildOptions, PruneContainersOptions, PruneImagesOptions,
    PruneVolumesOptions,
};
use serde::Serialize;

use crate::docker::conn::{docker, CmdResult};

#[derive(Debug, Clone, Serialize)]
pub struct UsageCategory {
    pub count: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiskUsageDto {
    /// 悬空镜像（无标签的 <none> 镜像）
    pub dangling_images: UsageCategory,
    /// 未被任何容器引用的镜像（含悬空）
    pub unused_images: UsageCategory,
    /// 已停止（非运行/暂停）的容器；容器体积不含在可回收统计中
    pub stopped_containers: UsageCategory,
    /// 未被容器使用的卷（local 驱动可统计大小，其他驱动大小未知按 0 计）
    pub unused_volumes: UsageCategory,
    /// 未被使用的构建缓存
    pub build_cache: UsageCategory,
    pub total_reclaimable: u64,
}

#[tauri::command]
pub async fn disk_usage() -> CmdResult<DiskUsageDto> {
    let d = docker().await?;
    let df = d
        .df(None::<DataUsageOptions>)
        .await
        .map_err(|e| format!("获取磁盘占用失败: {e}"))?;

    // 被容器引用的镜像 id
    let used_image_ids: HashSet<String> = df
        .containers
        .iter()
        .flatten()
        .filter_map(|c| c.image_id.clone())
        .collect();

    let mut dangling = UsageCategory { count: 0, size: 0 };
    let mut unused_images = UsageCategory { count: 0, size: 0 };
    for img in df.images.iter().flatten() {
        if img.repo_tags.is_empty() {
            dangling.count += 1;
            dangling.size += img.size.max(0) as u64;
        }
        if !used_image_ids.contains(&img.id) {
            unused_images.count += 1;
            unused_images.size += img.size.max(0) as u64;
        }
    }

    let stopped_containers = df
        .containers
        .iter()
        .flatten()
        .filter(|c| {
            !matches!(
                c.state,
                Some(ContainerSummaryStateEnum::RUNNING)
                    | Some(ContainerSummaryStateEnum::PAUSED)
                    | Some(ContainerSummaryStateEnum::RESTARTING)
            )
        })
        .count() as u64;

    let mut unused_volumes = UsageCategory { count: 0, size: 0 };
    for v in df.volumes.iter().flatten() {
        let unused = match &v.usage_data {
            Some(u) => u.ref_count == 0,
            // df 未返回引用计数时按未使用处理
            None => true,
        };
        if unused {
            unused_volumes.count += 1;
            if let Some(u) = &v.usage_data {
                unused_volumes.size += u.size.max(0) as u64;
            }
        }
    }

    let mut build_cache = UsageCategory { count: 0, size: 0 };
    for c in df.build_cache.iter().flatten() {
        if c.in_use != Some(true) {
            build_cache.count += 1;
            build_cache.size += c.size.unwrap_or(0).max(0) as u64;
        }
    }

    let total_reclaimable = unused_images.size + unused_volumes.size + build_cache.size;
    Ok(DiskUsageDto {
        dangling_images: dangling,
        unused_images,
        stopped_containers: UsageCategory {
            count: stopped_containers,
            size: 0,
        },
        unused_volumes,
        build_cache,
        total_reclaimable,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct CleanupItemResult {
    pub kind: String,
    pub removed: u64,
    pub space_reclaimed: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CleanupResultDto {
    pub items: Vec<CleanupItemResult>,
    pub total_reclaimed: u64,
}

fn filters(kv: &[(&str, &str)]) -> Option<HashMap<String, Vec<String>>> {
    Some(
        kv.iter()
            .map(|(k, v)| (k.to_string(), vec![v.to_string()]))
            .collect(),
    )
}

/// 按类别清理。单类失败不影响其他类别，错误记录在对应条目里返回。
#[tauri::command]
pub async fn cleanup(kinds: Vec<String>) -> CmdResult<CleanupResultDto> {
    let d = docker().await?;
    let mut items = Vec::new();
    let mut total_reclaimed = 0u64;

    for kind in kinds {
        let r: Result<(u64, i64), String> = match kind.as_str() {
            // dangling=true: 仅悬空镜像；dangling=false: 所有未被引用的镜像
            "dangling_images" => d
                .prune_images(Some(PruneImagesOptions {
                    filters: filters(&[("dangling", "true")]),
                }))
                .await
                .map(|r| {
                    (
                        r.images_deleted.map(|v| v.len() as u64).unwrap_or(0),
                        r.space_reclaimed.unwrap_or(0),
                    )
                })
                .map_err(|e| e.to_string()),
            "unused_images" => d
                .prune_images(Some(PruneImagesOptions {
                    filters: filters(&[("dangling", "false")]),
                }))
                .await
                .map(|r| {
                    (
                        r.images_deleted.map(|v| v.len() as u64).unwrap_or(0),
                        r.space_reclaimed.unwrap_or(0),
                    )
                })
                .map_err(|e| e.to_string()),
            "stopped_containers" => d
                .prune_containers(Some(PruneContainersOptions { filters: None }))
                .await
                .map(|r| {
                    (
                        r.containers_deleted.map(|v| v.len() as u64).unwrap_or(0),
                        r.space_reclaimed.unwrap_or(0),
                    )
                })
                .map_err(|e| e.to_string()),
            "unused_volumes" => d
                .prune_volumes(Some(PruneVolumesOptions { filters: None }))
                .await
                .map(|r| {
                    (
                        r.volumes_deleted.map(|v| v.len() as u64).unwrap_or(0),
                        r.space_reclaimed.unwrap_or(0),
                    )
                })
                .map_err(|e| e.to_string()),
            "build_cache" => d
                .prune_build(None::<PruneBuildOptions>)
                .await
                .map(|r| {
                    (
                        r.caches_deleted.map(|v| v.len() as u64).unwrap_or(0),
                        r.space_reclaimed.unwrap_or(0),
                    )
                })
                .map_err(|e| e.to_string()),
            _ => continue,
        };

        match r {
            Ok((removed, space)) => {
                total_reclaimed += space.max(0) as u64;
                items.push(CleanupItemResult {
                    kind,
                    removed,
                    space_reclaimed: space.max(0) as u64,
                    error: None,
                });
            }
            Err(e) => items.push(CleanupItemResult {
                kind,
                removed: 0,
                space_reclaimed: 0,
                error: Some(e),
            }),
        }
    }

    Ok(CleanupResultDto {
        items,
        total_reclaimed,
    })
}
