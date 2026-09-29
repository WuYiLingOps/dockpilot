//! 镜像推送（docker push）：凭据经 X-Registry-Auth 头随请求传给 daemon，
//! 由当前连接的 daemon 执行推送（SSH 远程连接时在远端推，仓库需从远端可达）。
//! 进度按层逐条推送，无总字节数（与 pull 同构）；支持取消。

use bollard::auth::DockerCredentials;
use bollard::image::PushImageOptions;
use futures::StreamExt;
use tauri::ipc::Channel;
use tauri::Manager;

use super::conn::{docker, CmdResult};
use super::dto::PushProgress;
use super::images::parse_image_reference;
use super::state::Streams;
use crate::secret_store::{self, SecretBackend};
use crate::settings::{self, RegistryProfile};

/// 推送目标引用组装：`{registry}/{repository}:{tag}`
/// 校验仓库名符合 docker 规范（小写、不含 tag/scheme），返回完整引用
pub fn compose_target_ref(registry_host: &str, repository: &str, tag: &str) -> Result<String, String> {
    let repository = repository.trim().trim_matches('/');
    if repository.is_empty() {
        return Err("请填写仓库名（如 namespace/myapp）".into());
    }
    if repository.contains(char::is_whitespace) {
        return Err(format!("仓库名不能包含空白: {repository}"));
    }
    if repository.starts_with("http://") || repository.starts_with("https://") {
        return Err("仓库名不需要协议前缀，填 namespace/myapp 即可".into());
    }
    if repository.contains(':') {
        return Err("仓库名不应包含标签，请把标签填到单独的输入框".into());
    }
    if repository != repository.to_lowercase() {
        return Err("仓库名必须为小写（Docker 规范）".into());
    }
    let tag = tag.trim();
    if tag.is_empty() || tag.contains(char::is_whitespace) || tag.contains('/') || tag.contains(':') {
        return Err(format!("标签不合法: {tag}"));
    }
    if registry_host.is_empty() {
        return Err("仓库地址为空，请检查凭据配置".into());
    }
    Ok(format!("{registry_host}/{repository}:{tag}"))
}

/// daemon 报错原文 → 中文可操作提示（纯函数，可单测）
pub fn push_error_hint(raw: &str) -> Option<String> {
    let l = raw.to_lowercase();
    if l.contains("unauthorized") || l.contains("authentication required") || l.contains("401") {
        Some("认证失败：请检查用户名与密码/令牌（Harbor 机器人账户需已启用且未过期；阿里云需使用登录账号或仓库固定密码）".into())
    } else if l.contains("denied") || l.contains("requested access") {
        Some("无推送权限：Harbor 需项目已存在且账号有写权限；阿里云需命名空间已创建".into())
    } else if l.contains("server gave http response to https client") {
        Some("目标仓库为 HTTP 服务：需在 Docker daemon 的 daemon.json 中将仓库地址加入 insecure-registries 并重启 Docker（应用内\"设置-镜像加速\"旁可编辑 daemon.json）".into())
    } else if l.contains("x509") || l.contains("certificate") || l.contains("tls handshake") {
        Some("TLS 证书校验失败：自签名证书需在 daemon.json 的 insecure-registries 中加入仓库地址，或向系统导入 CA 证书".into())
    } else if l.contains("connection refused")
        || l.contains("timeout")
        || l.contains("deadline exceeded")
        || l.contains("no such host")
        || l.contains("connection reset")
        || l.contains("unreachable")
    {
        Some("无法连接仓库：检查网络与仓库地址；远程连接时需远端 Docker 宿主机可访问该仓库".into())
    } else {
        None
    }
}

/// 拼装最终错误消息（原文 + 可操作提示）
fn compose_push_error(raw: &str) -> String {
    match push_error_hint(raw) {
        Some(hint) => format!("推送失败: {raw}\n提示：{hint}"),
        None => format!("推送失败: {raw}"),
    }
}

/// 推送镜像到指定仓库：目标引用与本地引用不同时先自动打标签。
/// 进度经 Channel 推送，返回 stream_id 供前端取消。
#[tauri::command]
pub async fn push_image(
    app: tauri::AppHandle,
    image_ref: String,
    registry_id: String,
    repository: String,
    tag: String,
    on_progress: Channel<PushProgress>,
) -> CmdResult<String> {
    let image_ref = image_ref.trim().to_string();
    if image_ref.is_empty() {
        return Err("请选择要推送的镜像".into());
    }

    // 凭据：档案 + 密钥（均在本地，随请求头传给 daemon，不落远端）
    let s = settings::load(&app);
    let profile = s
        .registries
        .iter()
        .find(|r| r.id == registry_id)
        .ok_or_else(|| "仓库凭据不存在或已被删除".to_string())?
        .clone();
    let dir = secret_store::config_dir(&app)?;
    let backend = SecretBackend::parse(&profile.secret_backend).unwrap_or(SecretBackend::Keyring);
    let password = secret_store::load_secret(&dir, &secret_key(&profile.id), backend)?
        .ok_or_else(|| "未找到已保存的密码，请到设置中重新编辑该凭据".to_string())?;

    let target = compose_target_ref(&profile.registry, &repository, &tag)?;
    let (target_repo, target_tag) = parse_image_reference(&target)?;

    let d = docker().await?;
    // 本地引用 ≠ 目标引用时先打标签（同一镜像 ID，无额外存储）
    if image_ref != target {
        d.tag_image(
            &image_ref,
            Some(bollard::image::TagImageOptions {
                repo: target_repo.clone(),
                tag: target_tag.clone(),
            }),
        )
        .await
        .map_err(|e| format!("自动打标签失败: {e}"))?;
    }

    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();
    let credentials = DockerCredentials {
        username: Some(profile.username.clone()),
        password: Some(password),
        serveraddress: Some(format!("https://{}", profile.registry)),
        ..Default::default()
    };

    tauri::async_runtime::spawn(async move {
        // push 的 image 名不含 tag，tag 走查询参数
        let mut stream = d.push_image(
            &target_repo,
            Some(PushImageOptions {
                tag: target_tag.clone(),
            }),
            Some(credentials),
        );

        let mut cancelled = false;
        let mut last_err: Option<String> = None;

        loop {
            tokio::select! {
                _ = token.cancelled() => {
                    cancelled = true;
                    break;
                }
                item = stream.next() => match item {
                    Some(Ok(info)) => {
                        let msg = PushProgress {
                            status: info.status.clone(),
                            progress: info.progress.clone(),
                            current: info.progress_detail.as_ref().and_then(|p| p.current.map(|v| v.max(0) as u64)),
                            total: info.progress_detail.as_ref().and_then(|p| p.total.map(|v| v.max(0) as u64)),
                            error: None,
                            done: false,
                            cancelled: false,
                        };
                        if on_progress.send(msg).is_err() {
                            break;
                        }
                    }
                    // bollard 已把 registry 的 error 帧转为 Err(DockerStreamError)
                    Some(Err(e)) => {
                        last_err = Some(e.to_string());
                        break;
                    }
                    None => break,
                }
            }
        }

        let error = if cancelled {
            None
        } else {
            last_err.as_deref().map(compose_push_error)
        };
        let _ = on_progress.send(PushProgress {
            status: None,
            progress: None,
            current: None,
            total: None,
            error,
            done: true,
            cancelled,
        });
        app.state::<Streams>().remove(&sid_task);
    });

    Ok(sid)
}

fn secret_key(profile_id: &str) -> String {
    format!("registry/{profile_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_ref_composes_registry_repo_tag() {
        assert_eq!(
            compose_target_ref("registry.cn-hangzhou.aliyuncs.com", "myns/myapp", "v1").unwrap(),
            "registry.cn-hangzhou.aliyuncs.com/myns/myapp:v1"
        );
        // harbor 带端口 + 多级路径
        assert_eq!(
            compose_target_ref("harbor.local:5000", "project/sub/app", "latest").unwrap(),
            "harbor.local:5000/project/sub/app:latest"
        );
        // 仓库名首尾斜杠被清理
        assert_eq!(
            compose_target_ref("r.local", "/app/", "v2").unwrap(),
            "r.local/app:v2"
        );
    }

    #[test]
    fn target_ref_rejects_invalid_repository() {
        assert!(compose_target_ref("r.local", "", "v1").is_err(), "空仓库名应拒绝");
        assert!(compose_target_ref("r.local", "MyApp", "v1").is_err(), "大写应拒绝");
        assert!(compose_target_ref("r.local", "ns/app:v2", "v1").is_err(), "仓库名含 tag 应拒绝");
        assert!(compose_target_ref("r.local", "https://ns/app", "v1").is_err(), "协议前缀应拒绝");
        assert!(compose_target_ref("r.local", "ns app", "v1").is_err(), "空白应拒绝");
        assert!(compose_target_ref("", "ns/app", "v1").is_err(), "空 registry 应拒绝");
    }

    #[test]
    fn error_hint_maps_registry_failures() {
        assert!(push_error_hint("unauthorized: authentication required").is_some());
        assert!(push_error_hint("denied: requested access to the resource is denied").is_some());
        assert!(push_error_hint("http: server gave HTTP response to HTTPS client").is_some());
        assert!(push_error_hint("x509: certificate signed by unknown authority").is_some());
        assert!(push_error_hint("dial tcp: connection refused").is_some());
        assert!(push_error_hint("context deadline exceeded").is_some());
        assert!(push_error_hint("manifest blob unknown").is_none(), "未知错误不硬造提示");
    }

    #[test]
    fn compose_error_appends_hint() {
        let msg = compose_push_error("unauthorized: authentication required");
        assert!(msg.contains("推送失败"));
        assert!(msg.contains("提示"));
        let plain = compose_push_error("weird error");
        assert_eq!(plain, "推送失败: weird error");
    }
}
