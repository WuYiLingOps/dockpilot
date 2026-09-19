use bollard::container::{ListContainersOptions, StatsOptions};
use bollard::query_parameters::DataUsageOptions;
use futures::future::join_all;
use futures::StreamExt;

use super::conn::{docker, CmdResult};
use super::dto::{DockerInfoDto, HostStatsDto, NamedSizeDto, SystemDfDto};
use super::stats::{block_io, net_io};

fn docker_host() -> String {
    crate::settings::docker_socket()
        .map(|p| format!("unix://{p}"))
        .or_else(|| std::env::var("DOCKER_HOST").ok())
        .unwrap_or_else(|| "unix:///var/run/docker.sock".to_string())
}

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
        ncpu: info.ncpu.unwrap_or(0).max(0) as u64,
        mem_total: info.mem_total.unwrap_or(0).max(0) as u64,
        driver: info.driver.unwrap_or_default(),
        docker_root_dir: info.docker_root_dir.unwrap_or_default(),
        kernel_version: info.kernel_version.unwrap_or_default(),
        os_name: info.operating_system.unwrap_or_default(),
        os_type: info.os_type.unwrap_or_default(),
        logging_driver: info.logging_driver.unwrap_or_default(),
        plugins_volume: info
            .plugins
            .as_ref()
            .and_then(|p| p.volume.clone())
            .unwrap_or_default(),
        plugins_network: info
            .plugins
            .as_ref()
            .and_then(|p| p.network.clone())
            .unwrap_or_default(),
        host: docker_host(),
    })
}

/// 聚合所有运行中容器的 one-shot 资源采样；返回累计值，CPU% 与速率由前端差分计算
#[tauri::command]
pub async fn host_stats() -> CmdResult<HostStatsDto> {
    let d = docker().await?;
    let list = d
        .list_containers(Some(ListContainersOptions::<String> {
            all: false,
            ..Default::default()
        }))
        .await
        .map_err(|e| format!("获取运行中容器失败: {e}"))?;

    let samples = join_all(list.iter().map(|c| {
        let d = d.clone();
        let id = c.id.clone().unwrap_or_default();
        async move {
            let mut s = d.stats(&id, Some(StatsOptions { stream: false, one_shot: true }));
            s.next().await
        }
    }))
    .await;

    let mut out = HostStatsDto::default();
    for item in samples.into_iter().flatten() {
        let Ok(s) = item else { continue };
        if let Some(cpu) = &s.cpu_stats {
            out.cpu_total += cpu
                .cpu_usage
                .as_ref()
                .and_then(|u| u.total_usage)
                .unwrap_or(0);
            out.system_cpu += cpu.system_cpu_usage.unwrap_or(0);
            out.online_cpus = out.online_cpus.max(cpu.online_cpus.unwrap_or(1) as u64);
        }
        out.mem_used += s.memory_stats.as_ref().and_then(|m| m.usage).unwrap_or(0);
        let (rx, tx) = net_io(&s);
        out.net_rx += rx;
        out.net_tx += tx;
        let (read, write) = block_io(&s);
        out.block_read += read;
        out.block_write += write;
    }
    out.online_cpus = out.online_cpus.max(1);
    out.containers_running = list.len() as u64;
    Ok(out)
}

/// 一次 /system/df 同时取总量与树图明细；镜像/容器/卷的数量为条目数
#[tauri::command]
pub async fn system_df() -> CmdResult<SystemDfDto> {
    let d = docker().await?;
    let df = d
        .df(None::<DataUsageOptions>)
        .await
        .map_err(|e| format!("获取磁盘占用失败: {e}"))?;

    let mut out = SystemDfDto::default();

    for img in df.images.iter().flatten() {
        let size = img.size.max(0) as u64;
        out.images_size += size;
        out.images_count += 1;
        // 树图名称：首个 tag，无 tag 时用 12 位短 id
        let name = img
            .repo_tags
            .first()
            .cloned()
            .or_else(|| img.id.strip_prefix("sha256:").map(|s| s[..12].to_string()))
            .unwrap_or_else(|| "<none>".to_string());
        out.images.push(NamedSizeDto { name, size });
    }

    for c in df.containers.iter().flatten() {
        let rw = c.size_rw.unwrap_or(0).max(0) as u64;
        // 可写层为 0 时退回整个 rootfs 大小，避免树图全部缺席
        let size = if rw > 0 { rw } else { c.size_root_fs.unwrap_or(0).max(0) as u64 };
        out.containers_size += rw;
        out.containers_count += 1;
        let name = c
            .names
            .as_ref()
            .and_then(|v| v.first())
            .map(|n| n.trim_start_matches('/').to_string())
            .or_else(|| c.id.as_ref().map(|id| id[..12].to_string()))
            .unwrap_or_else(|| "<unknown>".to_string());
        out.containers.push(NamedSizeDto { name, size });
    }

    for v in df.volumes.iter().flatten() {
        let size = v
            .usage_data
            .as_ref()
            .map(|u| u.size.max(0) as u64)
            .unwrap_or(0);
        out.volumes_size += size;
        out.volumes_count += 1;
        out.volumes.push(NamedSizeDto {
            name: v.name.clone(),
            size,
        });
    }

    for bc in df.build_cache.iter().flatten() {
        out.build_cache_size += bc.size.unwrap_or(0).max(0) as u64;
    }

    Ok(out)
}
