mod cleanup;
mod daemon_config;
mod docker;
mod settings;

use tauri::Manager;
use tokio::sync::broadcast;

use docker::dto::DockerEventDto;
use docker::state::{ExecSessions, Streams};

/// 当前运行平台（std::env::consts::OS："linux" / "windows" / "macos"），
/// 前端据此适配入口与提示文案
#[tauri::command]
fn platform() -> String {
    std::env::consts::OS.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK 在部分 NVIDIA 驱动上 DMABUF 渲染会黑屏/花屏，检测到 NVIDIA 时自动兜底
    // （Windows 走 WebView2，无此问题）
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::path::Path::new("/proc/driver/nvidia").exists()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Linux 下窗口图标需要手动设置：X11 会话的标题栏/任务栏读取窗口图标，
            // Wayland 会话则由 app-id 与 .desktop 文件匹配（deb 安装后生效）
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }

            // 加载设置（含旧配置迁移），初始化活跃连接；连接在首次命令时惰性建立
            let s = settings::load(app.handle());
            if let Some(profile) = settings::find_connection(&s, &s.active_connection_id) {
                docker::conn::init_active(profile.clone());
            } else {
                docker::conn::init_active(settings::ConnectionProfile::default_local());
            }

            let (tx, _) = broadcast::channel::<DockerEventDto>(256);
            app.manage(tx.clone());
            app.manage(Streams::default());
            app.manage(ExecSessions::default());

            docker::events::start_global_listener(tx);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform,
            docker::system::docker_info,
            docker::system::host_stats,
            docker::system::system_df,
            docker::containers::list_containers,
            docker::containers::container_action,
            docker::containers::create_container,
            docker::networks::list_networks,
            docker::networks::create_network,
            docker::networks::remove_network,
            docker::networks::connect_network,
            docker::networks::disconnect_network,
            docker::volumes::list_volumes,
            docker::volumes::create_volume,
            docker::volumes::remove_volume,
            docker::compose::list_compose_projects,
            docker::compose::compose_cli_info,
            docker::compose::compose_action,
            docker::compose::compose_deploy,
            docker::compose::read_compose_file,
            docker::compose::write_compose_file,
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
            docker::conn::switch_connection,
            docker::conn::test_connection,
            settings::get_settings,
            settings::set_settings,
            daemon_config::read_daemon_config,
            daemon_config::apply_mirrors,
            daemon_config::restart_docker,
            daemon_config::generate_mirrors_command,
            daemon_config::test_mirror,
            cleanup::disk_usage,
            cleanup::cleanup,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // 退出时回收 SSH 隧道子进程，避免遗留孤儿 ssh
            if let tauri::RunEvent::Exit = event {
                docker::tunnel::stop_all();
            }
        });
}
