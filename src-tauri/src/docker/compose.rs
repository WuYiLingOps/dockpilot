//! Docker Compose 支持：项目识别走 Engine API（容器标签分组），编排操作走 compose CLI。
//! 约定：compose 容器自带 com.docker.compose.* 标签，据此重建 -p/-f/--project-directory 参数。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use bollard::container::ListContainersOptions;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::conn::{docker, CmdResult};
use super::containers::map_container;
use super::dto::{ComposeCliInfoDto, ComposeOutput, ComposeProjectDto, ComposeServiceDto, PortDto};
use super::state::Streams;
use crate::docker::conn;

/// compose 项目名标签
pub const LABEL_PROJECT: &str = "com.docker.compose.project";
/// compose 服务名标签
pub const LABEL_SERVICE: &str = "com.docker.compose.service";
const LABEL_WORKING_DIR: &str = "com.docker.compose.project.working_dir";
const LABEL_CONFIG_FILES: &str = "com.docker.compose.project.config_files";

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

/// 探测本机可用的 compose CLI：优先 docker compose 插件，回退 docker-compose。
/// 每次操作实时探测，避免应用运行期间安装/卸载后状态过期。
async fn detect_cli() -> CmdResult<Cli> {
    if let Some(cli) = probe(CliKind::Plugin, "docker", &["compose", "version", "--short"]).await {
        return Ok(cli);
    }
    if let Some(cli) = probe(CliKind::Standalone, "docker-compose", &["version", "--short"]).await {
        return Ok(cli);
    }
    Err("未检测到 Docker Compose CLI，请先安装（Debian/Ubuntu：sudo apt install docker-compose-plugin）".into())
}

async fn probe(kind: CliKind, program: &str, args: &[&str]) -> Option<Cli> {
    let fut = Command::new(program).args(args).output();
    let out = tokio::time::timeout(Duration::from_secs(10), fut).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(Cli { kind, version })
}

/// 组装 compose 命令：参数数组直调（无 shell，无注入风险）。
/// 显式设置 DOCKER_HOST 与 bollard 当前连接一致（本地 socket / TCP / TLS / SSH 隧道），
/// 避免用户环境变量把 CLI 指向别的 daemon。
fn build_cmd(cli: &Cli, project: &str, working_dir: &str, files: &[String], args: &[String]) -> Command {
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
    cmd
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

fn snapshot(c: &bollard::models::ContainerSummary) -> ContainerSnapshot {
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
            services.sort_by(|a, b| a.name.cmp(&b.name).then(a.container_id.cmp(&b.container_id)));
            let total_count = services.len();
            let running_count = services.iter().filter(|s| s.state == "running").count();
            ComposeProjectDto {
                name,
                working_dir,
                config_files,
                services,
                running_count,
                total_count,
            }
        })
        .collect()
}

/// 从引擎容器标签反查项目的 working_dir 与 config_files，供 CLI 操作重建参数
async fn project_config(project: &str) -> CmdResult<(String, Vec<String>)> {
    let d = docker().await?;
    let list = d
        .list_containers(Some(ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        }))
        .await
        .map_err(|e| format!("获取容器列表失败: {e}"))?;
    for c in &list {
        let Some(labels) = c.labels.as_ref() else { continue };
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
    Err(format!("未找到项目 {project} 的容器，无法确定 compose 配置"))
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

/// 启动子进程并推送输出；结束时发送 code（退出码），被取消时发送 error。
/// 注册到 Streams，前端通过 cancel_stream 取消（kill 子进程）。
fn spawn_stream(
    app: &tauri::AppHandle,
    mut cmd: Command,
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

/// 列出所有 compose 项目（含已停止；按容器标签分组，无需 compose CLI）
#[tauri::command]
pub async fn list_compose_projects() -> CmdResult<Vec<ComposeProjectDto>> {
    let d = docker().await?;
    let list = d
        .list_containers(Some(ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        }))
        .await
        .map_err(|e| format!("获取容器列表失败: {e}"))?;
    Ok(group_projects(list.iter().map(snapshot).collect()))
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
    let (working_dir, config_files) = project_config(&project).await?;
    if config_files.is_empty() {
        return Err(format!("项目 {project} 缺少 compose 配置文件标签，无法执行 CLI 操作"));
    }
    let args = build_action_args(&action, remove_volumes, remove_images, &services)?;
    let cmd = build_cmd(&cli, &project, &working_dir, &config_files, &args);
    spawn_stream(&app, cmd, on_output)
}

/// 部署新项目：指定 compose 文件 + 项目目录 + 项目名，执行 up -d
#[tauri::command]
pub async fn compose_deploy(
    app: tauri::AppHandle,
    files: Vec<String>,
    project_dir: String,
    project_name: String,
    on_output: Channel<ComposeOutput>,
) -> CmdResult<String> {
    if files.is_empty() {
        return Err("请选择至少一个 compose 文件".into());
    }
    for f in &files {
        let p = Path::new(f);
        if !matches!(p.extension().and_then(|e| e.to_str()), Some("yml") | Some("yaml")) {
            return Err(format!("{} 不是 .yml/.yaml 文件", p.display()));
        }
        if !p.is_file() {
            return Err(format!("文件不存在: {}", p.display()));
        }
    }
    let dir = if project_dir.trim().is_empty() {
        Path::new(&files[0])
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        project_dir
    };
    let name = project_name.trim().to_string();
    if name.is_empty() {
        return Err("项目名不能为空".into());
    }
    let cli = detect_cli().await?;
    let cmd = build_cmd(&cli, &name, &dir, &files, &["up".to_string(), "-d".to_string()]);
    spawn_stream(&app, cmd, on_output)
}

/// 只读查看 compose 文件内容（限制扩展名与大小）
#[tauri::command]
pub async fn read_compose_file(path: String) -> CmdResult<String> {
    let p = Path::new(&path);
    if !matches!(p.extension().and_then(|e| e.to_str()), Some("yml") | Some("yaml")) {
        return Err("仅支持查看 .yml / .yaml 文件".into());
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
/// 备份原文件为 <path>.bak 后以临时文件 + rename 原子写入
#[tauri::command]
pub async fn write_compose_file(path: String, content: String) -> CmdResult<()> {
    let p = Path::new(&path);
    if !matches!(p.extension().and_then(|e| e.to_str()), Some("yml") | Some("yaml")) {
        return Err("仅支持编辑 .yml / .yaml 文件".into());
    }
    if content.trim().is_empty() {
        return Err("文件内容不能为空".into());
    }
    if content.len() > 2 * 1024 * 1024 {
        return Err("文件超过 2MB，不予保存".into());
    }
    // 先把新内容写入同目录临时文件，预检校验的是新内容而非磁盘旧文件
    let tmp = PathBuf::from(format!("{}.dockpilot-tmp", path));
    tokio::fs::write(&tmp, &content)
        .await
        .map_err(|e| format!("写入临时文件失败: {e}"))?;
    // 语法预检：仅 plugin 版 CLI 支持 config --quiet；未装 CLI 时跳过（保存文件本身不依赖 CLI）
    if let Ok(cli) = detect_cli().await {
        if cli.kind == CliKind::Plugin {
            let dir = p
                .parent()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut cmd = build_cmd(
                &cli,
                "dockpilot-check",
                &dir,
                &[tmp.to_string_lossy().to_string()],
                &["config".into(), "--quiet".into()],
            );
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
        let backup = PathBuf::from(format!("{}.bak", path));
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

    fn snap(name: &str, project: Option<&str>, service: Option<&str>, state: &str) -> ContainerSnapshot {
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

    /// 依赖本机 compose CLI（plugin）的保存集成测试：
    /// 合法内容写入并生成 .bak 备份；非法内容被预检拒绝且不破坏原文件
    #[tokio::test]
    async fn write_compose_file_backup_and_validate() {
        if detect_cli().await.is_err() {
            eprintln!("跳过：本机未安装 compose CLI");
            return;
        }
        let dir = std::env::temp_dir().join(format!("dockpilot-compose-write-{}", std::process::id()));
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
            tokio::fs::read_to_string(format!("{path}.bak")).await.unwrap(),
            original,
            "备份应保存写入前的内容"
        );
        assert!(
            tokio::fs::read_to_string(&path).await.unwrap().contains("alpine"),
            "新内容应已写入"
        );
        assert!(
            !tokio::fs::try_exists(format!("{path}.dockpilot-tmp")).await.unwrap(),
            "临时文件应被 rename 消费"
        );

        // 非法内容：预检拒绝且原文件不被破坏
        let result = write_compose_file(path.clone(), "services:\n  a:\n    image: [unclosed\n".into()).await;
        eprintln!("非法写入结果: {result:?}");
        assert!(result.is_err(), "语法非法的内容应被预检拒绝");
        assert!(
            tokio::fs::read_to_string(&path).await.unwrap().contains("alpine"),
            "被拒绝的保存不应破坏原文件"
        );

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}

