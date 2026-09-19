use bollard::Docker;

/// 命令层统一错误类型：字符串直接返回给前端展示
pub type CmdResult<T> = Result<T, String>;

pub async fn docker() -> CmdResult<Docker> {
    Docker::connect_with_socket_defaults()
        .map_err(|e| format!("连接 Docker daemon 失败: {e}（请确认 Docker 正在运行，且当前用户在 docker 组）"))
}
