mod cleanup;
mod daemon_config;
mod docker;
mod github_sync;
mod registries;
mod secret_store;
mod settings;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tokio::sync::broadcast;

use docker::dto::DockerEventDto;
use docker::state::{ExecSessions, Streams};

/// 当前运行平台（std::env::consts::OS："linux" / "windows" / "macos"），
/// 前端据此适配入口与提示文案
#[tauri::command]
fn platform() -> String {
    std::env::consts::OS.to_string()
}

/// 关闭询问弹窗的回传：决定本次关闭行为；remember 时把选择持久化，
/// 之后同类关闭不再询问。exit 走 app.exit 触发 RunEvent::Exit → 回收 SSH 隧道
#[tauri::command]
fn apply_close_action(app: tauri::AppHandle, action: String, remember: bool) -> Result<(), String> {
    if !["minimize", "exit"].contains(&action.as_str()) {
        return Err(format!("未知的关闭行为: {action}"));
    }
    if remember {
        let mut s = settings::load(&app);
        s.close_action = action.clone();
        settings::save(&app, &s)?;
    }
    match action.as_str() {
        "minimize" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        "exit" => app.exit(0),
        _ => {}
    }
    Ok(())
}

/// Windows 原生窗口圆角（DWMWA_WINDOW_CORNER_PREFERENCE，Win11 的 8px Fluent 标准，
/// 自带抗锯齿与系统阴影；Windows 10 无此 API，静默失败显示直角）。
/// hwnd 的指针宽度跨 windows crate 版本可能不同（isize / *mut c_void），经 c_void 中转
#[cfg(windows)]
fn apply_window_corner(window: &tauri::WebviewWindow, round: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWM_WINDOW_CORNER_PREFERENCE,
        DWMWCP_DONOTROUND, DWMWCP_ROUND,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let pref = if round { DWMWCP_ROUND } else { DWMWCP_DONOTROUND };
    unsafe {
        let _ = DwmSetWindowAttribute(
            HWND(hwnd.0 as *mut std::ffi::c_void),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const DWM_WINDOW_CORNER_PREFERENCE as *const std::ffi::c_void,
            std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
        );
    }
}

/// 显示并聚焦主窗口（托盘点击 / 托盘菜单 / 二次启动唤起共用）
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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
        // 单实例：托盘常驻后二次启动只唤起已有窗口，官方要求注册在第一个
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Linux 下窗口图标需要手动设置：X11 会话的标题栏/任务栏读取窗口图标，
            // Wayland 会话则由 app-id 与 .desktop 文件匹配（deb 安装后生效）
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }

            // Windows 用原生 DWM 圆角（Win11 自带抗锯齿与系统阴影），
            // 窗口不透明（tauri.windows.conf.json），不用 Linux 的 CSS 裁剪方案
            #[cfg(windows)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    apply_window_corner(&window, true);
                    let corner_window = window.clone();
                    window.on_window_event(move |event| {
                        // 最大化/全屏恢复直角（与 Linux 端 main.tsx 的行为一致）
                        if matches!(event, tauri::WindowEvent::Resized(_)) {
                            let square = corner_window.is_maximized().unwrap_or(false)
                                || corner_window.is_fullscreen().unwrap_or(false);
                            apply_window_corner(&corner_window, !square);
                        }
                    });
                }
            }

            // 系统托盘：后台常驻入口。Linux 上左键单击事件不可靠（appindicator 限制），
            // 菜单里的「显示 DockPilot」是恢复窗口的兜底途径
            if let Some(icon) = app.default_window_icon() {
                let show = MenuItem::with_id(app, "show", "显示 DockPilot", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let tray_menu = Menu::with_items(app, &[&show, &quit])?;
                TrayIconBuilder::new()
                    .icon(icon.clone())
                    .tooltip("DockPilot")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main(app),
                        // 走 app.exit 而非关窗口：触发 RunEvent::Exit → 回收 SSH 隧道
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main(tray.app_handle());
                        }
                    })
                    .build(app)?;
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

            docker::events::start_global_listener(app.handle(), tx);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform,
            apply_close_action,
            docker::system::docker_info,
            docker::system::host_stats,
            docker::system::system_df,
            docker::system::inspect_docker,
            docker::containers::list_containers,
            docker::containers::container_action,
            docker::containers::create_container,
            docker::containers::container_health,
            docker::containers::container_top,
            docker::containers::update_container_config,
            docker::containers::container_spec,
            docker::containers::parse_docker_run,
            docker::files::container_list_files,
            docker::files::container_download_file,
            docker::files::container_upload_file,
            docker::files::container_delete_file,
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
            docker::compose::read_compose_file,
            docker::compose::write_compose_file,
            docker::images::list_images,
            docker::images::remove_image,
            docker::images::pull_image,
            docker::images::export_images,
            docker::images::import_image,
            docker::images::tag_image,
            docker::images::untag_image,
            docker::push::push_image,
            registries::list_registries,
            registries::save_registry,
            registries::remove_registry,
            registries::test_registry,
            docker::logs::stream_logs,
            docker::logs::export_container_logs,
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
            daemon_config::validate_daemon_json,
            daemon_config::write_daemon_json,
            daemon_config::restart_docker,
            daemon_config::generate_daemon_command,
            daemon_config::test_mirror,
            github_sync::github_device_flow_start,
            github_sync::github_device_flow_poll,
            github_sync::github_gist_raw_content,
            github_sync::sync_save_github_token,
            github_sync::sync_load_github_token,
            github_sync::sync_delete_github_token,
            cleanup::disk_usage,
            cleanup::cleanup,
        ])
        // 关闭拦截：自绘 X / Alt+F4 / 任务栏关闭都经过 CloseRequested。
        // minimize 仅隐藏窗口后台运行；ask 交给前端弹窗询问（apply_close_action 回传）；
        // exit 放行默认关闭
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match settings::load(window.app_handle()).close_action.as_str() {
                    "minimize" => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    "ask" => {
                        api.prevent_close();
                        let _ = window.emit("close-requested", ());
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // 退出时回收 SSH 隧道子进程，避免遗留孤儿 ssh
            if let tauri::RunEvent::Exit = event {
                docker::tunnel::stop_all();
            }
        });
}
