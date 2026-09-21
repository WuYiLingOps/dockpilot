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

/// 卷/网络名称约束：[a-zA-Z0-9][a-zA-Z0-9_.-]*，与 docker CLI 一致；
/// 提前校验以给出中文可读错误，其余非法值由 daemon 兜底拒绝
pub(super) fn validate_resource_name(name: &str, label: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let valid = match chars.next() {
        Some(c) => {
            c.is_ascii_alphanumeric()
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        }
        None => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "{label}名称只能包含字母、数字、下划线、点和中划线，且以字母或数字开头"
        ))
    }
}
