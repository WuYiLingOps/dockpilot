//! 崩溃诊断与使用日志支撑：panic hook、正常退出标记、上次异常退出检测、
//! 日志文件读取与诊断包导出。
//!
//! release 配置了 panic="abort"：进程直接终止且不会有 unwind，但 panic hook
//! 在 abort 之前仍会执行，因此 hook 内 best-effort 写下的 last_panic.json 是
//! release 闪退唯一的归因来源。hook 内绝不允许任何可能 panic 的操作——所有
//! IO 都忽略错误，所有解析都走降级路径。

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

/// 日志目录（app_log_dir()，setup 中初始化；未初始化时 panic 报告兜底写临时目录）
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 本次会话启动时检测到的上次异常退出（get_last_crash 命令的数据源）
static LAST_CRASH: Mutex<Option<LastCrashInfo>> = Mutex::new(None);

/// 动态日志级别（log::LevelFilter 的 u8 序数：0=Off 1=Error 2=Warn 3=Info 4=Debug 5=Trace）。
/// 默认 Info（各构建一致，避免第三方库 Debug 刷屏），设置页"调试日志"可即时切换
static MAX_LEVEL: AtomicU8 = AtomicU8::new(3);

const PANIC_FILE: &str = "last_panic.json";
const SHUTDOWN_FILE: &str = "last_shutdown.json";
const LOG_BASE: &str = "dockpilot";

// ------------------------------------------------------------------
// panic hook 与崩溃报告
// ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
struct PanicReport {
    version: String,
    os: String,
    arch: String,
    thread: Option<String>,
    timestamp: String,
    message: String,
    location: Option<String>,
    backtrace: String,
}

/// 在 run() 最前调用（早于任何可能 panic 的初始化）。默认 hook 仍会执行，
/// debug 构建的 stderr 输出不受影响。
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&'static str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "未知 panic（payload 非字符串）".to_string()
        };
        let report = PanicReport {
            version: env!("CARGO_PKG_VERSION").to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            thread: std::thread::current().name().map(str::to_string),
            timestamp: iso8601_utc_now(),
            message,
            location: info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())),
            backtrace: std::backtrace::Backtrace::force_capture().to_string(),
        };
        log::error!(
            "panic: {} @ {}",
            report.message,
            report.location.as_deref().unwrap_or("?")
        );
        write_panic_report(&report);
        default_hook(info);
    }));
}

/// last_panic.json 优先写日志目录，失败（或目录未初始化）兜底系统临时目录
fn write_panic_report(report: &PanicReport) {
    if let Ok(text) = serde_json::to_string_pretty(report) {
        let mut written = false;
        if let Some(dir) = LOG_DIR.get() {
            if std::fs::write(dir.join(PANIC_FILE), &text).is_ok() {
                written = true;
            }
        }
        if !written {
            let _ = std::fs::write(temp_panic_path(), &text);
        }
    }
}

fn temp_panic_path() -> PathBuf {
    std::env::temp_dir().join("dockpilot-last-panic.json")
}

// ------------------------------------------------------------------
// 正常退出标记与上次异常退出检测
// ------------------------------------------------------------------

/// 前端横幅与诊断卡片的数据源。kind："panic"（有归因）| "abnormal"（仅感知）
#[derive(Debug, Clone, Serialize)]
pub struct LastCrashInfo {
    pub kind: String,
    pub timestamp: Option<String>,
    pub message: Option<String>,
    pub location: Option<String>,
    pub version: Option<String>,
}

/// RunEvent::Exit 时调用：留下"正常退出"标记，同时清掉上一轮的崩溃报告
/// （panic 报告保留到下一次正常退出才清除，用户忽略横幅后下次启动仍可见）
pub fn write_shutdown_marker() {
    let Some(dir) = LOG_DIR.get() else {
        return;
    };
    let text = serde_json::json!({
        "reason": "normal-exit",
        "timestamp": iso8601_utc_now(),
        "version": env!("CARGO_PKG_VERSION"),
    })
    .to_string();
    let path = dir.join(SHUTDOWN_FILE);
    let tmp = dir.join(format!("{SHUTDOWN_FILE}.tmp"));
    if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, &path).is_ok() {
        let _ = std::fs::remove_file(dir.join(PANIC_FILE));
    }
}

/// setup 中调用一次（需先 init_log_dir）：结果缓存供 get_last_crash 查询。
/// 标记存在 → 上次正常退出（清除标记与残留 panic 报告，返回 None）；
/// 标记缺失且有历史日志 → 上次异常退出；两者皆无 → 首次运行。
pub fn check_last_exit() {
    let info = detect_last_exit();
    if let Some(crash) = &info {
        let summary = match (&crash.location, &crash.message) {
            (Some(loc), Some(msg)) => format!("{loc}: {msg}"),
            _ => "未捕获到原因".to_string(),
        };
        log::warn!("上次会话异常退出（{}）：{}", crash.kind, summary);
    }
    if let Ok(mut guard) = LAST_CRASH.lock() {
        *guard = info;
    }
}

fn detect_last_exit() -> Option<LastCrashInfo> {
    let dir = LOG_DIR.get()?;
    let marker = dir.join(SHUTDOWN_FILE);
    if marker.exists() {
        // 正常退出：清理本轮标记与残留 panic 报告
        let _ = std::fs::remove_file(&marker);
        let _ = std::fs::remove_file(dir.join(PANIC_FILE));
        return None;
    }
    if !has_history(dir) {
        return None; // 首次运行，无"上次"可言
    }
    match std::fs::read_to_string(dir.join(PANIC_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<PanicReport>(&text).ok())
    {
        Some(report) => Some(LastCrashInfo {
            kind: "panic".into(),
            timestamp: Some(report.timestamp),
            message: Some(report.message),
            location: report.location,
            version: Some(report.version),
        }),
        // 无 panic 报告：SIGKILL / 断电 / native 崩溃等，仅感知无法归因
        None => Some(LastCrashInfo {
            kind: "abnormal".into(),
            timestamp: None,
            message: None,
            location: None,
            version: None,
        }),
    }
}

/// 日志目录里是否有过会话文件（区分首次运行与异常退出）
fn has_history(dir: &std::path::Path) -> bool {
    list_log_file_paths(dir)
        .iter()
        .any(|(path, _)| path.metadata().map(|m| m.len() > 0).unwrap_or(false))
}

#[tauri::command]
pub fn get_last_crash() -> Option<LastCrashInfo> {
    LAST_CRASH.lock().ok().and_then(|g| g.clone())
}

// ------------------------------------------------------------------
// 日志目录与文件读取（查看器数据源）
// ------------------------------------------------------------------

#[tauri::command]
pub fn get_log_dir() -> Result<String, String> {
    LOG_DIR
        .get()
        .map(|d| d.to_string_lossy().into_owned())
        .ok_or_else(|| "日志目录未初始化".to_string())
}

/// setup 中调用：与日志插件 TargetKind::LogDir 指向同一目录
pub fn init_log_dir(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = LOG_DIR.set(dir);
    }
}

#[derive(Debug, Serialize)]
pub struct LogFileMeta {
    pub name: String,
    pub size: u64,
    /// epoch 秒；读取失败为 null
    pub modified: Option<i64>,
}

/// 当前会话文件 + 归档会话文件（Rotate 策略生成 dockpilot_<时间>.log），当前在前
#[tauri::command]
pub fn list_log_files() -> Result<Vec<LogFileMeta>, String> {
    let dir = LOG_DIR.get().ok_or("日志目录未初始化")?;
    let mut current = None;
    let mut archived = Vec::new();
    for (path, name) in list_log_file_paths(dir) {
        let meta = LogFileMeta {
            modified: path
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64),
            size: path.metadata().map(|m| m.len()).unwrap_or(0),
            name: name.clone(),
        };
        if name == format!("{LOG_BASE}.log") {
            current = Some(meta);
        } else {
            archived.push(meta);
        }
    }
    // 归档文件名内嵌时间戳，字符串倒序即新→旧
    archived.sort_by(|a, b| b.name.cmp(&a.name));
    let mut files = Vec::with_capacity(archived.len() + 1);
    if let Some(c) = current {
        files.push(c);
    }
    files.extend(archived);
    Ok(files)
}

/// 目录下的日志文件（跳过 tmp/bak），返回 (路径, 文件名)
fn list_log_file_paths(dir: &std::path::Path) -> Vec<(PathBuf, String)> {
    let current = format!("{LOG_BASE}.log");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_log = name == current
            || (name.starts_with(&format!("{LOG_BASE}_")) && name.ends_with(".log"));
        if is_log && !name.ends_with(".tmp") {
            files.push((entry.path(), name));
        }
    }
    files
}

#[derive(Debug, Serialize)]
pub struct LogEntry {
    /// "2026-09-29 18:03:21"
    pub ts: String,
    /// ERROR / WARN / INFO / DEBUG / TRACE
    pub level: String,
    pub target: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct LogPage {
    pub entries: Vec<LogEntry>,
    /// 下次增量读取的起始字节；等于文件长度表示已到末尾
    pub next_offset: u64,
    pub size: u64,
}

const MAX_TAIL_ENTRIES: usize = 5000;

/// 读取日志文件（插件默认行格式 `[日期][时间][target][LEVEL] 消息`，本地时间）。
/// offset 为空 → 读整个文件并只返回末尾 MAX_TAIL_ENTRIES 条（首屏）；
/// offset 非空 → 从该字节增量读取（跟随轮询）。文件被轮转（size < offset）时
/// 自动回落全量尾读，避免空转。
#[tauri::command]
pub fn read_app_log(
    file: Option<String>,
    offset: Option<u64>,
    limit: Option<usize>,
) -> Result<LogPage, String> {
    let dir = LOG_DIR.get().ok_or("日志目录未初始化")?;
    let name = file.unwrap_or_else(|| format!("{LOG_BASE}.log"));
    validate_log_name(&name)?;
    let path = dir.join(&name);
    let size = path
        .metadata()
        .map_err(|e| format!("读取日志失败: {e}"))?
        .len();

    let start = match offset {
        Some(o) if o <= size => o,
        _ => 0,
    };
    let (mut entries, consumed) = parse_log_range(&path, start)?;
    let next_offset = start + consumed;
    let entries = if offset.is_none() {
        let keep = limit.unwrap_or(MAX_TAIL_ENTRIES).min(MAX_TAIL_ENTRIES);
        if entries.len() > keep {
            entries.split_off(entries.len() - keep)
        } else {
            entries
        }
    } else {
        entries
    };
    Ok(LogPage {
        entries,
        next_offset,
        size,
    })
}

/// 校验文件名，防路径穿越：只允许当前会话与归档命名
fn validate_log_name(name: &str) -> Result<(), String> {
    let ok = name == format!("{LOG_BASE}.log")
        || (name.starts_with(&format!("{LOG_BASE}_"))
            && name.ends_with(".log")
            && !name.contains('/')
            && !name.contains('\\')
            && !name.contains(".."));
    if ok {
        Ok(())
    } else {
        Err(format!("非法的日志文件名: {name}"))
    }
}

/// 从 start 字节读文件并解析完整行；返回（条目，本次消费的字节数——
/// 以最后一个换行为界，半行留给下次）
fn parse_log_range(path: &std::path::Path, start: u64) -> Result<(Vec<LogEntry>, u64), String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).map_err(|e| format!("打开日志失败: {e}"))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("定位日志失败: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("读取日志失败: {e}"))?;

    let boundary = match buf.iter().rposition(|&b| b == b'\n') {
        Some(pos) => pos + 1,
        None => 0, // 没有完整行（本轮全是半行），全部留给下次
    };

    let mut entries = Vec::new();
    let mut pending: Option<LogEntry> = None;
    for line in String::from_utf8_lossy(&buf[..boundary]).lines() {
        match parse_log_line(line) {
            Some(entry) => {
                if let Some(prev) = pending.take() {
                    entries.push(prev);
                }
                pending = Some(entry);
            }
            // 多行消息并入上一条（如 backtrace、compose 输出）
            None => {
                if let Some(prev) = pending.as_mut() {
                    prev.message.push('\n');
                    prev.message.push_str(line);
                }
            }
        }
    }
    if let Some(last) = pending.take() {
        entries.push(last);
    }
    Ok((entries, boundary as u64))
}

/// 解析单行；按级别白名单自动识别 [级别] 与 [target] 的顺序
/// （2.9.x 输出 [日期][时间][级别][target]，2.10+ 为 [日期][时间][target][级别]）
fn parse_log_line(line: &str) -> Option<LogEntry> {
    let mut rest = line.strip_prefix('[')?;
    let mut fields = [""; 4];
    for (i, field) in fields.iter_mut().enumerate() {
        let end = rest.find(']')?;
        *field = &rest[..end];
        rest = &rest[end + 1..];
        if i < 3 {
            rest = rest.strip_prefix('[')?;
        }
    }
    let [date, time, a, b] = fields;
    const LEVELS: [&str; 5] = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];
    let (level, target) = match (LEVELS.contains(&a), LEVELS.contains(&b)) {
        (true, false) => (a, b),
        (false, true) => (b, a),
        // 两个位置都不是/都是合法级别：不是日志行（多行消息的续行）
        _ => return None,
    };
    let valid_date = date.len() == 10 && date.as_bytes().get(4) == Some(&b'-');
    if !valid_date {
        return None;
    }
    Some(LogEntry {
        ts: format!("{date} {time}"),
        level: level.to_string(),
        target: target.to_string(),
        message: rest.strip_prefix(' ').unwrap_or(rest).to_string(),
    })
}

// ------------------------------------------------------------------
// 调试日志开关
// ------------------------------------------------------------------

/// setup 与设置页共用：切换动态级别并同步 log 全局闸门
pub fn apply_debug_logging(enabled: bool) {
    let level = if enabled { 4 } else { 3 }; // Debug : Info
    MAX_LEVEL.store(level, Ordering::Relaxed);
    log::set_max_level(num_to_level_filter(level));
}

fn num_to_level_filter(num: u8) -> log::LevelFilter {
    match num {
        1 => log::LevelFilter::Error,
        2 => log::LevelFilter::Warn,
        4 => log::LevelFilter::Debug,
        5 => log::LevelFilter::Trace,
        0 => log::LevelFilter::Off,
        _ => log::LevelFilter::Info,
    }
}

/// 日志插件的动态过滤（fern 闸门固定 Debug 全开，实际级别由此控制）
pub fn log_level_allows(level: log::Level) -> bool {
    let num = match level {
        log::Level::Error => 1,
        log::Level::Warn => 2,
        log::Level::Info => 3,
        log::Level::Debug => 4,
        log::Level::Trace => 5,
    };
    num <= MAX_LEVEL.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_debug_logging(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = crate::settings::load(&app);
    s.debug_logging = enabled;
    crate::settings::save(&app, &s)?;
    apply_debug_logging(enabled);
    log::info!("调试日志已{}", if enabled { "开启" } else { "关闭" });
    Ok(())
}

// ------------------------------------------------------------------
// 诊断包导出
// ------------------------------------------------------------------

/// 打包为 .tar：info.json + last_panic.json（若有）+ 最近 3 个日志文件。
/// path 来自前端保存对话框的完整路径。
#[tauri::command]
pub fn export_diagnostics(path: String) -> Result<String, String> {
    let dir = LOG_DIR.get().ok_or("日志目录未初始化")?;
    let path = if path.ends_with(".tar") {
        path
    } else {
        format!("{path}.tar")
    };

    let mut builder = tar::Builder::new(Vec::new());

    let info = serde_json::json!({
        "app": "DockPilot",
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "exported_at": iso8601_utc_now(),
        "log_dir": dir.to_string_lossy(),
        "last_crash": *LAST_CRASH.lock().map_err(|_| "诊断状态读取失败".to_string())?,
    });
    append_tar_entry(
        &mut builder,
        "info.json",
        serde_json::to_string_pretty(&info).unwrap().as_bytes(),
    )?;

    // 最近的日志文件（当前会话 + 归档，倒序取 3 个）
    let mut files = list_log_files()?;
    files.sort_by_key(|f| std::cmp::Reverse(f.modified.unwrap_or(0)));
    for file in files.iter().take(3) {
        let bytes = std::fs::read(dir.join(&file.name))
            .map_err(|e| format!("读取日志 {} 失败: {e}", file.name))?;
        append_tar_entry(&mut builder, &format!("logs/{}", file.name), &bytes)?;
    }

    if let Ok(text) = std::fs::read_to_string(dir.join(PANIC_FILE)) {
        append_tar_entry(&mut builder, PANIC_FILE, text.as_bytes())?;
    }

    let buf = builder
        .into_inner()
        .map_err(|e| format!("打包诊断数据失败: {e}"))?;
    std::fs::write(&path, buf).map_err(|e| format!("写入诊断包失败: {e}"))?;
    log::info!("诊断包已导出: {path}");
    Ok(path)
}

fn append_tar_entry(
    builder: &mut tar::Builder<Vec<u8>>,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder
        .append_data(&mut header, name, bytes)
        .map_err(|e| format!("打包诊断数据失败: {e}"))
}

/// 查看器"导出"：把某个日志文件复制到用户选择的路径，返回字节数
#[tauri::command]
pub fn copy_log_file(file: String, dest: String) -> Result<u64, String> {
    validate_log_name(&file)?;
    let dir = LOG_DIR.get().ok_or("日志目录未初始化")?;
    let n = std::fs::copy(dir.join(&file), &dest).map_err(|e| format!("导出日志失败: {e}"))?;
    log::info!("日志 {file} 已导出到 {dest}（{n} 字节）");
    Ok(n)
}

// ------------------------------------------------------------------
// 日志清理（保留天数设置 + 启动/定时自动清理 + 手动立即清理）
// ------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct LogCleanupResult {
    pub removed: u32,
    pub bytes: u64,
}

/// 清理超过保留期的归档日志（按文件修改时间；当前会话文件不动）。
/// keep_days = 0 表示永久保留。返回删除的文件数与释放字节数。
pub fn cleanup_old_logs(keep_days: u32) -> Result<LogCleanupResult, String> {
    let mut result = LogCleanupResult {
        removed: 0,
        bytes: 0,
    };
    if keep_days == 0 {
        return Ok(result);
    }
    let dir = LOG_DIR.get().ok_or("日志目录未初始化")?;
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(u64::from(keep_days) * 86_400);
    for (path, name) in list_log_file_paths(dir) {
        if name == format!("{LOG_BASE}.log") {
            continue; // 当前会话日志不清理
        }
        let Ok(meta) = path.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified < cutoff && std::fs::remove_file(&path).is_ok() {
            result.removed += 1;
            result.bytes += meta.len();
        }
    }
    Ok(result)
}

/// 手动清理入口（故障诊断「立即清理」）：按当前设置的保留天数执行
#[tauri::command]
pub fn cleanup_app_logs(app: tauri::AppHandle) -> Result<LogCleanupResult, String> {
    let days = crate::settings::load(&app).log_retention_days;
    let result = cleanup_old_logs(days)?;
    if result.removed > 0 {
        log::info!(
            "日志清理：删除 {} 个过期日志文件（{}）",
            result.removed,
            crate::format_bytes(result.bytes)
        );
    }
    Ok(result)
}

// ------------------------------------------------------------------
// UTC 时间格式化（零依赖）
// ------------------------------------------------------------------

/// 当前 UTC 时间的 ISO 8601（毫秒），如 "2026-09-29T10:03:21.482Z"。
/// 日志行本身用插件的本地时间格式，这里只用于 panic 报告 / 标记 / 诊断包。
pub fn iso8601_utc_now() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        (secs / 3_600) % 24,
        (secs / 60) % 60,
        secs % 60,
        dur.subsec_millis()
    )
}

/// 儒略日数 → (年, 月, 日)，Howard Hinnant 的 civil_from_days 纯算术实现
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(1), (1970, 1, 2));
        assert_eq!(civil_from_days(31), (1970, 2, 1));
        assert_eq!(civil_from_days(365), (1971, 1, 1));
        // 闰年边界：2024-02-29 = 19782 天（1970-01-01 起）
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(19_783), (2024, 3, 1));
        // 世纪闰年：2000-02-29 = 11016 天；2000-03-01 = 11017
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
    }

    #[test]
    fn iso8601_utc_now_shape() {
        let ts = iso8601_utc_now();
        assert_eq!(ts.len(), 24, "毫秒精度 ISO8601: {ts}");
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }

    #[test]
    fn parse_log_line_both_field_orders() {
        // tauri-plugin-log 2.9.x：[日期][时间][级别][target]
        let entry = parse_log_line(
            "[2026-09-30][01:14:29][INFO][tauri_app_lib] DockPilot v1.0.1 启动（linux x86_64）",
        )
        .expect("2.9.x 行应可解析");
        assert_eq!(entry.level, "INFO");
        assert_eq!(entry.target, "tauri_app_lib");
        assert_eq!(entry.ts, "2026-09-30 01:14:29");

        // 2.10+：[日期][时间][target][级别]
        let entry = parse_log_line(
            "[2026-09-30][18:03:21][tauri_app_lib::docker::conn][INFO] 已切换连接 conn-1",
        )
        .expect("2.10 行应可解析");
        assert_eq!(entry.level, "INFO");
        assert_eq!(entry.target, "tauri_app_lib::docker::conn");

        // 空消息
        let entry = parse_log_line("[2026-09-29][00:00:00][WARN][t] ").expect("空消息行");
        assert_eq!(entry.message, "");
    }

    #[test]
    fn parse_log_line_rejects_non_entries() {
        // 恰好以 [ 开头但不是日志格式的行（多行消息的续行）
        assert!(parse_log_line("[compose] 输出片段").is_none());
        assert!(parse_log_line("普通续行").is_none());
        assert!(parse_log_line("").is_none());
    }

    #[test]
    fn validate_log_name_blocks_traversal() {
        assert!(validate_log_name("dockpilot.log").is_ok());
        assert!(validate_log_name("dockpilot_2026-09-29_18-03-21.log").is_ok());
        assert!(validate_log_name("../settings.json").is_err());
        assert!(validate_log_name("dockpilot.log.tmp").is_err());
        assert!(validate_log_name("other.log").is_err());
    }
}
