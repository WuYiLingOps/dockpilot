//! 应用更新检查：查询 GitHub Releases 最新版，与当前版本比较后把结果交给前端。
//!
//! 为什么走 Rust：与云同步同一网络约定——复用 reqwest 的超时 / 退避重试 / 完整
//! 错误链与 HTTPS_PROXY 指引（模式照抄 github_sync.rs，独立实现避免耦合云同步模块）。
//! 仅检查与提醒，不下载不安装；应用内下载安装的升级路径见方案文档（.zcode/plans/）。

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

/// 从 release 附件中挑出当前平台的安装包：
/// Linux → .deb（x86_64 匹配 amd64 / aarch64 匹配 arm64）；Windows → NSIS `-setup.exe`（x64）。
/// 其余平台或未匹配返回 None（前端回落跳转 Releases 页）。
fn pick_asset(assets: &[GhAsset], os: &str, arch: &str) -> Option<UpdateAssetDto> {
    let (suffix, arch_hint): (&str, Option<&str>) = match (os, arch) {
        ("linux", "x86_64") => (".deb", Some("amd64")),
        ("linux", "aarch64") => (".deb", Some("arm64")),
        ("windows", "x86_64") => ("-setup.exe", Some("x64")),
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

/// 下载当前平台安装包到 app_cache_dir()/updates（进度经 Channel 推送），
/// 完成后返回落盘路径；前端随即调用 open_downloaded_update 拉起系统安装器。
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

/// 拉起已下载的安装包（Windows 运行 NSIS 安装向导，Linux 经 xdg-open 走 deb 安装流程）。
/// 自动安装失败时的兜底出口。
#[tauri::command]
pub async fn open_downloaded_update(app: tauri::AppHandle, path: String) -> CmdResult<()> {
    let target = validate_installer_path(&app, &path)?;
    log::info!("拉起更新安装包: {}", target.display());
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("打开安装包失败: {e}"))?;
    Ok(())
}

/// 自动安装已下载的更新包：
/// Windows → 以被动模式（/P）运行 NSIS 安装器，自动关闭运行中的应用并在完成后重启；
/// Linux（deb）→ 经 pkexec 提权 dpkg -i 安装（弹系统授权框），成功后自动重启应用。
/// 失败或取消时可退回「打开安装包」交由系统安装器接管。
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle, path: String) -> CmdResult<()> {
    let target = validate_installer_path(&app, &path)?;
    log::info!("开始安装更新: {}", target.display());

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&target)
            // NSIS 被动模式：只显示进度不询问，自动关闭运行中的应用，装完默认重启
            .arg("/P")
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {e}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        // 授权等待 + dpkg 安装全程；用户迟迟不输密码时以超时兜底
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            tokio::process::Command::new("pkexec")
                .args(["dpkg", "-i"])
                .arg(&target)
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
        log::info!("更新安装完成，重启应用");
        app.restart()
    }
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
    fn pick_asset_matches_platform_installer() {
        let assets = vec![
            asset("DockPilot_1.0.5_x64-setup.exe"),
            asset("dockpilot_1.0.5_amd64.deb"),
            asset("dockpilot_1.0.5_arm64.deb"),
            asset("latest.json"),
        ];
        // Linux x86_64 → amd64 .deb
        let d = pick_asset(&assets, "linux", "x86_64").unwrap();
        assert_eq!(d.name, "dockpilot_1.0.5_amd64.deb");
        // Windows x86_64 → NSIS x64
        let w = pick_asset(&assets, "windows", "x86_64").unwrap();
        assert_eq!(w.name, "DockPilot_1.0.5_x64-setup.exe");
        // Linux arm64 → arm64 .deb
        let a = pick_asset(&assets, "linux", "aarch64").unwrap();
        assert_eq!(a.name, "dockpilot_1.0.5_arm64.deb");
        // 名称里缺架构提示不匹配（arm64 机器不拿到 amd64 包）
        let only_amd64 = vec![asset("dockpilot_1.0.5_amd64.deb")];
        assert!(pick_asset(&only_amd64, "linux", "aarch64").is_none());
        // 其他平台无匹配
        assert!(pick_asset(&assets, "macos", "x86_64").is_none());
        assert!(pick_asset(&[], "linux", "x86_64").is_none());
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
