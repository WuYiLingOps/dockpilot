use std::collections::HashMap;

use bollard::image::{CreateImageOptions, ListImagesOptions, RemoveImageOptions};
use futures::StreamExt;
use tauri::ipc::Channel;
use tauri::Manager;

use super::conn::{docker, CmdResult};
use super::dto::{ImageDto, PullProgress};
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
