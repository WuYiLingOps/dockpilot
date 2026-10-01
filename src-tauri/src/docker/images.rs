use std::collections::HashMap;

use bollard::auth::DockerCredentials;
use bollard::image::{
    CreateImageOptions, ImportImageOptions, ListImagesOptions, RemoveImageOptions, TagImageOptions,
};
use futures::StreamExt;
use tauri::ipc::Channel;
use tauri::Manager;

use super::conn::{docker, CmdResult};
use super::dto::{ExportProgress, ImageDto, PullProgress};
use super::state::Streams;
use crate::registries::{self, DOCKERHUB_HOST};
use crate::secret_store::{self, SecretBackend};
use crate::settings::{self, RegistryProfile};

/// 提取镜像引用的 registry 域名：首段形如域名（含 `.` / `:` 端口 / localhost）且还有
/// 后续段时取该段，否则视为官方 Docker Hub 镜像（docker.io）——与 docker 引用解析规则一致。
/// digest 引用（name@sha256:…）先剥离摘要部分
pub fn ref_registry_domain(image_ref: &str) -> String {
    let name = image_ref.split('@').next().unwrap_or(image_ref);
    let mut segments = name.split('/');
    let first = segments.next().unwrap_or_default();
    let has_more = segments.next().is_some();
    if has_more && (first.contains('.') || first.contains(':') || first == "localhost") {
        first.to_string()
    } else {
        DOCKERHUB_HOST.to_string()
    }
}

/// registry 域名等价比较：docker.io / index.docker.io / registry-1.docker.io 视为同一官方源
pub fn same_registry(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().to_lowercase();
    let (a, b) = (norm(a), norm(b));
    const HUB: [&str; 3] = ["docker.io", "index.docker.io", "registry-1.docker.io"];
    if HUB.contains(&a.as_str()) && HUB.contains(&b.as_str()) {
        return true;
    }
    a == b
}

/// 拉取报错原文 → 中文可操作提示（纯函数，可单测）
pub fn pull_error_hint(raw: &str) -> Option<String> {
    let l = raw.to_lowercase();
    if l.contains("toomanyrequests") || l.contains("pull rate limit") {
        Some("Docker Hub 匿名拉取额度已用尽：可稍后再试，或在 daemon 侧登录账号提升额度（docker login）".into())
    } else if l.contains("unauthorized") || l.contains("authentication required") {
        Some("需要认证：私有仓库镜像请在设置中添加对应仓库凭据（保存后拉取会自动匹配使用）".into())
    } else {
        None
    }
}

/// 按镜像引用的 registry 域名匹配凭据档案（Docker Hub 官方域名等价处理，多个匹配取首个）
fn match_profile_for_ref<'a>(
    image_ref: &str,
    profiles: &'a [RegistryProfile],
) -> Option<&'a RegistryProfile> {
    let domain = ref_registry_domain(image_ref);
    profiles
        .iter()
        .find(|p| same_registry(&p.registry, &domain))
}

/// 拉取前解析凭据：匹配档案 + 读取密钥，组装 X-Registry-Auth 凭据。
/// 无匹配档案或密钥缺失时返回 None（按匿名拉取，不阻塞拉取本身）
async fn resolve_pull_credentials(
    app: &tauri::AppHandle,
    image_ref: &str,
) -> Option<DockerCredentials> {
    let s = settings::load(app);
    let profile = match_profile_for_ref(image_ref, &s.registries)?.clone();
    let dir = secret_store::config_dir(app).ok()?;
    let backend = SecretBackend::parse(&profile.secret_backend).unwrap_or(SecretBackend::Keyring);
    let password = secret_store::load_secret(&dir, &registries::secret_key(&profile.id), backend)
        .ok()
        .flatten()?;
    log::info!(
        "拉取镜像 {image_ref} 使用凭据「{}」（{}）",
        profile.name,
        profile.registry
    );
    Some(DockerCredentials {
        username: Some(profile.username),
        password: Some(password),
        serveraddress: Some(format!("https://{}", profile.registry)),
        ..Default::default()
    })
}

#[tauri::command]
pub async fn list_images() -> CmdResult<Vec<ImageDto>> {
    let d = docker().await?;
    let list = d
        .list_images(Some(ListImagesOptions::<String> {
            all: false,
            digests: false,
            filters: HashMap::new(),
        }))
        .await
        .map_err(|e| format!("获取镜像列表失败: {e}"))?;
    Ok(list
        .into_iter()
        .map(|i| ImageDto {
            id: i.id,
            tags: i.repo_tags,
            size: i.size,
            created: i.created,
        })
        .collect())
}

#[tauri::command]
pub async fn remove_image(id: String, force: bool) -> CmdResult<()> {
    log::info!("删除镜像 {id}{}", if force { "（force）" } else { "" });
    let d = docker().await?;
    d.remove_image(
        &id,
        Some(RemoveImageOptions {
            force,
            noprune: false,
        }),
        None,
    )
    .await
    .map_err(|e| format!("删除镜像失败: {e}"))?;
    Ok(())
}

/// 拉取引用规范化：缺 tag 时默认补 latest（如 `nginx` → `nginx:latest`），
/// digest 引用（name@sha256:…）原样透传由引擎解析
fn normalize_pull_reference(image: &str) -> Result<String, String> {
    let image = image.trim();
    if image.is_empty() {
        return Err("请填写镜像名称".into());
    }
    if image.contains('@') {
        return Ok(image.to_string());
    }
    let (repo, tag) = parse_image_reference(image)?;
    Ok(format!("{repo}:{tag}"))
}

/// 拉取镜像，进度通过 Channel 推送；返回 stream_id 供前端取消
#[tauri::command]
pub async fn pull_image(
    app: tauri::AppHandle,
    image: String,
    on_progress: Channel<PullProgress>,
) -> CmdResult<String> {
    let image = normalize_pull_reference(&image)?;
    log::info!("拉取镜像 {image}");
    let d = docker().await?;
    // 私有仓库凭据：按镜像引用的 registry 域名自动匹配已保存凭据（无匹配则匿名拉取）
    let credentials = resolve_pull_credentials(&app, &image).await;
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let image_label = image.clone();
        let opts = CreateImageOptions::<String> {
            from_image: image,
            ..Default::default()
        };
        let mut stream = d.create_image(Some(opts), None, credentials);
        let mut last_err: Option<String> = None;
        let mut cancelled = false;

        loop {
            tokio::select! {
                _ = token.cancelled() => {
                    cancelled = true;
                    break;
                }
                item = stream.next() => match item {
                    Some(Ok(info)) => {
                        let msg = PullProgress {
                            status: info.status.clone(),
                            id: info.id.clone(),
                            progress: info.progress.clone(),
                            error: None,
                            done: false,
                        };
                        if on_progress.send(msg).is_err() {
                            cancelled = true;
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        last_err = Some(e.to_string());
                        break;
                    }
                    None => break,
                }
            }
        }

        if let Some(err) = &last_err {
            log::warn!("拉取镜像 {image_label} 失败: {err}");
        } else if cancelled {
            log::info!("拉取镜像 {image_label} 已取消");
        } else {
            log::info!("拉取镜像 {image_label} 完成");
        }

        let final_err = last_err.map(|e| match pull_error_hint(&e) {
            Some(hint) => format!("{e}\n提示：{hint}"),
            None => e,
        });
        let _ = on_progress.send(PullProgress {
            status: None,
            id: None,
            progress: None,
            error: final_err,
            done: true,
        });
        app.state::<Streams>().remove(&sid_task);
    });

    Ok(sid)
}

/// 导出镜像为 tar 归档（docker save；单镜像与勾选批量共用同一命令，共享层自动去重）。
/// 字节流边收边写盘、不整包进内存；进度按 100ms 节流推送；取消/出错时删除半成品文件。
#[tauri::command]
pub async fn export_images(
    app: tauri::AppHandle,
    refs: Vec<String>,
    path: String,
    on_progress: Channel<ExportProgress>,
) -> CmdResult<String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("导出路径不能为空".into());
    }
    let names: Vec<String> = refs
        .iter()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .collect();
    if names.is_empty() {
        return Err("请选择要导出的镜像".into());
    }

    let d = docker().await?;
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    log::info!("导出镜像 ×{} → {path}", names.len());
    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncWriteExt;

        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut stream = d.export_images(&refs);

        let mut cancelled = false;
        let mut error: Option<String> = None;
        let mut written: u64 = 0;
        let mut last_send = std::time::Instant::now() - std::time::Duration::from_secs(1);

        match tokio::fs::File::create(&path).await {
            Ok(mut file) => {
                loop {
                    tokio::select! {
                        _ = token.cancelled() => {
                            cancelled = true;
                            break;
                        }
                        item = stream.next() => match item {
                            Some(Ok(chunk)) => {
                                if let Err(e) = file.write_all(&chunk).await {
                                    error = Some(format!("写入文件失败: {e}"));
                                    break;
                                }
                                written += chunk.len() as u64;
                                // 引擎侧无总量可报，按固定间隔推送已写入字节数
                                if last_send.elapsed() >= std::time::Duration::from_millis(100) {
                                    last_send = std::time::Instant::now();
                                    let _ = on_progress.send(ExportProgress {
                                        written,
                                        done: false,
                                        error: None,
                                        cancelled: false,
                                    });
                                }
                            }
                            Some(Err(e)) => {
                                error = Some(format!("导出镜像失败: {e}"));
                                break;
                            }
                            None => break,
                        }
                    }
                }
                let _ = file.flush().await;
            }
            Err(e) => error = Some(format!("创建文件失败: {e}")),
        }

        if error.is_some() || cancelled {
            // 半成品 tar 无法使用，直接清理
            let _ = tokio::fs::remove_file(&path).await;
        }
        if let Some(err) = &error {
            log::warn!("导出镜像失败（{path}）: {err}");
        } else if cancelled {
            log::info!("导出镜像已取消（{path}）");
        } else {
            log::info!(
                "导出镜像完成：{} 个镜像，{} → {path}",
                names.len(),
                crate::format_bytes(written)
            );
        }
        let _ = on_progress.send(ExportProgress {
            written,
            done: true,
            error,
            cancelled,
        });
        app.state::<Streams>().remove(&sid_task);
    });

    Ok(sid)
}

/// 导入镜像 tar（docker load；归档内可含多个镜像），进度逐行推送；返回 stream_id 供取消
#[tauri::command]
pub async fn import_image(
    app: tauri::AppHandle,
    path: String,
    on_progress: Channel<PullProgress>,
) -> CmdResult<String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("导入路径不能为空".into());
    }
    log::info!("导入镜像：{path}");

    let d = docker().await?;
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        use tokio_util::codec::{BytesCodec, FramedRead};

        let mut cancelled = false;
        let mut error: Option<String> = None;

        match tokio::fs::File::open(&path).await {
            Ok(file) => {
                // 读文件出错时提前结束上传，引擎会因请求体截断在响应流中报错
                let upload = FramedRead::new(file, BytesCodec::new())
                    .take_while(|r| futures::future::ready(r.is_ok()))
                    .map(|r| r.unwrap().freeze());
                let mut stream =
                    d.import_image_stream(ImportImageOptions { quiet: false }, upload, None);
                loop {
                    tokio::select! {
                        _ = token.cancelled() => {
                            cancelled = true;
                            break;
                        }
                        item = stream.next() => match item {
                            Some(Ok(info)) => {
                                let msg = PullProgress {
                                    status: info.status.clone().or_else(|| info.stream.clone()),
                                    id: info.id.clone(),
                                    progress: info.progress.clone(),
                                    error: None,
                                    done: false,
                                };
                                if on_progress.send(msg).is_err() {
                                    break;
                                }
                            }
                            Some(Err(e)) => {
                                error = Some(format!("导入镜像失败: {e}"));
                                break;
                            }
                            None => break,
                        }
                    }
                }
            }
            Err(e) => error = Some(format!("读取文件失败: {e}")),
        }

        if cancelled {
            log::info!("导入镜像已取消（{path}）");
        } else if let Some(err) = &error {
            log::warn!("导入镜像失败（{path}）: {err}");
        } else {
            log::info!("导入镜像完成：{path}");
        }

        let _ = on_progress.send(PullProgress {
            status: None,
            id: None,
            progress: None,
            error: if cancelled {
                Some("已取消".into())
            } else {
                error
            },
            done: true,
        });
        app.state::<Streams>().remove(&sid_task);
    });

    Ok(sid)
}

/// 拆分镜像引用为 repo + tag：最后一个冒号后不含斜杠时视为 tag
/// （兼容 `registry:5000/ns/name:v1` 的端口写法），缺 tag 补 latest
pub(crate) fn parse_image_reference(reference: &str) -> Result<(String, String), String> {
    let r = reference.trim();
    if r.is_empty() {
        return Err("请填写镜像引用".into());
    }
    if r.contains(char::is_whitespace) {
        return Err(format!("镜像引用不能包含空白: {r}"));
    }
    if r.contains('@') {
        return Err("暂不支持以 digest（@sha256:…）引用打标签，请使用名称:标签".into());
    }
    let (repo, tag) = match r.rsplit_once(':') {
        Some((repo, tag)) if !tag.contains('/') => {
            if repo.is_empty() || tag.is_empty() {
                return Err(format!("镜像引用不合法: {r}"));
            }
            (repo, tag)
        }
        _ => (r, "latest"),
    };
    if repo.is_empty() || tag.is_empty() {
        return Err(format!("镜像引用不合法: {r}"));
    }
    Ok((repo.to_string(), tag.to_string()))
}

/// 为镜像打新标签（docker tag），新旧标签指向同一镜像 ID
#[tauri::command]
pub async fn tag_image(id: String, reference: String) -> CmdResult<()> {
    log::info!("镜像打标签：{id} → {reference}");
    let (repo, tag) = parse_image_reference(&reference)?;
    let d = docker().await?;
    d.tag_image(&id, Some(TagImageOptions { repo, tag }))
        .await
        .map_err(|e| format!("打标签失败: {e}"))?;
    Ok(())
}

/// 移除镜像的某一个标签（untag）；当它是该镜像最后一个标签时会连带删除镜像，
/// 返回值表示镜像本体是否已被删除
#[tauri::command]
pub async fn untag_image(reference: String) -> CmdResult<bool> {
    log::info!("移除镜像标签：{reference}");
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("镜像引用不能为空".into());
    }
    let d = docker().await?;
    let items = d
        .remove_image(
            reference,
            Some(RemoveImageOptions {
                force: false,
                noprune: false,
            }),
            None,
        )
        .await
        .map_err(|e| format!("移除标签失败: {e}"))?;
    Ok(items.iter().any(|i| i.deleted.is_some()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_split_repo_and_tag() {
        // 无 tag 补 latest
        assert_eq!(
            parse_image_reference("nginx").unwrap(),
            ("nginx".into(), "latest".into())
        );
        assert_eq!(
            parse_image_reference("  nginx:1.27 ").unwrap(),
            ("nginx".into(), "1.27".into())
        );
        // 命名空间 + tag
        assert_eq!(
            parse_image_reference("registry.cn-hangzhou.aliyuncs.com/ns/redis:7-alpine").unwrap(),
            (
                "registry.cn-hangzhou.aliyuncs.com/ns/redis".into(),
                "7-alpine".into()
            )
        );
        // registry 端口不应被误认为 tag 分隔
        assert_eq!(
            parse_image_reference("localhost:5000/img").unwrap(),
            ("localhost:5000/img".into(), "latest".into())
        );
        assert_eq!(
            parse_image_reference("localhost:5000/img:v1").unwrap(),
            ("localhost:5000/img".into(), "v1".into())
        );
    }

    #[test]
    fn reference_split_rejects_invalid() {
        assert!(parse_image_reference("").is_err());
        assert!(parse_image_reference("   ").is_err());
        assert!(parse_image_reference(":tag").is_err(), "缺 repo 应拒绝");
        assert!(parse_image_reference("nginx:").is_err(), "缺 tag 应拒绝");
        assert!(
            parse_image_reference("nginx :latest").is_err(),
            "含空白应拒绝"
        );
        assert!(
            parse_image_reference("nginx@sha256:abcd").is_err(),
            "digest 引用应拒绝"
        );
    }

    #[test]
    fn pull_reference_defaults_to_latest_tag() {
        // 缺 tag 补 latest
        assert_eq!(normalize_pull_reference("nginx").unwrap(), "nginx:latest");
        assert_eq!(
            normalize_pull_reference("  nginx ").unwrap(),
            "nginx:latest"
        );
        // 已带 tag 原样保留
        assert_eq!(
            normalize_pull_reference("nginx:1.27").unwrap(),
            "nginx:1.27"
        );
        assert_eq!(
            normalize_pull_reference("redis:7-alpine").unwrap(),
            "redis:7-alpine"
        );
        // 命名空间 / registry 端口写法不受端口误导
        assert_eq!(
            normalize_pull_reference("registry.cn-hangzhou.aliyuncs.com/ns/redis").unwrap(),
            "registry.cn-hangzhou.aliyuncs.com/ns/redis:latest"
        );
        assert_eq!(
            normalize_pull_reference("localhost:5000/img").unwrap(),
            "localhost:5000/img:latest"
        );
        // digest 引用透传
        assert_eq!(
            normalize_pull_reference("nginx@sha256:abcd").unwrap(),
            "nginx@sha256:abcd"
        );
        // 非法输入报错
        assert!(normalize_pull_reference("").is_err());
        assert!(normalize_pull_reference("   ").is_err());
        assert!(normalize_pull_reference("nginx:").is_err());
        assert!(normalize_pull_reference("nginx :x").is_err());
    }

    #[test]
    fn ref_domain_extraction() {
        // 无域名前缀（单段）= 官方镜像
        assert_eq!(ref_registry_domain("nginx"), "docker.io");
        assert_eq!(ref_registry_domain("nginx:1.27"), "docker.io");
        assert_eq!(ref_registry_domain("nginx@sha256:abcd"), "docker.io");
        // 多段且首段形如域名
        assert_eq!(
            ref_registry_domain("registry.cn-hangzhou.aliyuncs.com/wylhub/redis:7"),
            "registry.cn-hangzhou.aliyuncs.com"
        );
        assert_eq!(
            ref_registry_domain("localhost:5000/app:1"),
            "localhost:5000"
        );
        assert_eq!(
            ref_registry_domain("harbor.local:8443/proj/app@sha256:abcd"),
            "harbor.local:8443"
        );
    }

    #[test]
    fn same_registry_hub_aliases() {
        assert!(same_registry("docker.io", "index.docker.io"));
        assert!(same_registry("docker.io", "registry-1.docker.io"));
        assert!(same_registry("Docker.IO", "docker.io"));
        assert!(!same_registry("docker.io", "harbor.local"));
        assert!(same_registry("Harbor.Local:8443 ", "harbor.local:8443"));
    }

    #[test]
    fn match_profile_by_ref_domain() {
        let profiles = vec![
            RegistryProfile {
                id: "hub".into(),
                kind: "generic".into(),
                registry: "docker.io".into(),
                username: "u".into(),
                ..Default::default()
            },
            RegistryProfile {
                id: "harbor".into(),
                kind: "harbor".into(),
                registry: "harbor.local:8443".into(),
                username: "u2".into(),
                ..Default::default()
            },
        ];
        // 官方镜像命中 Docker Hub 档案
        assert_eq!(
            match_profile_for_ref("nginx:latest", &profiles).map(|p| p.id.as_str()),
            Some("hub")
        );
        // 带端口域名精确命中
        assert_eq!(
            match_profile_for_ref("harbor.local:8443/proj/app", &profiles).map(|p| p.id.as_str()),
            Some("harbor")
        );
        // 无匹配 → None（匿名拉取）
        assert!(match_profile_for_ref("quay.io/foo/bar", &profiles).is_none());
    }

    #[test]
    fn pull_hint_maps_rate_limit_and_auth() {
        assert!(
            pull_error_hint("toomanyrequests: You have reached your pull rate limit").is_some()
        );
        assert!(pull_error_hint("HTTP 401 unauthorized").is_some());
        assert!(pull_error_hint("connection refused").is_none());
    }
}
