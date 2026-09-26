use std::collections::HashMap;

use bollard::image::{
    CreateImageOptions, ImportImageOptions, ListImagesOptions, RemoveImageOptions,
    TagImageOptions,
};
use futures::StreamExt;
use tauri::ipc::Channel;
use tauri::Manager;

use super::conn::{docker, CmdResult};
use super::dto::{ExportProgress, ImageDto, PullProgress};
use super::state::Streams;

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

/// 拉取镜像，进度通过 Channel 推送；返回 stream_id 供前端取消
#[tauri::command]
pub async fn pull_image(
    app: tauri::AppHandle,
    image: String,
    on_progress: Channel<PullProgress>,
) -> CmdResult<String> {
    let d = docker().await?;
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let opts = CreateImageOptions::<String> {
            from_image: image,
            ..Default::default()
        };
        let mut stream = d.create_image(Some(opts), None, None);
        let mut last_err: Option<String> = None;

        loop {
            tokio::select! {
                _ = token.cancelled() => break,
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

        let _ = on_progress.send(PullProgress {
            status: None,
            id: None,
            progress: None,
            error: last_err,
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
                let mut stream = d.import_image_stream(
                    ImportImageOptions { quiet: false },
                    upload,
                    None,
                );
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

        let _ = on_progress.send(PullProgress {
            status: None,
            id: None,
            progress: None,
            error: if cancelled { Some("已取消".into()) } else { error },
            done: true,
        });
        app.state::<Streams>().remove(&sid_task);
    });

    Ok(sid)
}

/// 拆分镜像引用为 repo + tag：最后一个冒号后不含斜杠时视为 tag
/// （兼容 `registry:5000/ns/name:v1` 的端口写法），缺 tag 补 latest
fn parse_image_reference(reference: &str) -> Result<(String, String), String> {
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
}
