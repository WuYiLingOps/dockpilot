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
