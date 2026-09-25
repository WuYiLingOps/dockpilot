pub mod compose;
pub mod conn;
pub mod containers;
pub mod dto;
pub mod events;
pub mod exec;
pub mod images;
pub mod logs;
pub mod networks;
pub mod state;
pub mod stats;
pub mod system;
pub mod tunnel;
pub mod volumes;

/// 集成测试依赖本机 Docker daemon（/var/run/docker.sock），
/// 仅在 unix 上编译运行（Windows 无本地 daemon；远程 SSH 用例见下方 ignored 测试）
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// 依赖本机 Docker daemon 的集成测试：
    /// 验证 bollard 能通过 /var/run/docker.sock 正常通信
    #[tokio::test]
    async fn docker_daemon_reachable() {
        let info = system::docker_info()
            .await
            .expect("docker_info 应成功（需要本机 Docker daemon 运行且用户在 docker 组）");
        assert!(!info.version.is_empty(), "Docker 版本不应为空");

        let containers = containers::list_containers(true)
            .await
            .expect("list_containers 应成功");
        assert_eq!(containers.len() as u64, info.containers, "容器数量应与 info 一致");

        let images = images::list_images().await.expect("list_images 应成功");
        assert_eq!(images.len() as u64, info.images, "镜像数量应与 info 一致");
    }

    /// 依赖本机 Docker daemon 的系统概览集成测试：
    /// 验证 host_stats 的聚合口径与 info 一致（容器数、核数来自 daemon 实时数据）
    #[tokio::test]
    async fn host_stats_matches_info() {
        let info = system::docker_info()
            .await
            .expect("docker_info 应成功");
        let stats = system::host_stats().await.expect("host_stats 应成功");

        assert_eq!(
            stats.containers_running, info.running,
            "参与统计的运行中容器数应与 info.running 一致"
        );
        assert_eq!(
            stats.online_cpus as u64, info.ncpu,
            "online_cpus 应与 info.ncpu 一致"
        );
        if stats.containers_running > 0 {
            assert!(stats.system_cpu > 0, "有运行中容器时 system_cpu 累计应为正");
            assert!(stats.mem_used > 0, "有运行中容器时内存占用应为正");
        }
    }

    /// 依赖本机 Docker daemon 的 system_df 集成测试：
    /// 验证总量、明细条目数与 info 计数相互对齐（全部取自 /system/df 实时数据）
    #[tokio::test]
    async fn system_df_totals_match_details() {
        let info = system::docker_info()
            .await
            .expect("docker_info 应成功");
        let df = system::system_df().await.expect("system_df 应成功");

        assert_eq!(df.images_count, df.images.len() as u64, "镜像计数应与明细条目数一致");
        assert_eq!(df.containers_count, df.containers.len() as u64, "容器计数应与明细条目数一致");
        assert_eq!(df.volumes_count, df.volumes.len() as u64, "卷计数应与明细条目数一致");
        assert_eq!(df.images_count, info.images, "镜像计数应与 info.images 一致");
        assert_eq!(df.containers_count, info.containers, "容器计数应与 info.containers 一致");

        let images_sum: u64 = df.images.iter().map(|i| i.size).sum();
        assert_eq!(df.images_size, images_sum, "镜像总量应等于明细之和");
        let volumes_sum: u64 = df.volumes.iter().map(|v| v.size).sum();
        assert_eq!(df.volumes_size, volumes_sum, "卷总量应等于明细之和");
        // 容器明细在可写层为 0 时会退回 rootfs 大小展示，因此明细之和 >= 可写层总量
        let containers_sum: u64 = df.containers.iter().map(|c| c.size).sum();
        assert!(
            df.containers_size <= containers_sum,
            "容器可写层总量不应超过明细之和"
        );
        for item in df.containers.iter().chain(&df.images) {
            assert!(!item.name.is_empty(), "明细名称不应为空");
        }
    }

    /// 依赖本机 Docker daemon 的 compose 分组集成测试：
    /// 验证 list_compose_projects 查询与分组路径可用（不要求本机存在 compose 项目）
    #[tokio::test]
    async fn compose_projects_grouped() {
        let projects = compose::list_compose_projects()
            .await
            .expect("list_compose_projects 应成功");
        for p in &projects {
            assert!(!p.name.is_empty(), "项目名不应为空");
            assert_eq!(p.services.len(), p.total_count, "服务数应与容器总数一致");
            assert!(p.running_count <= p.total_count, "运行数不应超过总数");
        }
    }

    /// 依赖本机 Docker daemon 的容器创建回归测试：
    /// 创建带端口映射/环境变量/标签/命令覆盖的容器并启动，确认状态后删除
    #[tokio::test]
    async fn create_and_remove_container_roundtrip() {
        use dto::{ContainerCreateSpec, KeyValueSpec, PortMappingSpec};

        // 幂等：清理上次失败遗留的同名容器
        if let Ok(list) = containers::list_containers(true).await {
            for c in list.iter().filter(|c| c.name == "dockpilot-it-create") {
                let _ = containers::container_action(c.id.clone(), "remove".into(), true).await;
            }
        }

        let spec = ContainerCreateSpec {
            name: Some("dockpilot-it-create".into()),
            image: "busybox:stable".into(),
            ports: vec![PortMappingSpec { host: 18791, container: 80, proto: Some("tcp".into()) }],
            volumes: vec![],
            env: vec![KeyValueSpec { key: "FOO".into(), value: "bar".into() }],
            labels: vec![KeyValueSpec { key: "dockpilot-test".into(), value: "1".into() }],
            restart_policy: None,
            command: Some("sleep 60".into()),
            workdir: None,
            network: None,
            hostname: Some("it-create".into()),
            memory_mb: Some(256),
            cpus: Some(1.5),
            auto_remove: false,
            privileged: false,
            tty: false,
            open_stdin: false,
        };
        let id = containers::create_container(spec)
            .await
            .expect("创建容器应成功（需要本机已有 busybox:stable 镜像）");

        let list = containers::list_containers(true).await.unwrap();
        let c = list
            .iter()
            .find(|c| c.id == id)
            .expect("新创建的容器应出现在列表中");
        assert_eq!(c.state, "running", "创建后应已启动");
        assert_eq!(c.name, "dockpilot-it-create");

        // inspect 验证资源限制真实写入 HostConfig
        let inspect = conn::docker()
            .await
            .expect("连接应成功")
            .inspect_container(&id, None::<bollard::container::InspectContainerOptions>)
            .await
            .expect("inspect 容器应成功");
        let hc = inspect.host_config.expect("host_config 应存在");
        assert_eq!(hc.memory, Some(256 * 1024 * 1024), "内存限制应生效");
        assert_eq!(hc.nano_cpus, Some(1_500_000_000), "CPU 限制应生效");

        containers::container_action(id, "remove".into(), true)
            .await
            .expect("清理测试容器应成功");
    }

    /// 依赖本机 Docker daemon 的存储/网络列表集成测试：
    /// 验证卷列表（df 占用合并 + 挂载明细）与网络列表（inspect 连接明细）查询路径可用
    #[tokio::test]
    async fn storage_and_network_lists() {
        let volumes = volumes::list_volumes().await.expect("list_volumes 应成功");
        for v in &volumes {
            assert!(!v.name.is_empty(), "卷名不应为空");
            assert!(!v.mountpoint.is_empty(), "卷挂载点不应为空");
            assert_eq!(v.in_use, v.ref_count > 0, "in_use 应与 ref_count 口径一致");
            assert!(
                v.used_by.len() <= v.ref_count as usize,
                "挂载明细容器数不应超过 ref_count"
            );
        }

        let networks = networks::list_networks().await.expect("list_networks 应成功");
        let bridge = networks
            .iter()
            .find(|n| n.name == "bridge")
            .expect("默认 bridge 网络应存在");
        assert!(bridge.built_in, "bridge 应标记为内置网络");
        assert_eq!(bridge.driver, "bridge");
        for n in &networks {
            assert_eq!(
                n.built_in,
                matches!(n.name.as_str(), "bridge" | "host" | "none"),
                "内置标记应与网络名一致"
            );
        }
    }

    /// 依赖本机 Docker daemon 的卷/网络创建回归测试：
    /// 创建 → 出现在列表 → 删除，均走命令层完整路径
    #[tokio::test]
    async fn volume_and_network_create_remove_roundtrip() {
        // 幂等：清理上次失败遗留的同名资源
        if let Ok(list) = volumes::list_volumes().await {
            for v in list.iter().filter(|v| v.name == "dockpilot-it-vol") {
                let _ = volumes::remove_volume(v.name.clone(), true).await;
            }
        }
        if let Ok(list) = networks::list_networks().await {
            for n in list.iter().filter(|n| n.name == "dockpilot-it-net") {
                let _ = networks::remove_network(n.name.clone()).await;
            }
        }

        volumes::create_volume(dto::VolumeCreateSpec {
            name: "dockpilot-it-vol".into(),
            driver: None,
            labels: vec![dto::KeyValueSpec {
                key: "dockpilot-test".into(),
                value: "1".into(),
            }],
        })
        .await
        .expect("创建卷应成功");
        let volumes = volumes::list_volumes().await.unwrap();
        let vol = volumes
            .iter()
            .find(|v| v.name == "dockpilot-it-vol")
            .expect("新创建的卷应出现在列表中");
        assert_eq!(vol.driver, "local");
        assert!(!vol.in_use, "新建卷不应被引用");

        let net_id = networks::create_network(dto::NetworkCreateSpec {
            name: "dockpilot-it-net".into(),
            driver: None,
            subnet: Some("172.30.77.0/24".into()),
            gateway: Some("172.30.77.1".into()),
            internal: false,
            attachable: true,
            enable_ipv6: false,
            labels: vec![],
        })
        .await
        .expect("创建网络应成功");
        assert!(!net_id.is_empty());
        let networks = networks::list_networks().await.unwrap();
        let net = networks
            .iter()
            .find(|n| n.name == "dockpilot-it-net")
            .expect("新创建的网络应出现在列表中");
        assert_eq!(net.subnet.as_deref(), Some("172.30.77.0/24"), "IPAM 子网应生效");
        assert_eq!(net.built_in, false);
        assert_eq!(net.containers.len(), 0, "新网络不应有连接的容器");

        volumes::remove_volume("dockpilot-it-vol".into(), false)
            .await
            .expect("删除卷应成功");
        networks::remove_network("dockpilot-it-net".into())
            .await
            .expect("删除网络应成功");

        // 内置网络保护
        let err = networks::remove_network("bridge".into())
            .await
            .expect_err("删除内置网络应被拒绝");
        assert!(err.contains("内置网络"), "错误信息应说明内置网络不可删除");
    }

    /// 真实远程 SSH 连接回归测试（只读操作，默认忽略）。
    /// 远程机需已配置本机公钥免密登录，运行方式：
    /// DOCKERPILOT_REMOTE_SSH=root@10.0.0.115 cargo test --lib -- --ignored remote_ssh
    #[tokio::test]
    #[ignore]
    async fn remote_ssh_tunnel_roundtrip() {
        use crate::settings::ConnectionProfile;

        let host = std::env::var("DOCKERPILOT_REMOTE_SSH").unwrap_or_else(|_| "root@10.0.0.115".into());
        let profile = ConnectionProfile {
            id: "it-remote-ssh".into(),
            name: "远程集成测试".into(),
            kind: "ssh".into(),
            host,
            ..Default::default()
        };

        // 走命令层真实路径：init_active → docker()（内部建隧道 + 缓存连接）
        conn::init_active(profile.clone());
        let d = conn::docker()
            .await
            .expect("经 SSH 隧道连接远程 daemon 应成功");

        let v = d.version().await.expect("远程 version() 应成功");
        let version = v.version.unwrap_or_default();
        assert!(!version.is_empty(), "远程版本不应为空");
        let info = d.info().await.expect("远程 info() 应成功");
        println!(
            "远程 daemon: {version}，容器 {:?} 个（运行 {:?} 个）",
            info.containers, info.containers_running
        );

        let containers = containers::list_containers(true)
            .await
            .expect("经 docker() 的远程容器列表应成功");
        println!("list_containers 返回 {} 个容器", containers.len());

        // 容器级回归：拉取镜像 → 创建 → exec → 日志 → 统计 → 删除（验证 GUI 核心交互经隧道可用）
        // 命令层底层即这些 bollard 调用
        if let Ok(images) = images::list_images().await {
            let has_busybox = images
                .iter()
                .any(|i| i.tags.iter().any(|t| t.starts_with("busybox:")));
            if !has_busybox {
                // 拉取进度流（GUI 拉取镜像的底层路径）
                let mut pull = d.create_image(
                    Some(bollard::image::CreateImageOptions::<String> {
                        from_image: "busybox:stable".into(),
                        ..Default::default()
                    }),
                    None,
                    None,
                );
                let mut layers = 0;
                while let Some(item) = pull.next().await {
                    match item {
                        Ok(_) => layers += 1,
                        Err(e) => panic!("远程拉取 busybox:stable 失败: {e}"),
                    }
                }
                println!("镜像拉取完成，收到 {layers} 条进度事件");
            }
        }
        let rt_id = containers::create_container(dto::ContainerCreateSpec {
            name: Some("dockpilot-it-remote".into()),
            image: "busybox:stable".into(),
            ports: vec![],
            volumes: vec![],
            env: vec![],
            labels: vec![],
            restart_policy: None,
            command: Some("sleep 60".into()),
            workdir: None,
            network: None,
            hostname: None,
            memory_mb: None,
            cpus: None,
            auto_remove: false,
            privileged: false,
            tty: false,
            open_stdin: false,
        })
        .await
        .expect("远程创建测试容器应成功（需远程可拉取 busybox:stable）");

        // exec：容器内执行 echo，输出应经隧道返回
        let exec = d
            .create_exec(
                &rt_id,
                bollard::exec::CreateExecOptions {
                    attach_stdout: Some(true),
                    cmd: Some(vec!["echo", "tunnel-exec-ok"]),
                    ..Default::default()
                },
            )
            .await
            .expect("远程 exec_create 应成功");
        use bollard::exec::StartExecResults;
        use futures::{future, StreamExt};
        let started = d
            .start_exec(&exec.id, None)
            .await
            .expect("远程 start_exec 应成功");
        let mut exec_output = String::new();
        if let StartExecResults::Attached { mut output, .. } = started {
            while let Some(item) = output.next().await {
                match item {
                    Ok(bollard::container::LogOutput::StdOut { message }) => {
                        exec_output.push_str(&String::from_utf8_lossy(&message))
                    }
                    Ok(_) => {}
                    Err(e) => panic!("远程 exec 输出流出错: {e}"),
                }
            }
        }
        assert!(exec_output.contains("tunnel-exec-ok"), "exec 输出应经隧道返回");
        println!("exec 输出经隧道返回正常: {}", exec_output.trim());

        // 日志流（sleep 容器无输出，能建立流并干净结束即算通过）
        let log_stream = d.logs(
            &rt_id,
            Some(bollard::container::LogsOptions::<String> {
                stdout: true,
                tail: "100".into(),
                ..Default::default()
            }),
        );
        let log_chunks = log_stream.filter(|r| future::ready(r.is_ok())).count().await;
        println!("日志流正常结束，收到 {log_chunks} 个分块");

        // 统计流：取一个采样
        let mut stats = d.stats(
            &rt_id,
            Some(bollard::container::StatsOptions { stream: true, one_shot: false }),
        );
        let stat = tokio::time::timeout(std::time::Duration::from_secs(5), stats.next())
            .await
            .expect("远程统计采样超时")
            .expect("远程统计流不应为空")
            .expect("远程统计采样不应出错");
        assert!(stat.cpu_stats.is_some(), "统计采样应含 CPU 数据");
        println!("统计流采样正常");
        drop(stats);

        containers::container_action(rt_id, "remove".into(), true)
            .await
            .expect("清理远程测试容器应成功");
        println!("远程测试容器已删除");

        // 事件流：保持 1.5 秒不报错即认为流可用（事件是否到达取决于远程活动）
        {
            use futures::StreamExt;
            let mut events = d.events(None::<bollard::system::EventsOptions<String>>);
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
            while std::time::Instant::now() < deadline {
                if tokio::time::timeout(
                    deadline.saturating_duration_since(std::time::Instant::now()),
                    events.next(),
                )
                .await
                .is_err()
                {
                    break;
                }
            }
        }

        // compose CLI 环境：指向隧道本地端点并实际调用本机 docker CLI 验证连通
        let active = conn::active();
        assert!(active.tunnel_endpoint.is_some(), "ssh 连接激活后应记录隧道端点");
        let env = conn::cli_env(&active);
        let docker_host = env
            .iter()
            .find(|(k, _)| k == "DOCKER_HOST")
            .map(|(_, v)| v.clone())
            .expect("ssh 连接应注入 DOCKER_HOST");
        assert!(docker_host.starts_with("unix://"), "compose 应经隧道 socket 连接");
        let out = tokio::process::Command::new("docker")
            .args(["version", "--format", "{{.Server.Version}}"])
            .env("DOCKER_HOST", &docker_host)
            .output()
            .await
            .expect("本机 docker CLI 应可用");
        let cli_version = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert!(out.status.success(), "compose CLI 经隧道调用远程 daemon 应成功");
        assert_eq!(cli_version, version, "CLI 看到的远程版本应与 bollard 一致");
        println!("compose CLI 经隧道连到远程 daemon: {cli_version}");

        // 收尾：停隧道后旧 socket 不可连
        tunnel::stop(&profile.id);
    }
}
