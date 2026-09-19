use std::sync::OnceLock;

use bollard::{API_DEFAULT_VERSION, Docker};

use crate::settings;

/// 命令层统一错误类型：字符串直接返回给前端展示
pub type CmdResult<T> = Result<T, String>;

/// 连接缓存：bollard 的 hyper 连接池可跨命令复用，无需每次重建。
/// socket 路径来自设置（settings::docker_socket），修改需重启应用生效。
static DOCKER: OnceLock<Docker> = OnceLock::new();

pub async fn docker() -> CmdResult<Docker> {
    if let Some(d) = DOCKER.get() {
        return Ok(d.clone());
    }
    let d = connect()?;
    let _ = DOCKER.set(d.clone());
    Ok(d)
}

fn connect() -> CmdResult<Docker> {
    let err = |e: bollard::errors::Error| {
        format!("连接 Docker daemon 失败: {e}（请确认 Docker 正在运行，且当前用户在 docker 组）")
    };
    match settings::docker_socket() {
        Some(path) => Docker::connect_with_socket(&path, 120, API_DEFAULT_VERSION)
            .map_err(|e| format!("连接 Docker daemon 失败（socket: {path}）: {e}")),
        None => Docker::connect_with_socket_defaults().map_err(err),
    }
}
