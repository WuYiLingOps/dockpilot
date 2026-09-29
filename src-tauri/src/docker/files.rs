//! 容器文件管理（等同 docker cp / docker exec ls 的能力）：
//! - 列目录 / 删除：exec 直传 argv（不经 shell，无注入面；容器需运行中）
//! - 上传 / 下载：archive API（tar 流；对已停止容器同样可用）
//! 下载在内存中组装（上限 512MB），上传打包为内存 tar；
//! 传输在后台任务执行（立即返回 stream_id），进度/错误经 Channel 推送、可取消。

use std::io::Cursor;

use bollard::container::{DownloadFromContainerOptions, LogOutput, UploadToContainerOptions};
use bollard::exec::{CreateExecOptions, StartExecResults};
use futures::StreamExt;
use tauri::ipc::Channel;
use tauri::Manager;

use super::conn::{docker, CmdResult};
use super::dto::{ExportProgress, FileEntryDto};
use super::state::Streams;

/// 下载/上传的内存上限；超出直接报错而不是 OOM
const MAX_TRANSFER_BYTES: usize = 512 * 1024 * 1024;

/// 容器内路径校验：必须为绝对路径，且不含 `..` 分量
fn validate_container_path(p: &str) -> Result<(), String> {
    let p = p.trim();
    if p.is_empty() {
        return Err("路径不能为空".into());
    }
    if !p.starts_with('/') {
        return Err(format!("请使用绝对路径（以 / 开头）：{p}"));
    }
    if p.split('/').any(|seg| seg == "..") {
        return Err("路径不能包含 .. 分量".into());
    }
    Ok(())
}

/// `ls -la` 输出 → 文件条目（GNU 与 busybox 兼容）：
/// 跳过 total 行与 ./..；名字可能含空格，取第 8 字段之后的全部内容
fn parse_ls_la(output: &str) -> Vec<FileEntryDto> {
    let mut out = Vec::new();
    for line in output.lines() {
        if line.is_empty() || line.starts_with("total ") {
            continue;
        }
        let mut fields = line.split_whitespace();
        let mode = fields.next().unwrap_or_default().to_string();
        if mode.len() < 10 {
            continue;
        }
        let _links = fields.next();
        let _owner = fields.next();
        let _group = fields.next();
        let size: u64 = fields.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        // 日期固定占 3 字段（"Sep 28 10:00" / "Sep 28  2024"），其余全是名字
        let mut date_parts = Vec::with_capacity(3);
        for _ in 0..3 {
            match fields.next() {
                Some(p) => date_parts.push(p),
                None => break,
            }
        }
        let name: String = fields.collect::<Vec<_>>().join(" ");
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let date = date_parts.join(" ");
        out.push(FileEntryDto {
            name,
            is_dir: mode.starts_with('d'),
            size,
            mode,
            date,
        });
    }
    out
}

/// 在容器内执行一条命令（argv 直传），返回 (退出码, 合并输出)
async fn exec_collect(container: &str, argv: &[&str]) -> CmdResult<(i64, String)> {
    let d = docker().await?;
    let cfg = CreateExecOptions::<String> {
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        cmd: Some(argv.iter().map(|s| s.to_string()).collect()),
        ..Default::default()
    };
    let created = d
        .create_exec(container, cfg)
        .await
        .map_err(|e| format!("在容器内创建命令失败: {e}"))?;
    let started = d
        .start_exec(&created.id, None)
        .await
        .map_err(|e| format!("在容器内执行命令失败: {e}"))?;
    let mut out = String::new();
    if let StartExecResults::Attached { mut output, .. } = started {
        while let Some(item) = output.next().await {
            match item {
                Ok(
                    LogOutput::StdOut { message }
                    | LogOutput::StdErr { message }
                    | LogOutput::Console { message },
                ) => out.push_str(&String::from_utf8_lossy(&message)),
                Ok(LogOutput::StdIn { .. }) => {}
                Err(e) => return Err(format!("容器内命令输出流出错: {e}")),
            }
        }
    }
    let inspect = d
        .inspect_exec(&created.id)
        .await
        .map_err(|e| format!("查询容器内命令结果失败: {e}"))?;
    Ok((inspect.exit_code.unwrap_or(-1), out))
}

/// 列出容器内目录（ls -la；需容器运行中）
#[tauri::command]
pub async fn container_list_files(id: String, path: String) -> CmdResult<Vec<FileEntryDto>> {
    validate_container_path(&path)?;
    // 以 - 开头的路径会被当成 ls 的选项，补 ./ 前缀规避
    let arg = if path.starts_with('-') {
        format!("./{path}")
    } else {
        path
    };
    let (code, out) = exec_collect(&id, &["ls", "-la", &arg]).await?;
    if code != 0 {
        return Err(format!("列目录失败（容器需在运行中）: {}", out.trim()));
    }
    Ok(parse_ls_la(&out))
}

/// 归档条目目标路径校验：拒绝绝对路径与 .. 分量（防解包穿越）
fn safe_join(dest: &std::path::Path, rel: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let unsafe_path = rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir));
    if unsafe_path {
        return Err(format!("归档内出现不安全路径: {}", rel.display()));
    }
    Ok(dest.join(rel))
}

/// 下载容器内文件/目录：tar 流累计到内存后解出到宿主 dest。
/// 目录语义与 docker cp 一致：dest 目录下会生成同名子目录。
/// 立即返回 stream_id；结果（完成/出错/取消）经 Channel 的 done 帧通知。
#[tauri::command]
pub async fn container_download_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
    src: String,
    dest: String,
    on_progress: Channel<ExportProgress>,
) -> CmdResult<String> {
    validate_container_path(&src)?;
    if dest.trim().is_empty() {
        return Err("请先选择保存位置".into());
    }
    log::info!("容器 {} 下载文件：{} → {}", super::short_id(&id), src, dest);
    let d = docker().await?;
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let finish = |error: Option<String>, cancelled: bool, written: usize| {
            let _ = on_progress.send(ExportProgress {
                written: written as u64,
                done: true,
                error,
                cancelled,
            });
            app.state::<Streams>().remove(&sid_task);
        };

        let mut stream = d.download_from_container(
            &id,
            Some(DownloadFromContainerOptions { path: src.clone() }),
        );
        let mut buf: Vec<u8> = Vec::new();

        loop {
            tokio::select! {
                _ = token.cancelled() => {
                    finish(None, true, buf.len());
                    return;
                }
                item = stream.next() => match item {
                    Some(Ok(chunk)) => {
                        if buf.len() + chunk.len() > MAX_TRANSFER_BYTES {
                            finish(Some("文件超过 512MB，暂不支持在应用内传输（可在终端中操作）".into()), false, buf.len());
                            return;
                        }
                        buf.extend_from_slice(&chunk);
                        let _ = on_progress.send(ExportProgress {
                            written: buf.len() as u64,
                            done: false,
                            error: None,
                            cancelled: false,
                        });
                    }
                    Some(Err(e)) => {
                        finish(Some(format!("下载容器文件失败: {e}")), false, buf.len());
                        return;
                    }
                    None => break,
                }
            }
        }

        // 解 tar：首个条目为文件（单文件归档）直接写 dest；
        // 目录归档（首条目为目录）则解到 dest 下（docker cp 语义）
        let mut archive = tar::Archive::new(Cursor::new(&buf));
        let mut entries = match archive.entries() {
            Ok(e) => e,
            Err(e) => {
                finish(Some(format!("解析归档失败: {e}")), false, buf.len());
                return;
            }
        };
        let mut single_file = true;
        for entry in entries {
            let mut entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    finish(Some(format!("解析归档失败: {e}")), false, buf.len());
                    return;
                }
            };
            let rel = match entry.path() {
                Ok(p) => p.into_owned(),
                Err(e) => {
                    finish(Some(format!("解析归档条目失败: {e}")), false, buf.len());
                    return;
                }
            };
            let target = if single_file && !entry.header().entry_type().is_dir() {
                // 单文件归档：dest 即目标文件路径
                std::path::PathBuf::from(&dest)
            } else {
                single_file = false;
                match safe_join(std::path::Path::new(&dest), &rel) {
                    Ok(t) => t,
                    Err(e) => {
                        finish(Some(e), false, buf.len());
                        return;
                    }
                }
            };
            if entry.header().entry_type().is_dir() {
                if let Err(e) = std::fs::create_dir_all(&target) {
                    finish(Some(format!("创建目录失败（{}）: {e}", target.display())), false, buf.len());
                    return;
                }
            } else {
                if let Some(parent) = target.parent() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        finish(Some(format!("创建目录失败: {e}")), false, buf.len());
                        return;
                    }
                }
                match std::fs::File::create(&target) {
                    Ok(mut file) => {
                        if let Err(e) = std::io::copy(&mut entry, &mut file) {
                            finish(Some(format!("写出文件失败（{}）: {e}", target.display())), false, buf.len());
                            return;
                        }
                    }
                    Err(e) => {
                        finish(Some(format!("写入文件失败（{}）: {e}", target.display())), false, buf.len());
                        return;
                    }
                }
            }
        }
        finish(None, false, buf.len());
    });

    Ok(sid)
}

/// 上传宿主文件/目录到容器目录：本地打包为内存 tar 后经 archive API 解包。
/// 每个路径以其 basename 落在 container_dir 下；目录整体递归上传。
#[tauri::command]
pub async fn container_upload_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
    container_dir: String,
    local_paths: Vec<String>,
    on_progress: Channel<ExportProgress>,
) -> CmdResult<String> {
    validate_container_path(&container_dir)?;
    if local_paths.is_empty() {
        return Err("请选择要上传的文件".into());
    }
    log::info!(
        "容器 {} 上传 {} 个文件到 {}",
        super::short_id(&id),
        local_paths.len(),
        container_dir
    );

    // 同步打包（本地磁盘 IO）；打包失败直接报错
    let packed = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut builder = tar::Builder::new(Vec::new());
        for p in &local_paths {
            let path = std::path::Path::new(p);
            let base = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .ok_or_else(|| format!("路径缺少文件名: {p}"))?;
            if path.is_dir() {
                builder
                    .append_dir_all(&base, path)
                    .map_err(|e| format!("打包目录失败（{p}）: {e}"))?;
            } else if path.is_file() {
                builder
                    .append_path_with_name(path, &base)
                    .map_err(|e| format!("打包文件失败（{p}）: {e}"))?;
            } else {
                return Err(format!("路径不存在: {p}"));
            }
        }
        builder
            .into_inner()
            .map_err(|e| format!("生成上传归档失败: {e}"))
    })
    .await
    .map_err(|e| format!("打包任务失败: {e}"))??;

    if packed.len() > MAX_TRANSFER_BYTES {
        return Err("上传内容超过 512MB，暂不支持在应用内传输（可在终端中操作）".into());
    }

    let d = docker().await?;
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();
    let total = packed.len();

    tauri::async_runtime::spawn(async move {
        let finish = |error: Option<String>, cancelled: bool| {
            let _ = on_progress.send(ExportProgress {
                written: total as u64,
                done: true,
                error,
                cancelled,
            });
            app.state::<Streams>().remove(&sid_task);
        };

        tokio::select! {
            _ = token.cancelled() => finish(None, true),
            res = d.upload_to_container(
                &id,
                Some(UploadToContainerOptions {
                    path: container_dir.clone(),
                    no_overwrite_dir_non_dir: "1".to_string(),
                }),
                bollard::body_full(packed.into()),
            ) => match res {
                Ok(()) => finish(None, false),
                Err(e) => finish(Some(format!("上传到容器失败: {e}")), false),
            }
        }
    });

    Ok(sid)
}

/// 删除容器内文件/目录（exec rm；需容器运行中）
#[tauri::command]
pub async fn container_delete_file(id: String, path: String, recursive: bool) -> CmdResult<()> {
    validate_container_path(&path)?;
    if path.trim() == "/" {
        return Err("不能删除根目录".into());
    }
    log::info!(
        "容器 {} 删除文件：{}{}",
        super::short_id(&id),
        path,
        if recursive { "（递归）" } else { "" }
    );
    // 以 - 开头的路径会被当成 rm 的选项，补 ./ 前缀规避
    let arg = if path.starts_with('-') {
        format!("./{path}")
    } else {
        path
    };
    let argv: Vec<&str> = if recursive {
        vec!["rm", "-rf", &arg]
    } else {
        vec!["rm", "-f", &arg]
    };
    let (code, out) = exec_collect(&id, &argv).await?;
    if code != 0 {
        return Err(format!("删除失败: {}", out.trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ls_la_parsing_gnu_and_busybox() {
        let gnu = "total 20\n\
                   drwxr-xr-x 1 root root 4096 Sep 28 10:00 .\n\
                   drwxr-xr-x 1 root root 4096 Sep 28  2024 ..\n\
                   -rw-r--r-- 1 root root  123 Sep 28 10:01 a.txt\n\
                   drwxr-xr-x 2 root root 4096 Sep 27 09:00 subdir\n\
                   -rw-r--r-- 1 root root    0 Sep 27 09:00 file with space.log\n\
                   lrwxrwxrwx 1 root root    7 Sep 27 09:00 link -> /etc/hosts\n";
        let entries = parse_ls_la(gnu);
        assert_eq!(entries.len(), 4, "total/. /.. 应被剔除");
        assert_eq!(entries[0].name, "a.txt");
        assert!(!entries[0].is_dir);
        assert_eq!(entries[0].size, 123);
        assert_eq!(entries[0].date, "Sep 28 10:01");
        assert_eq!(entries[1].name, "subdir");
        assert!(entries[1].is_dir);
        // 名字含空格取剩余字段合并
        assert_eq!(entries[2].name, "file with space.log");
        // 符号链接按非目录处理，名字保留箭头
        assert_eq!(entries[3].name, "link -> /etc/hosts");
        assert!(!entries[3].is_dir);

        // busybox 风格：多空格分隔、日期同格式
        let busy = "drwxr-xr-x    2 root     root          4096 Mar  5 10:04 data\n";
        let e = parse_ls_la(busy);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].name, "data");
        assert!(e[0].is_dir);
        assert_eq!(e[0].date, "Mar 5 10:04");

        // 空输出 / 乱行容错
        assert!(parse_ls_la("").is_empty());
        assert!(parse_ls_la("garbage line\nshort").is_empty());
    }

    #[test]
    fn path_validation() {
        assert!(validate_container_path("/var/log").is_ok());
        assert!(validate_container_path("/").is_ok());
        assert!(validate_container_path("").is_err());
        assert!(validate_container_path("var/log").is_err(), "相对路径应拒绝");
        assert!(validate_container_path("/a/../etc").is_err(), ".. 分量应拒绝");
        assert!(validate_container_path("/..").is_err());
    }

    #[test]
    fn safe_join_rejects_escape() {
        let dest = std::path::Path::new("/tmp/dockpilot-dl");
        assert!(safe_join(dest, std::path::Path::new("a.txt")).is_ok());
        assert!(safe_join(dest, std::path::Path::new("sub/a.txt")).is_ok());
        assert!(safe_join(dest, std::path::Path::new("../escape.txt")).is_err());
        assert!(safe_join(dest, std::path::Path::new("/etc/passwd")).is_err());
    }

    #[test]
    fn tar_roundtrip_for_upload_shape() {
        // 上传打包使用 tar::Builder：验证「目录递归 + 文件」的包能被同样的解包逻辑还原
        let dir = std::env::temp_dir().join(format!("dockpilot-tar-test-{}", std::process::id()));
        let sub = dir.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("a.txt"), b"hello").unwrap();
        std::fs::write(sub.join("b.txt"), b"world").unwrap();

        let mut builder = tar::Builder::new(Vec::new());
        builder.append_dir_all("data", &dir).unwrap();
        let bytes = builder.into_inner().unwrap();

        let mut archive = tar::Archive::new(Cursor::new(&bytes));
        let mut names = Vec::new();
        for entry in archive.entries().unwrap() {
            let p = entry.unwrap().path().unwrap().into_owned();
            names.push(p.to_string_lossy().into_owned());
        }
        assert!(names.contains(&"data/a.txt".to_string()));
        assert!(names.contains(&"data/nested/b.txt".to_string()));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
