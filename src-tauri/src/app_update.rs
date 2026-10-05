//! 应用更新：查询 GitHub Releases 最新版，按平台与发行形态匹配更新包，下载后自动应用。
//!
//! 为什么走 Rust：与云同步同一网络约定——复用 reqwest 的超时 / 退避重试 / 完整
//! 错误链与 HTTPS_PROXY 指引（模式照抄 github_sync.rs，独立实现避免耦合云同步模块）。
//! 更新应用方式按发行形态分派（detect_distribution_form）：deb 经 pkexec 提权安装、
//! NSIS 被动安装，Windows 便携版原位替换自身后拉起新版本（见 install_app_update）。

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::Manager;

use crate::docker::conn::CmdResult;

const RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/WuYiLingOps/dockpilot/releases/latest";
/// release 附件的下载链接前缀（download 命令的纵深防御：只接受本仓库附件）
const DOWNLOAD_URL_PREFIX: &str = "https://github.com/WuYiLingOps/dockpilot/releases/download/";

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("构建 HTTP 客户端失败")
    })
}

/// 请求失败的完整原因链（reqwest 的 Display 不含底层 source，
/// 如 DNS / 连接 / TLS 具体错误，拼出来才能定位网络问题）
fn err_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut src = e.source();
    while let Some(err) = src {
        s.push_str(&format!(": {err}"));
        src = err.source();
    }
    s
}

/// 带重试的请求发送：直连 GitHub 的链路存在间歇性超时（尤其国内网络），
/// 网络类失败自动重试，间隔 1s / 2s 递增。最后一次仍失败时，超时类错误附上处理指引。
async fn send_with_retry(
    builder: reqwest::RequestBuilder,
    attempts: u32,
    what: &str,
) -> Result<reqwest::Response, String> {
    let mut last_err = String::new();
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(1000 * attempt as u64)).await;
        }
        let request = builder
            .try_clone()
            .ok_or_else(|| format!("{what}: 请求体无法克隆以供重试"))?;
        match request.send().await {
            Ok(res) => return Ok(res),
            Err(e) => {
                last_err = err_chain(&e);
            }
        }
    }
    if last_err.contains("timed out") || last_err.contains("timeout") {
        return Err(format!(
            "{what}: 连接 github.com 超时（网络不稳定或被间歇性阻断，已自动重试 {attempts} 次）。\
             可稍后重试；若本机需要代理访问 GitHub，请设置 HTTPS_PROXY 环境变量后重启应用"
        ));
    }
    Err(format!("{what}: {last_err}"))
}

/// 检查结果 DTO：字段 snake_case 直出，前端 types/appUpdate.ts 1:1 镜像（同 settings 约定）
#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckDto {
    pub current_version: String,
    /// 最新版本号（去 v 前缀）
    pub latest_version: String,
    pub has_update: bool,
    /// GitHub release body（markdown，前端纯文本摘要展示）
    pub release_notes: String,
    /// 该 release 页面（「下载更新」深链）
    pub html_url: String,
    /// RFC3339，原样透传给前端格式化
    pub published_at: String,
    /// 当前平台匹配到的安装包附件（未匹配为 null，前端回落跳转 Releases 页）
    pub download: Option<UpdateAssetDto>,
}

/// 当前平台匹配到的安装包附件
#[derive(Debug, Clone, Serialize)]
pub struct UpdateAssetDto {
    pub name: String,
    pub url: String,
    pub size: u64,
}

/// 下载进度（total 为 0 表示长度未知）
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
}

/// GitHub release 响应中用到的字段。
/// 全部用 Option：个别 release 的 body 等字段官方 API 会返回 JSON null，
/// Option 同时兜住"字段缺失"与"值为 null"，回落空串而不是整体解析失败。
#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: Option<String>,
    html_url: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    assets: Option<Vec<GhAsset>>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: Option<String>,
    #[serde(rename = "browser_download_url")]
    url: Option<String>,
    size: Option<u64>,
}

/// 当前运行的发行形态：决定附件匹配后缀与更新应用路径
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DistributionForm {
    /// Linux deb 安装（系统包管理器接管）
    Deb,
    /// Windows NSIS 安装版
    NsisInstaller,
    /// Windows 便携版（裸 exe，免安装）
    Portable,
}

/// 检测当前运行的发行形态；识别不了的边缘态回落（前端回落「前往下载」兜底）。
fn detect_distribution_form() -> DistributionForm {
    if cfg!(target_os = "windows") {
        // 文件名优先：便携版附件按 `-portable.exe` 命名，浏览器下载保留附件名
        if exe_filename_is_portable(&current_exe_filename()) {
            return DistributionForm::Portable;
        }
        // NSIS 安装版在注册表写有卸载项；无安装记录的裸 exe（含被改名的便携版）按便携兜底
        return if nsis_uninstall_key_exists() {
            DistributionForm::NsisInstaller
        } else {
            DistributionForm::Portable
        };
    }
    DistributionForm::Deb
}

/// 便携版文件名判定（纯函数便于单测）：文件名（大小写不敏感）含 `portable` 即命中
fn exe_filename_is_portable(file_name: &str) -> bool {
    file_name.to_lowercase().contains("portable")
}

/// 当前进程的可执行文件名（获取失败为空串，交由后续判定兜底）
fn current_exe_filename() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default()
}

/// NSIS 卸载注册表项检测：Tauri NSIS 默认按当前用户安装（HKCU），机器级安装查 HKLM
/// （32 位安装器写入 WOW6432Node 视图）。遍历卸载项匹配 DisplayName / UninstallString
/// 中的应用名——用 winreg 纯 API 而非 reg 子进程：GUI 进程（windows_subsystem = "windows"）
/// spawn 控制台程序 reg.exe 会新开控制台窗口，检查更新时闪黑框（/s 递归全文搜索还拉长了
/// 黑框的可见时长）。查询失败按未安装处理，误判为便携版时走替换路径更新的仍是同一个应用。
#[cfg(target_os = "windows")]
fn nsis_uninstall_key_exists() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let roots = [
        (
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
    ];
    for (hkey, path) in roots {
        let Ok(root) = RegKey::predef(hkey).open_subkey(path) else {
            continue;
        };
        for key in root.enum_keys().flatten() {
            let Ok(sub) = root.open_subkey(key) else {
                continue;
            };
            let hit = ["DisplayName", "UninstallString"].into_iter().any(|value| {
                sub.get_value::<String, _>(value)
                    .map(|data| uninstall_data_is_app(&data))
                    .unwrap_or(false)
            });
            if hit {
                return true;
            }
        }
    }
    false
}

/// 卸载项数据是否指向本应用（大小写不敏感）：NSIS 的 DisplayName 即 productName
/// 「DockPilot」，UninstallString 是卸载器完整路径，同样含产品目录名
#[cfg(target_os = "windows")]
fn uninstall_data_is_app(data: &str) -> bool {
    data.to_lowercase().contains("dockpilot")
}

/// 非 Windows 平台无 NSIS 安装概念，恒 false（detect 的 cfg! 分支跨平台编译）
#[cfg(not(target_os = "windows"))]
fn nsis_uninstall_key_exists() -> bool {
    false
}

/// 从 release 附件中挑出当前平台与发行形态对应的更新包：
/// Linux → .deb（x86_64 匹配 amd64 / aarch64 匹配 arm64）；
/// Windows → NSIS `-setup.exe` / 便携版 `_portable.exe`（x64）。
/// 其余平台、形态或未匹配返回 None（前端回落跳转 Releases 页）。
fn pick_asset(
    assets: &[GhAsset],
    os: &str,
    arch: &str,
    form: DistributionForm,
) -> Option<UpdateAssetDto> {
    let (suffix, arch_hint): (&str, Option<&str>) = match (os, arch, form) {
        ("linux", "x86_64", DistributionForm::Deb) => (".deb", Some("amd64")),
        ("linux", "aarch64", DistributionForm::Deb) => (".deb", Some("arm64")),
        ("windows", "x86_64", DistributionForm::NsisInstaller) => ("-setup.exe", Some("x64")),
        ("windows", "x86_64", DistributionForm::Portable) => ("_portable.exe", Some("x64")),
        _ => return None,
    };
    assets
        .iter()
        .filter_map(|a| {
            let name = a.name.as_deref()?.trim();
            let url = a.url.as_deref()?.trim();
            if !name.ends_with(suffix) || url.is_empty() {
                return None;
            }
            if let Some(hint) = arch_hint {
                if !name.contains(hint) {
                    return None;
                }
            }
            Some(UpdateAssetDto {
                name: name.to_string(),
                url: url.to_string(),
                size: a.size.unwrap_or(0),
            })
        })
        .next()
}

/// 数值比较 a > b：去 v 前缀与构建元数据（`+build`，tauri.conf.json 版本可携带），
/// 按 `.` 分段数值比较，缺位补 0，非数字段按 0 处理。仅服务版本提示展示，语义宽容即可。
fn version_gt(a: &str, b: &str) -> bool {
    fn segments(v: &str) -> Vec<u64> {
        v.trim()
            .trim_start_matches('v')
            .split('+')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|seg| seg.trim().parse::<u64>().unwrap_or(0))
            .collect()
    }
    let (a, b) = (segments(a), segments(b));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// 检查 GitHub 最新 release。不做节流（前端负责 24h 节流与防重入），失败返回中文错误串
#[tauri::command]
pub async fn check_update() -> CmdResult<UpdateCheckDto> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    log::info!("检查应用更新（当前 v{current}）");

    let res = send_with_retry(
        http_client()
            .get(RELEASES_LATEST_URL)
            // GitHub API 强制要求 User-Agent，缺失直接 403
            .header("User-Agent", format!("dockpilot/{current}"))
            .header("Accept", "application/vnd.github+json"),
        3,
        "检查应用更新",
    )
    .await?;

    let status = res.status();
    if !status.is_success() {
        if status.as_u16() == 404 {
            return Err("检查应用更新: 仓库尚未发布任何版本".into());
        }
        if status.as_u16() == 403 {
            return Err(
                "检查应用更新: 请求被 GitHub 拒绝（403，匿名请求可能已达限流上限，约 1 小时后恢复）"
                    .into(),
            );
        }
        return Err(format!("检查应用更新: GitHub 返回 {status}"));
    }

    let release: GhRelease = res
        .json()
        .await
        .map_err(|e| format!("检查应用更新: 解析响应失败: {}", err_chain(&e)))?;
    let tag = release.tag_name.unwrap_or_default();
    if tag.trim().is_empty() {
        return Err("检查应用更新: GitHub 返回的 release 缺少版本号".into());
    }

    let latest_version = tag.trim().trim_start_matches('v').to_string();
    let has_update = version_gt(&latest_version, &current);
    let download = pick_asset(
        release.assets.as_deref().unwrap_or(&[]),
        std::env::consts::OS,
        std::env::consts::ARCH,
        detect_distribution_form(),
    );
    Ok(UpdateCheckDto {
        current_version: current,
        latest_version,
        has_update,
        release_notes: release.body.unwrap_or_default(),
        html_url: release.html_url.unwrap_or_default(),
        published_at: release.published_at.unwrap_or_default(),
        download,
    })
}

/// 下载专用客户端：不能沿用检查用的 15s 总超时（大文件会中途夭折），
/// 只限制连接与单次读超时，总时长由用户网络决定。
fn dl_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .read_timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("构建下载客户端失败")
    })
}

/// 安装包落盘目录：app_cache_dir()/updates（可随时重下，不占用户文档空间）
fn updates_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取缓存目录失败: {e}"))?
        .join("updates");
    Ok(dir)
}

/// 应用启动时清空更新目录（尽力而为）：安装完成后的残留更新包与中断下载的
/// .part 残片都在此清理——Windows 安装器运行期间更新包文件被系统锁定，
/// 只能等装完重启后的新进程（本函数）删除；Linux 虽已替换即删，此处再兜底一次。
/// Windows 便携版自替换改名的 <exe>.old 残留也在此清理。
pub fn cleanup_updates_dir(app: &tauri::AppHandle) {
    let dir = match updates_dir(app) {
        Ok(dir) => dir,
        Err(_) => return,
    };
    remove_dir_files(&dir);
    cleanup_old_exe();
}

/// 便携版自替换残留清理：运行中 exe 改名的 <exe>.old 在新进程启动后已不被占用，
/// 此处删除（被占用时 warn 跳过，下次启动再清）。
#[cfg(target_os = "windows")]
fn cleanup_old_exe() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut old = exe.into_os_string();
    old.push(".old");
    let old = std::path::PathBuf::from(old);
    match std::fs::remove_file(&old) {
        Ok(()) => log::info!("已清理便携版替换残留: {}", old.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("清理便携版替换残留失败 {}: {e}", old.display()),
    }
}

/// 非 Windows 平台无便携版 .old 残留，空实现（cleanup_updates_dir 跨平台调用）
#[cfg(not(target_os = "windows"))]
fn cleanup_old_exe() {}

/// 删除目录内的全部文件（不动子目录；目录不存在时为空操作）。单独抽出便于单测。
fn remove_dir_files(dir: &std::path::Path) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return, // 目录尚不存在（从未下载过），无需清理
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            match std::fs::remove_file(&path) {
                Ok(()) => log::info!("已清理更新目录残留: {}", path.display()),
                Err(e) => log::warn!("清理更新目录失败 {}: {e}", path.display()),
            }
        }
    }
}

/// 下载前清空更新目录中的旧安装包（只删文件，不动目录本身）
async fn clean_updates_dir(dir: &std::path::Path) -> CmdResult<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("创建更新目录失败: {e}"))?;
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .map_err(|e| format!("读取更新目录失败: {e}"))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("读取更新目录失败: {e}"))?
    {
        let path = entry.path();
        if path.is_file() {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
    Ok(())
}

/// 下载当前平台更新包到 app_cache_dir()/updates（进度经 Channel 推送），
/// 完成后返回落盘路径；前端随即调用 install_app_update 按发行形态自动应用更新。
#[tauri::command]
pub async fn download_app_update(
    app: tauri::AppHandle,
    url: String,
    on_progress: Channel<DownloadProgress>,
) -> CmdResult<String> {
    if !url.starts_with(DOWNLOAD_URL_PREFIX) {
        return Err("下载更新: 非法的下载链接".into());
    }
    let file_name = url.rsplit('/').next().unwrap_or_default().to_string();
    if file_name.is_empty() || file_name.contains("..") {
        return Err("下载更新: 非法的安装包文件名".into());
    }
    log::info!("开始下载更新安装包: {file_name}");

    let dir = updates_dir(&app)?;
    clean_updates_dir(&dir).await?;
    let dest = dir.join(&file_name);
    let part = dir.join(format!("{file_name}.part"));

    let res = dl_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载更新: {}", err_chain(&e)))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("下载更新: GitHub 返回 {status}"));
    }
    let total = res.content_length().unwrap_or(0);

    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("下载更新: 创建临时文件失败: {e}"))?;
    let mut res = res;
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                if file.write_all(&chunk).await.is_err() {
                    let _ = tokio::fs::remove_file(&part).await;
                    return Err("下载更新: 写入磁盘失败".into());
                }
                downloaded += chunk.len() as u64;
                // 每 128KB 推一次进度，避免高频 IPC 刷屏
                if downloaded - last_emit >= 128 * 1024 {
                    last_emit = downloaded;
                    let _ = on_progress.send(DownloadProgress { downloaded, total });
                }
            }
            Ok(None) => break,
            Err(e) => {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(format!("下载更新: {}", err_chain(&e)));
            }
        }
    }
    if file.flush().await.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("下载更新: 写入磁盘失败".into());
    }
    drop(file);
    // .part → 正式名：保证 open 命令拿到的必然是完整文件
    tokio::fs::rename(&part, &dest)
        .await
        .map_err(|e| format!("下载更新: 落盘失败: {e}"))?;
    let _ = on_progress.send(DownloadProgress { downloaded, total });
    log::info!("更新安装包下载完成: {}", dest.display());
    Ok(dest.to_string_lossy().into_owned())
}

/// 校验待打开/安装的安装包路径：必须存在且位于 updates 目录内（canonicalize 防路径穿越）
fn validate_installer_path(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = updates_dir(app)?;
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("读取更新目录失败: {e}"))?;
    let target = std::path::PathBuf::from(path);
    let target = target
        .canonicalize()
        .map_err(|_| "安装包不存在，可能已被清理，请重新下载".to_string())?;
    if !target.starts_with(&dir) {
        return Err("非法的文件路径".into());
    }
    Ok(target)
}

/// 拉起已下载的更新包（Windows 运行 NSIS 安装向导，Linux 经 xdg-open 走 deb 安装流程）。
/// 自动更新失败时的兜底出口；便携版没有系统安装器，返回手动替换指引。
#[tauri::command]
pub async fn open_downloaded_update(app: tauri::AppHandle, path: String) -> CmdResult<()> {
    let target = validate_installer_path(&app, &path)?;
    if matches!(detect_distribution_form(), DistributionForm::Portable) {
        // 直接打开 exe 会被单实例机制送回当前进程，没有意义；给出替换指引
        return Err(format!(
            "该发行形态无系统安装器：新版本已下载到 {}，请手动用它替换当前程序文件后重新打开应用",
            target.display()
        ));
    }
    log::info!("拉起更新安装包: {}", target.display());
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("打开安装包失败: {e}"))?;
    Ok(())
}

/// 自动应用已下载的更新包（按发行形态分派）：
/// Windows 安装版 → 以被动模式（/P）运行 NSIS 安装器，自动关闭运行中的应用并在完成后重启；
/// Windows 便携版 → 原位替换自身（旧 exe 改名 .old、新 exe 移入原路径）后拉起新版本；
/// Linux（deb）→ 经 pkexec 提权 dpkg -i 安装（弹系统授权框），成功后自动重启应用。
/// 失败或取消时可退回「打开更新包」（便携版返回手动替换指引）。
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle, path: String) -> CmdResult<()> {
    let target = validate_installer_path(&app, &path)?;
    let form = detect_distribution_form();
    log::info!("开始应用更新（{form:?}）: {}", target.display());

    #[cfg(target_os = "windows")]
    {
        match form {
            DistributionForm::Portable => install_portable_update(&target).await,
            DistributionForm::NsisInstaller => {
                std::process::Command::new(&target)
                    // NSIS 被动模式：只显示进度不询问，自动关闭运行中的应用，装完默认重启
                    .arg("/P")
                    .spawn()
                    .map_err(|e| format!("启动安装程序失败: {e}"))?;
                Ok(())
            }
            _ => Err("无法识别当前发行形态，请前往下载页手动更新".into()),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        match form {
            DistributionForm::Deb => install_deb_update(&app, &target).await,
            _ => Err("发行形态与运行平台不匹配".into()),
        }
    }
}

/// deb 安装路径：pkexec 提权 dpkg -i（弹系统授权框），成功后删更新包并重启应用
#[cfg(not(target_os = "windows"))]
async fn install_deb_update(app: &tauri::AppHandle, target: &std::path::Path) -> CmdResult<()> {
    // 授权等待 + dpkg 安装全程；用户迟迟不输密码时以超时兜底
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        tokio::process::Command::new("pkexec")
            .args(["dpkg", "-i"])
            .arg(target)
            .output(),
    )
    .await
    .map_err(|_| "安装超时，请检查 polkit 授权窗口状态".to_string())?
    .map_err(|e| format!("无法启动 pkexec: {e}（请确认系统安装了 polkit）"))?;

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.contains("dismissed") || stderr.contains("cancelled") {
        return Err("已取消安装授权".into());
    }
    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        let line = stderr.lines().last().unwrap_or("").trim();
        return Err(format!(
            "安装更新失败: {}",
            if line.is_empty() {
                format!("dpkg 退出码 {code}")
            } else {
                line.to_string()
            }
        ));
    }
    // 安装完成即删更新包（此时文件已不被占用；Windows 侧因安装器锁定文件，
    // 由启动时的 cleanup_updates_dir 兜底）
    if let Err(e) = tokio::fs::remove_file(target).await {
        log::warn!("清理已安装的更新包失败 {}: {e}", target.display());
    }
    log::info!("更新安装完成，重启应用");
    app.restart()
}

/// Windows 便携版替换路径：运行中 exe 改名为 .old（Windows 允许改名运行中文件），
/// 新 exe 移入原路径（保留用户原文件名）后拉起新版本。任一步失败回滚改名，旧程序无损；
/// .old 残留由下次启动的 cleanup_old_exe 清理。不能用 app.restart()：
/// 改名后 current_exe() 的指向已有歧义。
#[cfg(target_os = "windows")]
async fn install_portable_update(target: &std::path::Path) -> CmdResult<()> {
    let exe = std::env::current_exe().map_err(|e| format!("定位当前程序失败: {e}"))?;
    let mut old = exe.clone().into_os_string();
    old.push(".old");
    let old = std::path::PathBuf::from(old);
    // 上次替换的 .old 残留先删（正常已被启动清理；失败不阻断）
    let _ = tokio::fs::remove_file(&old).await;

    tokio::fs::rename(&exe, &old)
        .await
        .map_err(|e| format!("旧程序改名失败: {e}（可能被安全软件占用，请手动更新）"))?;
    if let Err(e) = move_into_place(target, &exe).await {
        // 回滚改名，保证旧程序无损
        let _ = tokio::fs::rename(&old, &exe).await;
        return Err(e);
    }
    log::info!("便携版已替换为 {}，拉起新版本", exe.display());
    spawn_replacement(&exe)
}

/// 把新版本文件移入目标路径：同文件系统直接 rename（原子换入，运行中实例继续持有旧
/// inode / 句柄）；跨文件系统（rename 失败，如缓存目录与程序不在同一盘）先拷贝到目标
/// 同目录旁的临时文件再 rename。成功后源文件不再存在于 updates 目录。
#[cfg(target_os = "windows")]
async fn move_into_place(src: &std::path::Path, dst: &std::path::Path) -> CmdResult<()> {
    if tokio::fs::rename(src, dst).await.is_ok() {
        return Ok(());
    }
    let tmp = dst.with_extension("update.tmp");
    if let Err(e) = tokio::fs::copy(src, &tmp).await {
        return Err(format!(
            "拷贝新版本失败: {e}（目标目录可能只读，请手动更新）"
        ));
    }
    if let Err(e) = tokio::fs::rename(&tmp, dst).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!(
            "移入新版本失败: {e}（目标目录可能只读，请手动更新）"
        ));
    }
    let _ = tokio::fs::remove_file(src).await;
    Ok(())
}

/// 拉起新版本并退出当前进程。新旧进程短暂并存，旧进程退出先于新进程完成单实例
/// 检测（与 app.restart() 的时序一致），新进程正常接管。
#[cfg(target_os = "windows")]
fn spawn_replacement(bin: &std::path::Path) -> CmdResult<()> {
    std::process::Command::new(bin)
        .spawn()
        .map_err(|e| format!("拉起新版本失败: {e}"))?;
    log::info!("新版本已拉起，退出当前进程");
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GhAsset {
        GhAsset {
            name: Some(name.to_string()),
            url: Some(format!(
                "https://github.com/WuYiLingOps/dockpilot/releases/download/v1.0.5/{name}"
            )),
            size: Some(1024),
        }
    }

    #[test]
    fn pick_asset_matches_platform_and_form() {
        let assets = vec![
            asset("DockPilot_1.0.5_x64-setup.exe"),
            asset("dockpilot_1.0.5_amd64.deb"),
            asset("dockpilot_1.0.5_arm64.deb"),
            asset("DockPilot_1.0.5_x64_portable.exe"),
            asset("latest.json"),
        ];
        // Linux x86_64 deb 安装 → amd64 .deb
        let d = pick_asset(&assets, "linux", "x86_64", DistributionForm::Deb).unwrap();
        assert_eq!(d.name, "dockpilot_1.0.5_amd64.deb");
        // Windows 安装版 → NSIS x64；便携版 → -portable.exe
        let w = pick_asset(
            &assets,
            "windows",
            "x86_64",
            DistributionForm::NsisInstaller,
        )
        .unwrap();
        assert_eq!(w.name, "DockPilot_1.0.5_x64-setup.exe");
        let p = pick_asset(&assets, "windows", "x86_64", DistributionForm::Portable).unwrap();
        assert_eq!(p.name, "DockPilot_1.0.5_x64_portable.exe");
        // Linux arm64 → arm64 .deb
        let a = pick_asset(&assets, "linux", "aarch64", DistributionForm::Deb).unwrap();
        assert_eq!(a.name, "dockpilot_1.0.5_arm64.deb");
        // 形态与附件错配不命中（后缀互不串扰）
        assert!(pick_asset(&assets, "linux", "x86_64", DistributionForm::NsisInstaller).is_none());
        assert!(pick_asset(&assets, "windows", "x86_64", DistributionForm::Deb).is_none());
        // 名称里缺架构提示不匹配（arm64 机器不拿到 amd64 包）
        let only_amd64 = vec![asset("dockpilot_1.0.5_amd64.deb")];
        assert!(pick_asset(&only_amd64, "linux", "aarch64", DistributionForm::Deb).is_none());
        // 其他平台无匹配
        assert!(pick_asset(&assets, "macos", "x86_64", DistributionForm::Deb).is_none());
        assert!(pick_asset(&[], "linux", "x86_64", DistributionForm::Deb).is_none());
    }

    #[test]
    fn exe_filename_is_portable_detection() {
        // 附件名（浏览器下载保留）
        assert!(exe_filename_is_portable("DockPilot_1.0.5_x64_portable.exe"));
        // 大小写不敏感
        assert!(exe_filename_is_portable("dockpilot_1.0.5_x64_PORTABLE.EXE"));
        // 安装版 / 不含 portable 的改名不命中（交由 NSIS 卸载注册表项兜底判定）
        assert!(!exe_filename_is_portable("DockPilot_1.0.5_x64-setup.exe"));
        assert!(!exe_filename_is_portable("dockpilot.exe"));
        assert!(!exe_filename_is_portable(""));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn uninstall_data_is_app_detection() {
        // NSIS 卸载项的典型数据形态
        assert!(uninstall_data_is_app("DockPilot"));
        assert!(uninstall_data_is_app(
            r"C:\Users\u\AppData\Local\DockPilot\uninstall.exe"
        ));
        // 大小写不敏感
        assert!(uninstall_data_is_app("dockpilot"));
        // 同为 dock 前缀的其它软件不误判
        assert!(!uninstall_data_is_app("Docker Desktop"));
        assert!(!uninstall_data_is_app(""));
    }

    #[test]
    fn remove_dir_files_clears_files_keeps_subdirs() {
        let base = std::env::temp_dir().join(format!(
            "dockpilot_updates_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = base.join("updates");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("dockpilot_1.0.5_amd64.deb"), b"pkg").unwrap();
        std::fs::write(dir.join("dockpilot_1.0.5_amd64.deb.part"), b"half").unwrap();

        // 常规清理：文件（含 .part 残片）删除，子目录保留，目录本身保留
        remove_dir_files(&dir);
        assert!(!dir.join("dockpilot_1.0.5_amd64.deb").exists());
        assert!(!dir.join("dockpilot_1.0.5_amd64.deb.part").exists());
        assert!(dir.join("sub").is_dir());
        assert!(dir.is_dir());

        // 目录不存在时空操作不 panic
        remove_dir_files(&base.join("missing"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn gh_release_tolerates_missing_and_null_fields() {
        // body 为 JSON null、其余字段缺失时不应整体解析失败
        let r: GhRelease = serde_json::from_str(r#"{"tag_name":"v1.1.0","body":null}"#).unwrap();
        assert_eq!(r.tag_name.as_deref(), Some("v1.1.0"));
        assert_eq!(r.body, None);
        assert_eq!(r.html_url, None);
        assert_eq!(r.published_at, None);
    }

    #[test]
    fn version_gt_compares_numerically() {
        // v 前缀
        assert!(version_gt("v1.0.5", "1.0.4"));
        assert!(version_gt("1.0.5", "v1.0.4"));
        // 位数不等：缺位补 0
        assert!(version_gt("1.1", "1.0.9"));
        assert!(!version_gt("1.0", "1"));
        // 相等
        assert!(!version_gt("1.0.5", "v1.0.5"));
        assert!(!version_gt("1.0.4", "1.0.5"));
        // 按数值而非字典序比较
        assert!(version_gt("1.0.10", "1.0.9"));
        assert!(!version_gt("1.0.2", "1.0.10"));
        // 非数字段按 0 容错
        assert!(version_gt("1.0.5", "1.0.beta"));
        assert!(!version_gt("1.0.beta", "1.0.0"));
        // 构建元数据（+build）剥离后不影响比较
        assert!(version_gt("1.0.4", "1.0.3+20261002"));
        assert!(!version_gt("1.0.4", "1.0.4+20261002"));
        // 空串 / 空白容错
        assert!(!version_gt("", ""));
        assert!(version_gt("1.0.0", ""));
    }
}
