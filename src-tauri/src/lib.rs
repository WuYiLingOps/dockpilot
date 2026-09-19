mod docker;

use std::time::Duration;

use tauri::Manager;
use tokio::sync::broadcast;

use docker::dto::DockerEventDto;
use docker::state::{ExecSessions, Streams};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK 在部分 NVIDIA 驱动上 DMABUF 渲染会黑屏/花屏，检测到 NVIDIA 时自动兜底
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::path::Path::new("/proc/driver/nvidia").exists()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let (tx, _) = broadcast::channel::<DockerEventDto>(256);
            app.manage(tx.clone());
            app.manage(Streams::default());
            app.manage(ExecSessions::default());

            docker::events::spawn_global_listener(tx);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            docker::system::docker_info,
            docker::containers::list_containers,
            docker::containers::container_action,
            docker::images::list_images,
            docker::images::remove_image,
            docker::images::pull_image,
            docker::logs::stream_logs,
            docker::stats::stream_stats,
            docker::events::subscribe_events,
            docker::exec::exec_create,
            docker::exec::exec_attach,
            docker::exec::exec_input,
            docker::exec::exec_resize,
            docker::state::cancel_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
