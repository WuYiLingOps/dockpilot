mod app_update;
mod cleanup;
mod daemon_config;
mod diagnostics;
mod docker;
mod github_sync;
mod registries;
mod secret_store;
mod settings;
mod ssh_secrets;

/// 日志用的字节数人类可读格式（如 2.5 GB）
pub(crate) fn format_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

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
    log::info!(
        "关闭窗口：{action}{}",
        if remember { "（记住选择）" } else { "" }
    );
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
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DWMWCP_ROUND,
        DWM_WINDOW_CORNER_PREFERENCE,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let pref = if round {
        DWMWCP_ROUND
    } else {
        DWMWCP_DONOTROUND
    };
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
/// 进程级 rustls crypto provider：依赖图同时启用 ring（bollard ssl）与 aws-lc-rs
/// （reqwest 0.13 rustls），rustls 无法从 features 自动二选一；不显式安装时
/// bollard TLS 建连的 ClientConfig::builder() 会 panic（release 下 panic=abort 闪退）。
/// reqwest 构建客户端时也优先使用进程默认，两侧统一走 ring
pub fn install_crypto_provider() {
    // 已被安装时返回 Err，属于并发竞争下的正常结果，接受即可
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub fn run() {
    // 崩溃报告最先就位：此后任何 panic（含早期初始化）都有据可查
    // （release panic=abort 下 hook 仍在 abort 前执行，last_panic.json 是唯一归因来源）
    diagnostics::install_panic_hook();

    // 必须在任何 TLS 建连（bollard TLS / reqwest）之前完成
    install_crypto_provider();

    // WebKitGTK 在部分 NVIDIA 驱动上 DMABUF 渲染会黑屏/花屏，检测到 NVIDIA 时自动兜底
    // （Windows 走 WebView2，无此问题）
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::path::Path::new("/proc/driver/nvidia").exists()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // 运行日志：每会话一个文件（Rotate 归档旧会话）+ 大小轮转 + KeepSome 自动清理。
    // fern 闸门全开（Debug），实际级别由 diagnostics::log_level_allows 动态控制
    // （默认 debug 构建 Debug / release 构建 Info，设置页"调试日志"即时切换）
    let log_plugin = tauri_plugin_log::Builder::new()
        .targets({
            let mut targets = vec![
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("dockpilot".into()),
                }),
                // devtools console 可见（诊断排查用）
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
            ];
            if cfg!(debug_assertions) {
                targets.push(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ));
            }
            targets
        })
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .max_file_size(5 * 1024 * 1024)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(14))
        .file_open_strategy(tauri_plugin_log::FileOpenStrategy::Rotate)
        .level(log::LevelFilter::Debug)
        // 第三方库的 Debug 是请求/响应全文转储或密钥库内部操作流水
        // （bollard 轮询下每 2 分钟数 MB），任何级别设置（含调试日志开启时）都封顶 Info
        .level_for("bollard", log::LevelFilter::Info)
        .level_for("hyper", log::LevelFilter::Info)
        .level_for("reqwest", log::LevelFilter::Info)
        .level_for("rustls", log::LevelFilter::Info)
        .level_for("keyring", log::LevelFilter::Warn)
        .level_for("rustls_platform_verifier", log::LevelFilter::Warn)
        .filter(|meta| diagnostics::log_level_allows(meta.level()))
        .build();

    tauri::Builder::default()
        // 日志插件最先注册：之后的初始化过程都可被记录
        .plugin(log_plugin)
        // 单实例：托盘常驻后二次启动只唤起已有窗口，官方要求注册在第一个
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 日志目录与上次退出检测：panic 报告 / 退出标记 / 查看器命令都依赖该路径
            diagnostics::init_log_dir(app.handle());
            diagnostics::check_last_exit();

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
            diagnostics::apply_debug_logging(s.debug_logging);
            log::info!(
                "DockPilot v{} 启动（{} {}，日志级别 {}）",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH,
                if s.debug_logging { "Debug" } else { "Info" }
            );

            // 日志定时清理：启动清一次过期归档，之后每 6 小时按最新保留设置复查
            let cleanup_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let days = crate::settings::load(&cleanup_handle).log_retention_days;
                    match diagnostics::cleanup_old_logs(days) {
                        Ok(r) if r.removed > 0 => {
                            log::info!(
                                "日志定时清理：删除 {} 个过期文件（{}）",
                                r.removed,
                                format_bytes(r.bytes)
                            );
                        }
                        Ok(_) => {}
                        Err(e) => log::warn!("日志定时清理失败: {e}"),
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                }
            });
            if let Some(profile) = settings::find_connection(&s, &s.active_connection_id) {
                log::info!("初始化连接：{}（{}）", profile.name, profile.kind);
                docker::conn::init_active(profile.clone());
            } else {
                log::info!("未找到活跃连接配置，使用默认本地连接");
                docker::conn::init_active(settings::ConnectionProfile::default_local());
            }

            let (tx, _) = broadcast::channel::<DockerEventDto>(256);
            app.manage(tx.clone());
            app.manage(Streams::default());
            app.manage(ExecSessions::default());

            // SSH 引擎无 AppHandle 调用链，启动时缓存配置目录（密钥与主机指纹读取用）
            docker::ssh_client::init_config_dir(app.handle());
            // 清理更新目录残留（安装包被 Windows 安装器占用，只能等重启后的新进程删除）
            app_update::cleanup_updates_dir(app.handle());
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
            docker::compose::add_tracked_compose_project,
            docker::compose::remove_tracked_compose_project,
            docker::compose::scan_compose_dirs,
            docker::images::list_images,
            docker::images::remove_image,
            docker::images::pull_image,
            docker::images::export_images,
            docker::images::import_image,
            docker::images::tag_image,
            docker::images::untag_image,
            docker::push::push_image,
            docker::ssh_known_hosts::accept_host_key,
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
            app_update::check_update,
            app_update::download_app_update,
            app_update::open_downloaded_update,
            app_update::install_app_update,
            ssh_secrets::set_ssh_secret,
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
            github_sync::sync_save_sync_password,
            github_sync::sync_load_sync_password,
            github_sync::sync_delete_sync_password,
            cleanup::disk_usage,
            cleanup::cleanup,
            diagnostics::get_last_crash,
            diagnostics::get_log_dir,
            diagnostics::list_log_files,
            diagnostics::read_app_log,
            diagnostics::set_debug_logging,
            diagnostics::export_diagnostics,
            diagnostics::copy_log_file,
            diagnostics::cleanup_app_logs,
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
            // 退出时回收 SSH 会话与本地监听，避免遗留孤儿连接；
            // 并留下"正常退出"标记（缺失即上次异常退出的判定依据）
            if let tauri::RunEvent::Exit = event {
                diagnostics::write_shutdown_marker();
                tauri::async_runtime::block_on(docker::ssh_client::stop_all());
                log::info!("DockPilot 正常退出");
            }
        });
}
