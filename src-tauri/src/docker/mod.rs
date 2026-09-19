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

#[cfg(test)]
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
}
