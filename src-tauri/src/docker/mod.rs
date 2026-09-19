pub mod conn;
pub mod containers;
pub mod dto;
pub mod events;
pub mod exec;
pub mod images;
pub mod logs;
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
}
