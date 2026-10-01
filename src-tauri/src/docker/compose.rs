//! Docker Compose 支持：项目识别走 Engine API（容器标签分组），编排操作走 compose CLI。
//! 约定：compose 容器自带 com.docker.compose.* 标签，据此重建 -p/-f/--project-directory 参数。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use bollard::container::ListContainersOptions;
use russh::client::Handle;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::conn::{docker, CmdResult};
use super::containers::map_container;
use super::dto::{
    ComposeCliInfoDto, ComposeOutput, ComposeProjectDto, ComposeServiceDto, PortDto,
    ScanComposeResultDto,
};
use super::ssh_client;
use super::state::Streams;
use crate::docker::conn;
use crate::settings::{self, ConnectionProfile, TrackedComposeProject};

/// compose 项目名标签
pub const LABEL_PROJECT: &str = "com.docker.compose.project";
/// compose 服务名标签
pub const LABEL_SERVICE: &str = "com.docker.compose.service";
const LABEL_WORKING_DIR: &str = "com.docker.compose.project.working_dir";
const LABEL_CONFIG_FILES: &str = "com.docker.compose.project.config_files";

/// 视为 compose 文件的文件名（目录扫描匹配用）
const COMPOSE_FILE_NAMES: [&str; 4] = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
];

/// 当前连接的 id（跟踪记录的归属键：本地为 "local"，SSH 各自独立）
fn active_connection_id() -> String {
    conn::active().profile.id
}

// ---------------------------------------------------------------------------
// CLI 探测与命令组装
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliKind {
    /// docker CLI 的 compose 插件（`docker compose ...`）
    Plugin,
    /// 独立二进制（`docker-compose ...`，含 v1 与 v2 standalone）
    Standalone,
}

#[derive(Debug, Clone)]
struct Cli {
    kind: CliKind,
    version: String,
}

/// ssh 连接时返回当前连接配置：compose 改为在远程服务器上执行（远端才有 docker CLI 与
/// compose 文件，本机 CLI 读不到容器标签里的远端路径）；其余连接返回 None，维持本机执行
fn ssh_profile() -> Option<ConnectionProfile> {
    let conn_active = conn::active();
    (conn_active.profile.kind == "ssh").then_some(conn_active.profile)
}

/// POSIX shell 单引号转义：sshd 会把命令参数拼接后交给用户登录 shell 解析，
/// 拼进远程命令串的路径/参数必须转义，防止空格与特殊字符破坏命令结构
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 引号化远程路径词；以 `~/` 开头的路径保持波浪号未引号（引号内波浪号不会被远程 shell 展开）
fn sh_path(s: &str) -> String {
    match s.strip_prefix("~/") {
        Some(rest) => format!("~/{}", sh_quote(rest)),
        None => sh_quote(s),
    }
}

/// 探测 compose CLI：优先 docker compose 插件，回退 docker-compose。
/// 每次操作实时探测，避免应用运行期间安装/卸载后状态过期。
/// ssh 连接改为探测远程服务器（每次探测 = 一次 ssh 连接）
async fn detect_cli() -> CmdResult<Cli> {
    if let Some(p) = ssh_profile() {
        return detect_cli_remote(&p).await;
    }
    if let Some(cli) = probe(
        CliKind::Plugin,
        "docker",
        &["compose", "version", "--short"],
    )
    .await
    {
        return Ok(cli);
    }
    if let Some(cli) = probe(
        CliKind::Standalone,
        "docker-compose",
        &["version", "--short"],
    )
    .await
    {
        return Ok(cli);
    }
    Err("未检测到 Docker Compose CLI，请先安装（Debian/Ubuntu：sudo apt install docker-compose-plugin）".into())
}

async fn detect_cli_remote(p: &ConnectionProfile) -> CmdResult<Cli> {
    if let Some(cli) = ssh_probe(
        p,
        CliKind::Plugin,
        &["docker", "compose", "version", "--short"],
    )
    .await
    {
        return Ok(cli);
    }
    if let Some(cli) = ssh_probe(
        p,
        CliKind::Standalone,
        &["docker-compose", "version", "--short"],
    )
    .await
    {
        return Ok(cli);
    }
    Err("远程服务器未检测到 Docker Compose CLI，请在服务器上安装（Debian/Ubuntu：sudo apt install docker-compose-plugin）".into())
}

async fn probe(kind: CliKind, program: &str, args: &[&str]) -> Option<Cli> {
    let fut = Command::new(program).args(args).output();
    let out = tokio::time::timeout(Duration::from_secs(10), fut)
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(Cli { kind, version })
}

/// 经 ssh 在远程服务器上探测 compose CLI（version 不触达 daemon，无需 DOCKER_HOST）
async fn ssh_probe(p: &ConnectionProfile, kind: CliKind, remote_args: &[&str]) -> Option<Cli> {
    let out = ssh_output(p, &remote_args.join(" "), 10).await.ok()?;
    if !out.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(Cli { kind, version })
}

/// 执行一次性远程命令（经 ssh_client 内置引擎，超时与启动错误已包装；
/// 退出码由调用方按语义处理）
async fn ssh_output(
    p: &ConnectionProfile,
    remote: &str,
    timeout_secs: u64,
) -> CmdResult<ssh_client::ExecOutput> {
    ssh_client::exec(p, remote, Duration::from_secs(timeout_secs))
        .await
        .map_err(|e| e.to_string())
}

/// ssh_output + 退出码校验，失败时报 `{ctx}: <stderr>`
async fn ssh_check(
    p: &ConnectionProfile,
    remote: &str,
    timeout_secs: u64,
    ctx: &str,
) -> CmdResult<ssh_client::ExecOutput> {
    let out = ssh_output(p, remote, timeout_secs).await?;
    if !out.success() {
        let detail = out.stderr.trim();
        return Err(if detail.is_empty() {
            format!("{ctx}（exit {}）", out.exit_code)
        } else {
            format!("{ctx}: {detail}")
        });
    }
    Ok(out)
}

/// 把内存中的内容写到远程路径（远端执行 cat > 路径）
async fn ssh_write_remote(
    p: &ConnectionProfile,
    remote_path: &str,
    content: &[u8],
    timeout_secs: u64,
) -> CmdResult<()> {
    let out = ssh_client::exec_write(
        p,
        &format!("cat > {remote_path}"),
        content.to_vec(),
        Duration::from_secs(timeout_secs),
    )
    .await
    .map_err(|e| e.to_string())?;
    if !out.success() {
        let detail = out.stderr.trim();
        return Err(if detail.is_empty() {
            "写入远程文件失败".into()
        } else {
            format!("写入远程文件失败: {detail}")
        });
    }
    Ok(())
}

/// 远程 compose 命令串：env 前缀显式指定 DOCKER_HOST（与隧道转发目标一致，
/// 不受远程用户 shell 配置影响）；项目名/文件/目录/参数逐段转义后拼接。
/// sshd 把拼接结果交给用户登录 shell 解析，因此各词必须是转义后的最终形态
fn build_remote_compose(
    p: &ConnectionProfile,
    cli: &Cli,
    project: &str,
    working_dir: &str,
    files: &[String],
    args: &[String],
) -> String {
    let mut parts: Vec<String> = vec![
        "env".into(),
        sh_quote(&format!(
            "DOCKER_HOST=unix://{}",
            ssh_client::remote_socket(p)
        )),
    ];
    match cli.kind {
        CliKind::Plugin => parts.extend(["docker".into(), "compose".into()]),
        CliKind::Standalone => parts.push("docker-compose".into()),
    }
    parts.extend(["-p".into(), sh_quote(project)]);
    for f in files {
        parts.extend(["-f".into(), sh_path(f)]);
    }
    if !working_dir.is_empty() {
        parts.extend(["--project-directory".into(), sh_path(working_dir)]);
    }
    parts.extend(args.iter().map(|a| sh_quote(a)));
    parts.join(" ")
}

/// 组装本机 compose 命令（local/tcp/tls）：参数数组直调（无 shell，无注入风险），
/// 显式设置 DOCKER_HOST 与 bollard 当前连接一致（本地 socket / TCP / TLS / SSH 隧道），
/// 避免用户环境变量把 CLI 指向别的 daemon。
/// ssh 连接不走此函数：russh 经 spawn_remote_stream、system 经 ssh_command 在远程执行
fn build_cmd_local(
    cli: &Cli,
    project: &str,
    working_dir: &str,
    files: &[String],
    args: &[String],
) -> CmdResult<Command> {
    let mut cmd = match cli.kind {
        CliKind::Plugin => {
            let mut c = Command::new("docker");
            c.arg("compose");
            c
        }
        CliKind::Standalone => Command::new("docker-compose"),
    };
    cmd.arg("-p").arg(project);
    for f in files {
        cmd.arg("-f").arg(f);
    }
    if !working_dir.is_empty() {
        cmd.arg("--project-directory").arg(working_dir);
    }
    cmd.args(args);
    for (k, v) in conn::cli_env(&conn::active()) {
        cmd.env(k, v);
    }
    Ok(cmd)
}

/// 把前端动作映射为 compose CLI 参数（不含 -p/-f/--project-directory 前缀）
fn build_action_args(
    action: &str,
    remove_volumes: bool,
    remove_images: bool,
    services: &[String],
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = match action {
        "up" => vec!["up".into(), "-d".into()],
        "up_build" => vec!["up".into(), "-d".into(), "--build".into()],
        "stop" => vec!["stop".into()],
        "start" => vec!["start".into()],
        "restart" => vec!["restart".into()],
        "pause" => vec!["pause".into()],
        "unpause" => vec!["unpause".into()],
        "down" => {
            let mut v = vec!["down".into()];
            if remove_volumes {
                v.push("--volumes".into());
            }
            if remove_images {
                v.extend(["--rmi".into(), "local".into()]);
            }
            v
        }
        "build" => vec!["build".into()],
        "pull" => vec!["pull".into()],
        other => return Err(format!("未知操作: {other}")),
    };
    args.extend(services.iter().cloned());
    Ok(args)
}

// ---------------------------------------------------------------------------
// 项目分组（纯函数，可单测）
// ---------------------------------------------------------------------------

/// 分组输入快照：从 ContainerSummary 摘取所需字段，隔离 bollard 类型便于单测
pub(super) struct ContainerSnapshot {
    name: String,
    id: String,
    image: String,
    state: String,
    status: String,
    ports: Vec<PortDto>,
    project: Option<String>,
    service: Option<String>,
    working_dir: Option<String>,
    config_files: Option<String>,
}

pub(super) fn snapshot(c: &bollard::models::ContainerSummary) -> ContainerSnapshot {
    let dto = map_container(c);
    let labels = c.labels.as_ref();
    ContainerSnapshot {
        name: dto.name,
        id: dto.id,
        image: dto.image,
        state: dto.state,
        status: dto.status,
        ports: dto.ports,
        project: dto.compose_project,
        service: dto.compose_service,
        working_dir: labels.and_then(|l| l.get(LABEL_WORKING_DIR).cloned()),
        config_files: labels.and_then(|l| l.get(LABEL_CONFIG_FILES).cloned()),
    }
}

/// 按项目分组容器，无 compose 标签的容器忽略；项目按名称稳定排序。
/// working_dir / config_files 取该项目容器中首个非空值（同一项目的容器共享配置标签）。
pub(super) fn group_projects(list: Vec<ContainerSnapshot>) -> Vec<ComposeProjectDto> {
    let mut acc: BTreeMap<String, (String, Vec<String>, Vec<ComposeServiceDto>)> = BTreeMap::new();
    for c in list {
        let Some(project) = c.project else { continue };
        let entry = acc.entry(project).or_default();
        if entry.0.is_empty() {
            if let Some(wd) = c.working_dir.filter(|s| !s.is_empty()) {
                entry.0 = wd;
            }
        }
        if entry.1.is_empty() {
            if let Some(files) = c.config_files {
                let parsed: Vec<String> = files
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !parsed.is_empty() {
                    entry.1 = parsed;
                }
            }
        }
        entry.2.push(ComposeServiceDto {
            name: c.service.unwrap_or_else(|| c.name.clone()),
            container_id: c.id,
            state: c.state,
            status: c.status,
            image: c.image,
            ports: c.ports,
        });
    }
    acc.into_iter()
        .map(|(name, (working_dir, config_files, mut services))| {
            services.sort_by(|a, b| {
                a.name
                    .cmp(&b.name)
                    .then(a.container_id.cmp(&b.container_id))
            });
            let total_count = services.len();
            let running_count = services.iter().filter(|s| s.state == "running").count();
            ComposeProjectDto {
                name,
                working_dir,
                config_files,
                services,
                running_count,
                total_count,
                source: "containers".into(),
            }
        })
        .collect()
}

/// 把容器标签中看到的项目 upsert 进跟踪列表（记忆层）：
/// 新项目按 source 追加；已有记录仅在路径不同步时更新（registered/scanned 来源不降级）。
/// 返回列表是否发生变化（无变化时调用方可跳过写盘——列表刷新是事件驱动的高频路径）
fn upsert_tracked(
    tracked: &mut Vec<TrackedComposeProject>,
    connection_id: &str,
    name: &str,
    working_dir: &str,
    config_files: &[String],
    source: &str,
) -> bool {
    if name.is_empty() || config_files.is_empty() {
        return false;
    }
    if let Some(t) = tracked
        .iter_mut()
        .find(|t| t.connection_id == connection_id && t.name == name)
    {
        if t.working_dir == working_dir && t.config_files == config_files {
            return false;
        }
        t.working_dir = working_dir.to_string();
        t.config_files = config_files.to_vec();
        return true;
    }
    tracked.push(TrackedComposeProject {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection_id.to_string(),
        name: name.to_string(),
        working_dir: working_dir.to_string(),
        config_files: config_files.to_vec(),
        source: source.to_string(),
        added_at: settings::now_secs(),
    });
    true
}

/// 容器识别结果与跟踪记录合并：同名项目容器优先（路径字段有缺时以记录补全）；
/// 仅存在于跟踪记录的项目以"未运行"形态补入（无容器、计数为 0），结果按名称稳定排序
fn merge_projects(
    mut containers: Vec<ComposeProjectDto>,
    tracked: &[TrackedComposeProject],
    connection_id: &str,
) -> Vec<ComposeProjectDto> {
    for t in tracked.iter().filter(|t| t.connection_id == connection_id) {
        match containers.iter_mut().find(|p| p.name == t.name) {
            Some(p) => {
                if p.working_dir.is_empty() {
                    p.working_dir = t.working_dir.clone();
                }
                if p.config_files.is_empty() {
                    p.config_files = t.config_files.clone();
                }
            }
            None => containers.push(ComposeProjectDto {
                name: t.name.clone(),
                working_dir: t.working_dir.clone(),
                config_files: t.config_files.clone(),
                services: Vec::new(),
                running_count: 0,
                total_count: 0,
                source: t.source.clone(),
            }),
        }
    }
    containers.sort_by(|a, b| a.name.cmp(&b.name));
    containers
}

/// 从引擎容器标签反查项目的 working_dir 与 config_files，供 CLI 操作重建参数；
/// 查不到容器时回退本地跟踪记录（down 后/从未 up 的项目同样可操作）
async fn project_config(app: &tauri::AppHandle, project: &str) -> CmdResult<(String, Vec<String>)> {
    let d = docker().await?;
    let list = d
        .list_containers(Some(ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        }))
        .await
        .map_err(|e| format!("获取容器列表失败: {e}"))?;
    for c in &list {
        let Some(labels) = c.labels.as_ref() else {
            continue;
        };
        if labels.get(LABEL_PROJECT).map(String::as_str) == Some(project) {
            let working_dir = labels.get(LABEL_WORKING_DIR).cloned().unwrap_or_default();
            let config_files = labels
                .get(LABEL_CONFIG_FILES)
                .map(|s| {
                    s.split(',')
                        .map(|f| f.trim().to_string())
                        .filter(|f| !f.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            return Ok((working_dir, config_files));
        }
    }
    let conn_id = active_connection_id();
    let s = settings::load(app);
    if let Some(t) = s
        .compose_projects
        .iter()
        .find(|t| t.connection_id == conn_id && t.name == project)
    {
        return Ok((t.working_dir.clone(), t.config_files.clone()));
    }
    Err(format!(
        "未找到项目 {project} 的容器，无法确定 compose 配置"
    ))
}

// ---------------------------------------------------------------------------
// 子进程输出流
// ---------------------------------------------------------------------------

/// 把子进程的一路输出按行推送到 Channel
fn pump(
    pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    label: &'static str,
    on_output: Channel<ComposeOutput>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if on_output
                .send(ComposeOutput {
                    stream: label.into(),
                    data: line,
                    code: None,
                    error: None,
                })
                .is_err()
            {
                break;
            }
        }
    })
}

/// 启动本机子进程并推送输出；结束时发送 code（退出码），被取消时发送 error。
/// 注册到 Streams，前端通过 cancel_stream 取消（kill 子进程）。
/// 仅限本机命令（local/tcp/tls 连接）；ssh 走 spawn_remote_stream。
fn spawn_local_stream(
    app: &tauri::AppHandle,
    mut cmd: Command,
    label: String,
    on_output: Channel<ComposeOutput>,
) -> CmdResult<String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        match cmd.spawn() {
            Ok(mut child) => {
                let mut readers = Vec::new();
                if let Some(out) = child.stdout.take() {
                    readers.push(pump(out, "out", on_output.clone()));
                }
                if let Some(err) = child.stderr.take() {
                    readers.push(pump(err, "err", on_output.clone()));
                }

                tokio::select! {
                    status = child.wait() => {
                        let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
                        if code == 0 {
                            log::info!("compose {label} 完成");
                        } else {
                            log::warn!("compose {label} 失败（退出码 {code}）");
                        }
                        let _ = on_output.send(ComposeOutput {
                            stream: "exit".into(),
                            data: code.to_string(),
                            code: Some(code),
                            error: None,
                        });
                    }
                    _ = token.cancelled() => {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        log::info!("compose {label} 已取消");
                        let _ = on_output.send(ComposeOutput {
                            stream: "exit".into(),
                            data: String::new(),
                            code: None,
                            error: Some("操作已取消".into()),
                        });
                    }
                }
                for r in readers {
                    let _ = r.await;
                }
            }
            Err(e) => {
                log::warn!("compose {label} 启动失败: {e}");
                let _ = on_output.send(ComposeOutput {
                    stream: "exit".into(),
                    data: String::new(),
                    code: None,
                    error: Some(format!("启动 compose 命令失败: {e}")),
                });
            }
        }
        app.state::<Streams>().remove(&sid_task);
    });

    Ok(sid)
}

/// 从字节缓冲中取出完整行（\n 分隔，容忍 \r\n），残留不完整行留待下次
fn drain_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let mut line: Vec<u8> = buf.drain(..=pos).collect();
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        lines.push(String::from_utf8_lossy(&line).into_owned());
    }
    lines
}

/// 在远端启动 compose 命令并流式回传输出（SSH 连接统一路径）。
/// 结束/取消语义与 spawn_local_stream 对齐：正常结束发 code，取消发 error。
/// 取消 = 关闭会话通道，远端进程随会话终止。
fn spawn_remote_stream(
    app: &tauri::AppHandle,
    handle: Arc<Handle<ssh_client::ClientHandler>>,
    remote: String,
    label: String,
    on_output: Channel<ComposeOutput>,
) -> CmdResult<String> {
    let (sid, token) = app.state::<Streams>().register();
    let sid_task = sid.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let opened = async {
            let channel = handle
                .channel_open_session()
                .await
                .map_err(|e| format!("打开远程会话通道失败: {e}"))?;
            channel
                .exec(true, remote.as_str())
                .await
                .map_err(|e| format!("启动远程 compose 失败: {e}"))?;
            Ok::<_, String>(channel)
        };
        match opened.await {
            Ok(mut channel) => {
                let mut out_buf: Vec<u8> = Vec::new();
                let mut err_buf: Vec<u8> = Vec::new();
                let mut code: Option<i32> = None;
                let mut cancelled = false;
                loop {
                    tokio::select! {
                        msg = channel.wait() => match msg {
                            Some(russh::ChannelMsg::Data { ref data }) => {
                                out_buf.extend_from_slice(data);
                                for line in drain_lines(&mut out_buf) {
                                    let _ = on_output.send(ComposeOutput {
                                        stream: "out".into(),
                                        data: line,
                                        code: None,
                                        error: None,
                                    });
                                }
                            }
                            Some(russh::ChannelMsg::ExtendedData { ref data, .. }) => {
                                err_buf.extend_from_slice(data);
                                for line in drain_lines(&mut err_buf) {
                                    let _ = on_output.send(ComposeOutput {
                                        stream: "err".into(),
                                        data: line,
                                        code: None,
                                        error: None,
                                    });
                                }
                            }
                            Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                                code = Some(i32::try_from(exit_status).unwrap_or(-1));
                            }
                            Some(russh::ChannelMsg::Close) | None => break,
                            _ => {}
                        },
                        _ = token.cancelled() => {
                            cancelled = true;
                            let _ = channel.close().await;
                            break;
                        }
                    }
                }
                if cancelled {
                    log::info!("compose {label} 已取消");
                    let _ = on_output.send(ComposeOutput {
                        stream: "exit".into(),
                        data: String::new(),
                        code: None,
                        error: Some("操作已取消".into()),
                    });
                } else {
                    // 刷出未换行的残余输出
                    if !out_buf.is_empty() {
                        let _ = on_output.send(ComposeOutput {
                            stream: "out".into(),
                            data: String::from_utf8_lossy(&out_buf).into_owned(),
                            code: None,
                            error: None,
                        });
                    }
                    if !err_buf.is_empty() {
                        let _ = on_output.send(ComposeOutput {
                            stream: "err".into(),
                            data: String::from_utf8_lossy(&err_buf).into_owned(),
                            code: None,
                            error: None,
                        });
                    }
                    let code = code.unwrap_or(-1);
                    if code == 0 {
                        log::info!("compose {label} 完成");
                    } else {
                        log::warn!("compose {label} 失败（退出码 {code}）");
                    }
                    let _ = on_output.send(ComposeOutput {
                        stream: "exit".into(),
                        data: code.to_string(),
                        code: Some(code),
                        error: None,
                    });
                }
            }
            Err(e) => {
                log::warn!("compose {label} 启动失败: {e}");
                let _ = on_output.send(ComposeOutput {
                    stream: "exit".into(),
                    data: String::new(),
                    code: None,
                    error: Some(format!("启动 compose 命令失败: {e}")),
                });
            }
        }
        app.state::<Streams>().remove(&sid_task);
    });

    Ok(sid)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// 列出所有 compose 项目（含已停止与本地跟踪的未运行项目；容器按标签分组，无需 compose CLI）。
/// 容器标签中看到的项目会同步进本地跟踪记录（记忆层），down 后仍可见可重启
#[tauri::command]
pub async fn list_compose_projects(app: tauri::AppHandle) -> CmdResult<Vec<ComposeProjectDto>> {
    let d = docker().await?;
    let list = d
        .list_containers(Some(ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        }))
        .await
        .map_err(|e| format!("获取容器列表失败: {e}"))?;
    let grouped = group_projects(list.iter().map(snapshot).collect());

    let conn_id = active_connection_id();
    let mut s = settings::load(&app);
    let mut changed = false;
    for p in &grouped {
        changed |= upsert_tracked(
            &mut s.compose_projects,
            &conn_id,
            &p.name,
            &p.working_dir,
            &p.config_files,
            "remembered",
        );
    }
    if changed {
        // 写盘失败不影响列表返回（下次刷新会再尝试）
        settings::save(&app, &s).unwrap_or_else(|e| log::warn!("保存编排跟踪记录失败: {e}"));
    }
    Ok(merge_projects(grouped, &s.compose_projects, &conn_id))
}

/// 探测 compose CLI 可用性与版本
#[tauri::command]
pub async fn compose_cli_info() -> CmdResult<ComposeCliInfoDto> {
    Ok(match detect_cli().await {
        Ok(cli) => ComposeCliInfoDto {
            available: true,
            version: cli.version,
            source: match cli.kind {
                CliKind::Plugin => "plugin",
                CliKind::Standalone => "standalone",
            }
            .into(),
        },
        Err(_) => ComposeCliInfoDto {
            available: false,
            version: String::new(),
            source: "none".into(),
        },
    })
}

/// 对项目执行 compose 操作；输出经 Channel 流式推送，返回 stream_id 供取消。
/// action: up | up_build | stop | start | restart | pause | unpause | down | build | pull
#[tauri::command]
pub async fn compose_action(
    app: tauri::AppHandle,
    project: String,
    action: String,
    remove_volumes: bool,
    remove_images: bool,
    services: Vec<String>,
    on_output: Channel<ComposeOutput>,
) -> CmdResult<String> {
    let cli = detect_cli().await?;
    let (working_dir, config_files) = project_config(&app, &project).await?;
    if config_files.is_empty() {
        return Err(format!(
            "项目 {project} 缺少 compose 配置文件标签，无法执行 CLI 操作"
        ));
    }
    log::info!(
        "compose 项目 {project} 执行 {action}（服务：{}）",
        if services.is_empty() {
            "全部".to_string()
        } else {
            services.join(", ")
        }
    );
    let args = build_action_args(&action, remove_volumes, remove_images, &services)?;
    let label = format!("{project} {action}");

    if let Some(p) = ssh_profile() {
        let remote = build_remote_compose(&p, &cli, &project, &working_dir, &config_files, &args);
        let handle = ssh_client::session_handle(&p)
            .await
            .map_err(|e| e.to_string())?;
        return spawn_remote_stream(&app, handle, remote, label, on_output);
    }
    let cmd = build_cmd_local(&cli, &project, &working_dir, &config_files, &args)?;
    spawn_local_stream(&app, cmd, label, on_output)
}

// ---------------------------------------------------------------------------
// 编排跟踪：手动注册与目录扫描
// ---------------------------------------------------------------------------

/// 判断文件名是否为 compose 文件（大小写不敏感）
fn is_compose_file_name(name: &str) -> bool {
    COMPOSE_FILE_NAMES
        .iter()
        .any(|f| f.eq_ignore_ascii_case(name))
}

/// 从 compose 文件内容推导项目名：顶层 `name:` 字段（compose spec）→ 文件所在目录名。
/// 顶层字段行无缩进，因此按行首前缀匹配即可与 service 级字段区分
fn compose_project_name(content: &str, path: &str) -> String {
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("name:") {
            let v = rest.trim().trim_matches('"').trim_matches('\'');
            if !v.is_empty() {
                return v.to_string();
            }
        }
    }
    Path::new(path)
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 手动注册编排：读取 compose 文件（ssh 连接时读远端文件），推导项目名后写入跟踪记录。
/// 同名记录已存在时更新路径并把来源提升为 registered（用户显式确认）
#[tauri::command]
pub async fn add_tracked_compose_project(
    app: tauri::AppHandle,
    path: String,
    name: Option<String>,
) -> CmdResult<()> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("请填写 compose 文件路径".into());
    }
    if !matches!(
        Path::new(&path).extension().and_then(|e| e.to_str()),
        Some("yml") | Some("yaml")
    ) {
        return Err("请选择 .yml / .yaml 编排文件".into());
    }
    let content = read_compose_file(path.clone()).await?;
    let project = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| compose_project_name(&content, &path));
    if project.is_empty() {
        return Err("无法从文件推导项目名，请手动填写".into());
    }
    let working_dir = Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    log::info!("手动注册编排项目 {project}（{path}）");
    let conn_id = active_connection_id();
    let mut s = settings::load(&app);
    upsert_tracked(
        &mut s.compose_projects,
        &conn_id,
        &project,
        &working_dir,
        &[path],
        "registered",
    );
    settings::save(&app, &s)?;
    Ok(())
}

/// 移除当前连接下指定项目名的跟踪记录（项目重新 up 后会再次自动记忆）
#[tauri::command]
pub async fn remove_tracked_compose_project(app: tauri::AppHandle, name: String) -> CmdResult<()> {
    let conn_id = active_connection_id();
    let mut s = settings::load(&app);
    let before = s.compose_projects.len();
    s.compose_projects
        .retain(|t| !(t.connection_id == conn_id && t.name == name));
    if s.compose_projects.len() == before {
        return Err(format!("项目 {name} 没有本地跟踪记录"));
    }
    settings::save(&app, &s)?;
    Ok(())
}

/// 本地递归扫描：收集层级 ≤3 的 compose 文件（与 find -maxdepth 3 对齐），
/// 跳过隐藏目录与 node_modules，符号链接不跟随
async fn scan_dir_local(dir: &Path, levels_left: u8, out: &mut Vec<String>) {
    if levels_left == 0 {
        return;
    }
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let Ok(ft) = entry.file_type().await else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if ft.is_file() {
            if is_compose_file_name(&name) {
                out.push(entry.path().to_string_lossy().to_string());
            }
        } else if ft.is_dir() && levels_left > 1 && !name.starts_with('.') && name != "node_modules"
        {
            Box::pin(scan_dir_local(&entry.path(), levels_left - 1, out)).await;
        }
    }
}

/// 远程扫描：经 ssh 在远端 find（stderr 丢弃，部分目录不存在不阻塞其余目录）
async fn scan_dirs_remote(p: &ConnectionProfile, dirs: &[String]) -> CmdResult<Vec<String>> {
    let dir_list = dirs
        .iter()
        .map(|d| sh_path(d))
        .collect::<Vec<_>>()
        .join(" ");
    let names = COMPOSE_FILE_NAMES
        .iter()
        .map(|n| format!("-name {n}"))
        .collect::<Vec<_>>()
        .join(" -o ");
    let remote = format!("find {dir_list} -maxdepth 3 \\( {names} \\) -type f 2>/dev/null");
    let out = ssh_output(p, &remote, 30).await?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect())
}

/// 扫描当前连接配置的目录，把发现的 compose 文件写入跟踪记录（source=scanned，
/// 已有记录不降级来源）。仅手动触发，结果持久化——未运行的项目由此保持可见
#[tauri::command]
pub async fn scan_compose_dirs(app: tauri::AppHandle) -> CmdResult<ScanComposeResultDto> {
    let conn_id = active_connection_id();
    let mut s = settings::load(&app);
    let dirs: Vec<String> = s
        .compose_scan_dirs
        .iter()
        .filter(|d| d.connection_id == conn_id)
        .map(|d| d.path.clone())
        .collect();
    if dirs.is_empty() {
        return Err("当前连接尚未配置扫描目录".into());
    }

    let mut files: Vec<String> = Vec::new();
    if let Some(p) = ssh_profile() {
        files = scan_dirs_remote(&p, &dirs).await?;
    } else {
        for dir in &dirs {
            scan_dir_local(Path::new(dir), 3, &mut files).await;
        }
    }
    files.sort();
    files.dedup();

    let mut tracked = std::mem::take(&mut s.compose_projects);
    let mut discovered = 0usize;
    for f in &files {
        let Ok(content) = read_compose_file(f.clone()).await else {
            continue;
        };
        let name = compose_project_name(&content, f);
        if name.is_empty() {
            continue;
        }
        let working_dir = Path::new(f)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        if upsert_tracked(
            &mut tracked,
            &conn_id,
            &name,
            &working_dir,
            std::slice::from_ref(f),
            "scanned",
        ) {
            discovered += 1;
        }
    }
    let tracked_total = tracked
        .iter()
        .filter(|t| t.connection_id == conn_id)
        .count();
    if discovered > 0 {
        s.compose_projects = tracked;
        settings::save(&app, &s).map_err(|e| format!("保存扫描结果失败: {e}"))?;
    }
    log::info!(
        "编排扫描完成：发现 {discovered} 个新项目（共 {} 个文件）",
        files.len()
    );
    Ok(ScanComposeResultDto {
        found: files.len(),
        discovered,
        tracked_total,
    })
}

/// 只读查看 compose 文件内容（限制扩展名与大小；ssh 连接时读取远程文件）
#[tauri::command]
pub async fn read_compose_file(path: String) -> CmdResult<String> {
    let p = Path::new(&path);
    if !matches!(
        p.extension().and_then(|e| e.to_str()),
        Some("yml") | Some("yaml")
    ) {
        return Err("仅支持查看 .yml / .yaml 文件".into());
    }
    if let Some(prof) = ssh_profile() {
        let out = ssh_check(
            &prof,
            &format!("cat {}", sh_path(&path)),
            15,
            "读取文件失败",
        )
        .await?;
        if out.stdout.len() > 2 * 1024 * 1024 {
            return Err("文件超过 2MB，不予显示".into());
        }
        return String::from_utf8(out.stdout).map_err(|_| "文件不是有效的 UTF-8 文本".to_string());
    }
    let meta = tokio::fs::metadata(p)
        .await
        .map_err(|e| format!("读取文件失败: {e}"))?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("文件超过 2MB，不予显示".into());
    }
    tokio::fs::read_to_string(p)
        .await
        .map_err(|e| format!("读取文件失败: {e}"))
}

/// 保存 compose 文件：CLI 可用时先用 `docker compose config` 预检语法，
/// 备份原文件为 <path>.bak 后以临时文件 + rename 原子写入。
/// ssh 连接时各步骤经 ssh 在远程执行（见 write_compose_file_remote）
#[tauri::command]
pub async fn write_compose_file(path: String, content: String) -> CmdResult<()> {
    let p = Path::new(&path);
    if !matches!(
        p.extension().and_then(|e| e.to_str()),
        Some("yml") | Some("yaml")
    ) {
        return Err("仅支持编辑 .yml / .yaml 文件".into());
    }
    if content.trim().is_empty() {
        return Err("文件内容不能为空".into());
    }
    log::info!("保存 compose 文件：{path}");
    if content.len() > 2 * 1024 * 1024 {
        return Err("文件超过 2MB，不予保存".into());
    }
    if let Some(prof) = ssh_profile() {
        let cli = detect_cli().await?;
        return write_compose_file_remote(&prof, &cli, &path, &content).await;
    }
    write_compose_file_local(&path, &content).await
}

/// ssh 连接的保存：内容上传到远端同目录临时文件 → 远端语法预检（plugin 版）→
/// 备份原文件后原子替换；校验未通过时清理远端临时文件，原文件不受影响
async fn write_compose_file_remote(
    p: &ConnectionProfile,
    cli: &Cli,
    path: &str,
    content: &str,
) -> CmdResult<()> {
    let tmp = format!("{path}.dockpilot-tmp");
    ssh_write_remote(p, &sh_path(&tmp), content.as_bytes(), 60).await?;
    // 语法预检：仅 plugin 版 CLI 支持 config --quiet；standalone（含 v1）跳过
    if cli.kind == CliKind::Plugin {
        let remote = build_remote_compose(
            p,
            cli,
            "dockpilot-check",
            "",
            std::slice::from_ref(&tmp),
            &["config".into(), "--quiet".into()],
        );
        if let Err(e) = ssh_check(p, &remote, 30, "compose 文件校验未通过").await {
            let _ = ssh_output(p, &format!("rm -f {}", sh_path(&tmp)), 15).await;
            return Err(e);
        }
    }
    // 备份原文件（保留最近一次；原文件不存在时 cp 失败不阻塞）后原子替换
    let swap = format!(
        "cp {p} {bak} 2>/dev/null; mv {t} {p}",
        p = sh_path(path),
        bak = sh_path(&format!("{path}.bak")),
        t = sh_path(&tmp),
    );
    ssh_check(p, &swap, 15, "保存远程文件失败").await?;
    Ok(())
}

/// 本机保存：先把新内容写入同目录临时文件（预检校验的是新内容而非磁盘旧文件），
/// 校验通过后备份并原子替换
async fn write_compose_file_local(path: &str, content: &str) -> CmdResult<()> {
    let p = Path::new(path);
    let tmp = PathBuf::from(format!("{path}.dockpilot-tmp"));
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| format!("写入临时文件失败: {e}"))?;
    // 语法预检：仅 plugin 版 CLI 支持 config --quiet；未装 CLI 时跳过（保存文件本身不依赖 CLI）
    if let Ok(cli) = detect_cli().await {
        if cli.kind == CliKind::Plugin {
            let dir = p
                .parent()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut cmd = build_cmd_local(
                &cli,
                "dockpilot-check",
                &dir,
                &[tmp.to_string_lossy().to_string()],
                &["config".into(), "--quiet".into()],
            )?;
            let out = tokio::time::timeout(Duration::from_secs(30), cmd.output())
                .await
                .map_err(|_| "语法预检超时".to_string())?
                .map_err(|e| format!("语法预检执行失败: {e}"))?;
            if !out.status.success() {
                let _ = tokio::fs::remove_file(&tmp).await;
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("compose 文件校验未通过：{}", err.trim()));
            }
        }
    }
    // 校验通过：备份原文件（保留最近一次）后原子替换
    if p.exists() {
        let backup = PathBuf::from(format!("{path}.bak"));
        tokio::fs::copy(p, &backup)
            .await
            .map_err(|e| format!("备份原文件失败: {e}"))?;
    }
    tokio::fs::rename(&tmp, p)
        .await
        .map_err(|e| format!("保存文件失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(
        name: &str,
        project: Option<&str>,
        service: Option<&str>,
        state: &str,
    ) -> ContainerSnapshot {
        ContainerSnapshot {
            name: name.into(),
            id: format!("id-{name}"),
            image: "nginx:latest".into(),
            state: state.into(),
            status: "Up 2 minutes".into(),
            ports: vec![],
            project: project.map(Into::into),
            service: service.map(Into::into),
            working_dir: Some("/tmp/proj".into()),
            config_files: Some("/tmp/proj/compose.yaml".into()),
        }
    }

    #[test]
    fn ignore_containers_without_compose_labels() {
        let projects = group_projects(vec![snap("web", None, None, "running")]);
        assert!(projects.is_empty(), "无标签容器不应出现在任何项目里");
    }

    #[test]
    fn group_by_project_and_count_running() {
        let projects = group_projects(vec![
            snap("a-web", Some("app"), Some("web"), "running"),
            snap("a-db", Some("app"), Some("db"), "exited"),
            snap("b-web", Some("blog"), Some("web"), "running"),
        ]);
        assert_eq!(projects.len(), 2);
        // BTreeMap 保证按项目名排序
        assert_eq!(projects[0].name, "app");
        assert_eq!(projects[0].total_count, 2);
        assert_eq!(projects[0].running_count, 1);
        assert_eq!(projects[0].services.len(), 2);
        assert_eq!(projects[1].name, "blog");
        assert_eq!(projects[1].running_count, 1);
    }

    #[test]
    fn missing_service_falls_back_to_container_name() {
        let mut c = snap("orphan", Some("app"), None, "running");
        c.service = None;
        let projects = group_projects(vec![c]);
        assert_eq!(projects[0].services[0].name, "orphan");
    }

    #[test]
    fn config_files_label_is_split_by_comma() {
        let mut c = snap("web", Some("app"), Some("web"), "running");
        c.config_files = Some("/a/base.yml , /a/override.yml".into());
        let projects = group_projects(vec![c]);
        assert_eq!(
            projects[0].config_files,
            vec!["/a/base.yml", "/a/override.yml"]
        );
    }

    #[test]
    fn working_dir_taken_from_first_non_empty() {
        let mut first = snap("a", Some("app"), Some("a"), "running");
        first.working_dir = None;
        let projects = group_projects(vec![first, snap("b", Some("app"), Some("b"), "running")]);
        assert_eq!(projects[0].working_dir, "/tmp/proj");
    }

    fn proj_dto(name: &str, source: &str) -> ComposeProjectDto {
        ComposeProjectDto {
            name: name.into(),
            working_dir: "/tmp/proj".into(),
            config_files: vec!["/tmp/proj/compose.yaml".into()],
            services: vec![],
            running_count: 1,
            total_count: 1,
            source: source.into(),
        }
    }

    fn tracked(conn: &str, name: &str, source: &str) -> TrackedComposeProject {
        TrackedComposeProject {
            id: format!("id-{conn}-{name}"),
            connection_id: conn.into(),
            name: name.into(),
            working_dir: format!("/tracked/{name}"),
            config_files: vec![format!("/tracked/{name}/compose.yaml")],
            source: source.into(),
            added_at: 0,
        }
    }

    #[test]
    fn upsert_tracked_appends_and_updates() {
        let mut tracked = Vec::new();
        assert!(upsert_tracked(
            &mut tracked,
            "local",
            "app",
            "/a",
            &["/a/compose.yaml".into()],
            "remembered"
        ));
        assert_eq!(tracked.len(), 1);
        assert_eq!(tracked[0].source, "remembered");

        // 相同路径重复记忆 → 无变化（调用方可跳过写盘）
        assert!(!upsert_tracked(
            &mut tracked,
            "local",
            "app",
            "/a",
            &["/a/compose.yaml".into()],
            "remembered"
        ));
        assert_eq!(tracked.len(), 1);

        // 路径变化 → 更新，来源不降级
        assert!(upsert_tracked(
            &mut tracked,
            "local",
            "app",
            "/b",
            &["/b/compose.yaml".into()],
            "remembered"
        ));
        assert_eq!(tracked[0].working_dir, "/b");

        // 不同连接同名 → 独立记录
        assert!(upsert_tracked(
            &mut tracked,
            "ssh-1",
            "app",
            "/x",
            &["/x/compose.yaml".into()],
            "scanned"
        ));
        assert_eq!(tracked.len(), 2);
        assert_eq!(tracked[1].source, "scanned");

        // 缺名称或缺配置文件 → 忽略
        assert!(!upsert_tracked(
            &mut tracked,
            "local",
            "",
            "/a",
            &["/a/f.yaml".into()],
            "remembered"
        ));
        assert!(!upsert_tracked(
            &mut tracked,
            "local",
            "x",
            "/a",
            &[],
            "remembered"
        ));
        assert_eq!(tracked.len(), 2);
    }

    #[test]
    fn merge_projects_prefers_containers_and_fills_tracked() {
        let containers = vec![proj_dto("app", "containers")];
        let records = vec![
            tracked("local", "app", "registered"),
            tracked("local", "ghost", "remembered"),
            // 其他连接的记录不参与合并
            tracked("ssh-1", "remote", "remembered"),
        ];
        let merged = merge_projects(containers, &records, "local");
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].name, "app");
        assert_eq!(merged[0].source, "containers", "容器识别优先");
        assert_eq!(merged[1].name, "ghost");
        assert_eq!(merged[1].source, "remembered");
        assert_eq!(merged[1].total_count, 0);
        assert_eq!(merged[1].running_count, 0);
        assert!(merged[1].services.is_empty());

        // 容器项目路径字段缺失时以跟踪记录补全
        let mut bare = proj_dto("ghost2", "containers");
        bare.working_dir = String::new();
        bare.config_files = Vec::new();
        let merged = merge_projects(
            vec![bare],
            &[tracked("local", "ghost2", "registered")],
            "local",
        );
        assert_eq!(merged[0].working_dir, "/tracked/ghost2");
        assert_eq!(merged[0].config_files, vec!["/tracked/ghost2/compose.yaml"]);
    }

    #[test]
    fn merge_projects_sorts_by_name() {
        // 跟踪记录补入后整体仍按名称稳定排序
        let merged = merge_projects(
            vec![proj_dto("zzz", "containers")],
            &[tracked("local", "aaa", "remembered")],
            "local",
        );
        let names: Vec<_> = merged.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["aaa", "zzz"]);
    }

    #[test]
    fn compose_project_name_from_field_or_dir() {
        assert_eq!(
            compose_project_name("name: myapp\nservices: {}", "/x/y/compose.yaml"),
            "myapp"
        );
        assert_eq!(
            compose_project_name("name: \"quoted\"\n", "/x/y/compose.yaml"),
            "quoted"
        );
        // 缩进的 name: 是 service 级字段，不能当作项目名
        assert_eq!(
            compose_project_name(
                "services:\n  web:\n    name: inner\n",
                "/apps/blog/compose.yaml"
            ),
            "blog"
        );
        assert_eq!(
            compose_project_name("services: {}\n", "/apps/blog/docker-compose.yml"),
            "blog"
        );
        assert_eq!(compose_project_name("services: {}\n", "/compose.yaml"), "");
    }

    #[test]
    fn compose_file_name_match() {
        for f in COMPOSE_FILE_NAMES {
            assert!(is_compose_file_name(f));
        }
        assert!(is_compose_file_name("Compose.YAML"));
        assert!(!is_compose_file_name("compose.yaml.bak"));
        // 超集文件名不匹配（override 文件需显式 -f，不在自动扫描范围）
        assert!(!is_compose_file_name("docker-compose.override.yaml"));
    }

    #[test]
    fn action_args_mapping() {
        assert_eq!(
            build_action_args("up", false, false, &[]).unwrap(),
            vec!["up", "-d"]
        );
        assert_eq!(
            build_action_args("up_build", false, false, &["web".into()]).unwrap(),
            vec!["up", "-d", "--build", "web"]
        );
        assert_eq!(
            build_action_args("down", true, true, &[]).unwrap(),
            vec!["down", "--volumes", "--rmi", "local"]
        );
        assert_eq!(
            build_action_args("stop", false, false, &["db".into(), "web".into()]).unwrap(),
            vec!["stop", "db", "web"]
        );
        assert!(build_action_args("reboot", false, false, &[]).is_err());
    }

    #[test]
    fn sh_quote_escapes_special_chars() {
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("plain"), "'plain'");
        assert_eq!(sh_quote("a b/c d"), "'a b/c d'");
        // 内嵌单引号：' → '\''（闭合、转义引号、重开）
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn sh_path_keeps_leading_tilde_unquoted() {
        assert_eq!(sh_path("/abs/compose.yaml"), "'/abs/compose.yaml'");
        assert_eq!(sh_path("~/dockpilot/my-app"), "~/'dockpilot/my-app'");
        assert_eq!(sh_path("~/a b/compose.yaml"), "~/'a b/compose.yaml'");
    }

    #[test]
    fn remote_compose_command_is_fully_quoted() {
        let p = ConnectionProfile {
            kind: "ssh".into(),
            host: "root@10.0.0.5".into(),
            ..Default::default()
        };
        let cli = Cli {
            kind: CliKind::Plugin,
            version: "2.24.0".into(),
        };
        let remote = build_remote_compose(
            &p,
            &cli,
            "my app",
            "/home/u/my proj",
            &["/home/u/my proj/compose.yaml".into()],
            &["up".into(), "-d".into()],
        );
        assert!(
            remote.starts_with("env 'DOCKER_HOST=unix:///var/run/docker.sock' docker compose "),
            "远程命令应以 env DOCKER_HOST 前缀 + docker compose 开头: {remote}"
        );
        assert!(remote.contains("-p 'my app'"));
        assert!(remote.contains("-f '/home/u/my proj/compose.yaml'"));
        assert!(remote.contains("--project-directory '/home/u/my proj'"));
        assert!(remote.ends_with("'up' '-d'"));

        let standalone = Cli {
            kind: CliKind::Standalone,
            version: "1".into(),
        };
        assert!(
            build_remote_compose(&p, &standalone, "a", "", &[], &[]).contains(" docker-compose "),
            "standalone 版远程命令应调用 docker-compose"
        );
    }

    /// 依赖本机 compose CLI（plugin）的保存集成测试：
    /// 合法内容写入并生成 .bak 备份；非法内容被预检拒绝且不破坏原文件
    #[tokio::test]
    async fn write_compose_file_backup_and_validate() {
        if detect_cli().await.is_err() {
            eprintln!("跳过：本机未安装 compose CLI");
            return;
        }
        let dir =
            std::env::temp_dir().join(format!("dockpilot-compose-write-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let file = dir.join("compose.yaml");
        let original = "services:\n  a:\n    image: busybox:stable\n";
        tokio::fs::write(&file, original).await.unwrap();
        let path = file.to_string_lossy().to_string();

        // 合法内容：保存成功、生成备份、tmp 文件不残留
        let updated = "services:\n  a:\n    image: busybox:stable\n  b:\n    image: alpine:3.20\n";
        write_compose_file(path.clone(), updated.into())
            .await
            .expect("合法内容应保存成功");
        assert_eq!(
            tokio::fs::read_to_string(format!("{path}.bak"))
                .await
                .unwrap(),
            original,
            "备份应保存写入前的内容"
        );
        assert!(
            tokio::fs::read_to_string(&path)
                .await
                .unwrap()
                .contains("alpine"),
            "新内容应已写入"
        );
        assert!(
            !tokio::fs::try_exists(format!("{path}.dockpilot-tmp"))
                .await
                .unwrap(),
            "临时文件应被 rename 消费"
        );

        // 非法内容：预检拒绝且原文件不被破坏
        let result = write_compose_file(
            path.clone(),
            "services:\n  a:\n    image: [unclosed\n".into(),
        )
        .await;
        eprintln!("非法写入结果: {result:?}");
        assert!(result.is_err(), "语法非法的内容应被预检拒绝");
        assert!(
            tokio::fs::read_to_string(&path)
                .await
                .unwrap()
                .contains("alpine"),
            "被拒绝的保存不应破坏原文件"
        );

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
