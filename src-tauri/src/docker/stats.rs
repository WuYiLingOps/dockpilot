use bollard::container::StatsOptions;
use bollard::models::ContainerStatsResponse;
use futures::StreamExt;
use tauri::ipc::Channel;
use tauri::Manager;

use super::conn::{docker, CmdResult};
use super::dto::StatsTick;
use super::state::Streams;

fn cpu_percent(s: &ContainerStatsResponse) -> f64 {
    let (Some(cpu), Some(pre)) = (&s.cpu_stats, &s.precpu_stats) else {
        return 0.0;
    };
    let total = cpu
        .cpu_usage
        .as_ref()
        .and_then(|u| u.total_usage)
        .unwrap_or(0) as f64;
    let pre_total = pre
        .cpu_usage
        .as_ref()
        .and_then(|u| u.total_usage)
        .unwrap_or(0) as f64;
    let sys = cpu.system_cpu_usage.unwrap_or(0) as f64;
    let pre_sys = pre.system_cpu_usage.unwrap_or(0) as f64;
    let online = cpu.online_cpus.unwrap_or(1) as f64;

    let cpu_delta = total - pre_total;
    let sys_delta = sys - pre_sys;
    if sys_delta > 0.0 {
        (cpu_delta / sys_delta * online * 100.0 * 100.0).round() / 100.0
    } else {
        0.0
    }
}

fn net_io(s: &ContainerStatsResponse) -> (u64, u64) {
    let mut acc = (0u64, 0u64);
    if let Some(networks) = &s.networks {
        for n in networks.values() {
            acc.0 += n.rx_bytes.unwrap_or(0);
            acc.1 += n.tx_bytes.unwrap_or(0);
        }
    }
    acc
}

fn block_io(s: &ContainerStatsResponse) -> (u64, u64) {
    let mut acc = (0u64, 0u64);
    if let Some(entries) = s.blkio_stats.as_ref().and_then(|b| b.io_service_bytes_recursive.as_ref()) {
        for e in entries {
            match e.op.as_deref() {
                Some("Read") => acc.0 += e.value.unwrap_or(0),
                Some("Write") => acc.1 += e.value.unwrap_or(0),
                _ => {}
            }
        }
    }
    acc
}

fn to_tick(s: &ContainerStatsResponse) -> StatsTick {
    let mem_usage = s.memory_stats.as_ref().and_then(|m| m.usage).unwrap_or(0);
    let mem_limit = s.memory_stats.as_ref().and_then(|m| m.limit).unwrap_or(0);
    let mem_percent = if mem_limit > 0 {
        (mem_usage as f64 / mem_limit as f64 * 100.0 * 100.0).round() / 100.0
    } else {
        0.0
    };
    let (net_rx, net_tx) = net_io(s);
    let (block_read, block_write) = block_io(s);
    StatsTick {
        cpu_percent: cpu_percent(s),
        mem_usage,
        mem_limit,
        mem_percent,
        net_rx,
        net_tx,
        block_read,
        block_write,
    }
}

/// 持续推送容器资源统计（约每秒一次）；返回 stream_id 供前端取消
#[tauri::command]
pub async fn stream_stats(
    app: tauri::AppHandle,
    id: String,
    on_tick: Channel<StatsTick>,
) -> CmdResult<String> {
    let d = docker().await?;
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let mut stream = d.stats(&id, Some(StatsOptions { stream: true, one_shot: false }));

        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                item = stream.next() => match item {
                    Some(Ok(stats)) => {
                        if on_tick.send(to_tick(&stats)).is_err() {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        }

        app.state::<Streams>().remove(&sid_task);
    });

    Ok(sid)
}
