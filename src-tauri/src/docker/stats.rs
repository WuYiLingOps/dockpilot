use bollard::container::{InspectContainerOptions, StatsOptions};
use bollard::models::ContainerStatsResponse;
use futures::StreamExt;
use tauri::ipc::Channel;
use tauri::Manager;

use super::conn::{docker, CmdResult};
use super::dto::StatsTick;
use super::state::Streams;

/// 解析 CpusetCpus 串（"0-3"、"0,2"、"0-1,4"）为核心数；空串/非法值返回 None
fn parse_cpuset(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut count: u64 = 0;
    for part in s.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((lo, hi)) = part.split_once('-') {
            let lo: u64 = lo.trim().parse().ok()?;
            let hi: u64 = hi.trim().parse().ok()?;
            if hi < lo {
                return None;
            }
            count += hi - lo + 1;
        } else {
            part.parse::<u64>().ok()?;
            count += 1;
        }
    }
    Some(count as f64)
}

/// 容器 CPU 限额折算为核数：NanoCpus（--cpus）与 CpusetCpus（绑核）同时配置时取小者，
/// 两者都未配置返回 None
fn cpu_limit_cores(nano_cpus: Option<i64>, cpuset_cpus: Option<&str>) -> Option<f64> {
    let by_nano = nano_cpus
        .map(|n| n as f64 / 1_000_000_000.0)
        .filter(|c| *c > 0.0);
    let by_set = cpuset_cpus.and_then(parse_cpuset);
    match (by_nano, by_set) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

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

pub(super) fn net_io(s: &ContainerStatsResponse) -> (u64, u64) {
    let mut acc = (0u64, 0u64);
    if let Some(networks) = &s.networks {
        for n in networks.values() {
            acc.0 += n.rx_bytes.unwrap_or(0);
            acc.1 += n.tx_bytes.unwrap_or(0);
        }
    }
    acc
}

pub(super) fn block_io(s: &ContainerStatsResponse) -> (u64, u64) {
    let mut acc = (0u64, 0u64);
    if let Some(entries) = s
        .blkio_stats
        .as_ref()
        .and_then(|b| b.io_service_bytes_recursive.as_ref())
    {
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

fn to_tick(s: &ContainerStatsResponse, cpu_limit: Option<f64>) -> StatsTick {
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
        cpu_limit_cores: cpu_limit,
        mem_usage,
        mem_limit,
        mem_percent,
        net_rx,
        net_tx,
        block_read,
        block_write,
    }
}

/// 持续推送容器资源统计（约每秒一次）；返回 stream_id 供前端取消。
/// CPU 限额是容器配置（HostConfig），stats 响应不携带，订阅时 inspect 一次
#[tauri::command]
pub async fn stream_stats(
    app: tauri::AppHandle,
    id: String,
    on_tick: Channel<StatsTick>,
) -> CmdResult<String> {
    let d = docker().await?;
    let cpu_limit = match d
        .inspect_container(&id, None::<InspectContainerOptions>)
        .await
    {
        Ok(c) => cpu_limit_cores(
            c.host_config.as_ref().and_then(|h| h.nano_cpus),
            c.host_config
                .as_ref()
                .and_then(|h| h.cpuset_cpus.as_deref()),
        ),
        // inspect 失败不阻塞统计流（按无限额展示）
        Err(_) => None,
    };
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let mut stream = d.stats(
            &id,
            Some(StatsOptions {
                stream: true,
                one_shot: false,
            }),
        );

        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                item = stream.next() => match item {
                    Some(Ok(stats)) => {
                        if on_tick.send(to_tick(&stats, cpu_limit)).is_err() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpuset_parses_ranges_and_lists() {
        assert_eq!(parse_cpuset("0-3"), Some(4.0));
        assert_eq!(parse_cpuset("0,2"), Some(2.0));
        assert_eq!(parse_cpuset("0-1,4"), Some(3.0));
        assert_eq!(parse_cpuset(" 2 "), Some(1.0));
        assert_eq!(parse_cpuset(""), None);
        assert_eq!(parse_cpuset("   "), None);
        // 非法值：区间倒置、非数字
        assert_eq!(parse_cpuset("3-1"), None);
        assert_eq!(parse_cpuset("a,b"), None);
    }

    #[test]
    fn cpu_limit_from_nano_cpus() {
        assert_eq!(cpu_limit_cores(Some(1_500_000_000), None), Some(1.5));
        assert_eq!(cpu_limit_cores(Some(2_000_000_000), None), Some(2.0));
        // 0 值视为未配置
        assert_eq!(cpu_limit_cores(Some(0), None), None);
        assert_eq!(cpu_limit_cores(None, None), None);
    }

    #[test]
    fn cpu_limit_from_cpuset_and_min() {
        // 仅绑核：核数即限额
        assert_eq!(cpu_limit_cores(None, Some("0-1")), Some(2.0));
        // 两者同时配置取小者（有效上限）
        assert_eq!(cpu_limit_cores(Some(4_000_000_000), Some("0-1")), Some(2.0));
        assert_eq!(cpu_limit_cores(Some(1_000_000_000), Some("0-3")), Some(1.0));
        // 空绑核串不参与
        assert_eq!(cpu_limit_cores(Some(1_500_000_000), Some("")), Some(1.5));
    }
}
