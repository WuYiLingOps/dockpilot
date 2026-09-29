use std::collections::HashMap;

use bollard::container::{
    Config, CreateContainerOptions, ListContainersOptions, RemoveContainerOptions,
    RestartContainerOptions, StartContainerOptions, StopContainerOptions, TopOptions,
    UpdateContainerOptions,
};
use bollard::models::{
    ContainerSummary, HostConfig, PortBinding, RestartPolicy, RestartPolicyNameEnum,
};

use super::conn::{docker, CmdResult};
use super::dto::{
    ContainerCreateSpec, ContainerDto, ContainerHealthDto, ContainerTopDto, ContainerUpdateSpec,
    HealthCheckLogDto, KeyValueSpec, PortDto, PortMappingSpec, VolumeMountSpec,
};

/// 从 `docker ps` 的 Status 字符串解析健康检查状态：
/// "Up 3 minutes (healthy)" → healthy，"(health: starting)" → starting，
/// "(unhealthy)" → unhealthy；无健康检查时为 None
fn parse_health(status: &str) -> Option<String> {
    let inner = status
        .split_once('(')
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(inner, _)| inner.trim())?;
    match inner {
        "healthy" => Some("healthy".into()),
        "unhealthy" => Some("unhealthy".into()),
        "health: starting" => Some("starting".into()),
        _ => None,
    }
}

pub(super) fn map_container(c: &ContainerSummary) -> ContainerDto {
    let labels = c.labels.as_ref();
    let status = c.status.clone().unwrap_or_default();
    ContainerDto {
        id: c.id.clone().unwrap_or_default(),
        name: c
            .names
            .as_ref()
            .and_then(|v| v.first())
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default(),
        image: c.image.clone().unwrap_or_default(),
        state: c.state.as_ref().map(|s| s.to_string()).unwrap_or_default(),
        health: parse_health(&status),
        status,
        created: c.created.unwrap_or(0),
        ports: c
            .ports
            .as_ref()
            .map(|ps| {
                ps.iter()
                    .map(|p| PortDto {
                        ip: p.ip.clone(),
                        private_port: p.private_port,
                        public_port: p.public_port,
                        proto: p.typ.as_ref().map(|t| t.to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        compose_project: labels.and_then(|l| l.get(super::compose::LABEL_PROJECT).cloned()),
        compose_service: labels.and_then(|l| l.get(super::compose::LABEL_SERVICE).cloned()),
    }
}

#[tauri::command]
/// 列表排序：运行中的容器排最前，paused 次之，其余在后；组内按创建时间倒序（Docker 默认顺序）
pub(super) fn sort_containers(dtos: &mut [ContainerDto]) {
    let rank = |s: &str| match s {
        "running" => 0,
        "paused" => 1,
        _ => 2,
    };
    dtos.sort_by(|a, b| rank(&a.state).cmp(&rank(&b.state)).then(b.created.cmp(&a.created)));
}

#[tauri::command]
pub async fn list_containers(all: bool) -> CmdResult<Vec<ContainerDto>> {
    let d = docker().await?;
    let list = d
        .list_containers(Some(ListContainersOptions::<String> {
            all,
            ..Default::default()
        }))
        .await
        .map_err(|e| format!("获取容器列表失败: {e}"))?;
    let mut dtos: Vec<ContainerDto> = list.iter().map(map_container).collect();
    sort_containers(&mut dtos);
    Ok(dtos)
}

/// 健康检查详情（inspect 的 State.Health；未配置 healthcheck 时 status 为 "none"）
#[tauri::command]
pub async fn container_health(id: String) -> CmdResult<ContainerHealthDto> {
    let d = docker().await?;
    let inspect = d
        .inspect_container(&id, None::<bollard::container::InspectContainerOptions>)
        .await
        .map_err(|e| format!("查看容器失败: {e}"))?;
    let state_info = inspect.state.unwrap_or_default();
    let health = state_info.health.clone().unwrap_or_default();
    Ok(ContainerHealthDto {
        status: health
            .status
            .map(|s| s.as_ref().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "none".into()),
        failing_streak: health.failing_streak.unwrap_or(0),
        log: health
            .log
            .unwrap_or_default()
            .iter()
            .rev()
            .map(|r| HealthCheckLogDto {
                exit_code: r.exit_code.unwrap_or(-1),
                start: r
                    .start
                    .as_ref()
                    .map(|t| t.to_string())
                    .unwrap_or_default(),
                output: r.output.clone().unwrap_or_default(),
            })
            .collect(),
        state: state_info
            .status
            .map(|s| s.as_ref().to_string())
            .unwrap_or_default(),
        exit_code: state_info.exit_code.unwrap_or(0),
        error: state_info.error.clone().unwrap_or_default(),
        oom_killed: state_info.oom_killed.unwrap_or(false),
    })
}

/// 容器内进程列表（docker top）；ps_args 缺省 "-ef"
#[tauri::command]
pub async fn container_top(id: String, ps_args: Option<String>) -> CmdResult<ContainerTopDto> {
    let d = docker().await?;
    let args = ps_args
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("-ef")
        .to_string();
    let top = d
        .top_processes(&id, Some(TopOptions { ps_args: args }))
        .await
        .map_err(|e| format!("查看容器进程失败: {e}"))?;
    Ok(ContainerTopDto {
        titles: top.titles.unwrap_or_default(),
        processes: top.processes.unwrap_or_default(),
    })
}

/// action: start | stop | restart | pause | unpause | remove
#[tauri::command]
pub async fn container_action(id: String, action: String, force: bool) -> CmdResult<()> {
    log::info!(
        "容器 {} 执行 {}{}",
        super::short_id(&id),
        action,
        if force { "（force）" } else { "" }
    );
    let d = docker().await?;
    match action.as_str() {
        "start" => d
            .start_container(&id, None::<bollard::container::StartContainerOptions<String>>)
            .await,
        "stop" => d
            .stop_container(&id, Some(StopContainerOptions { t: 10 }))
            .await,
        "restart" => d
            .restart_container(&id, Some(RestartContainerOptions { t: 10 }))
            .await,
        "pause" => d.pause_container(&id).await,
        "unpause" => d.unpause_container(&id).await,
        "remove" => d
            .remove_container(
                &id,
                Some(RemoveContainerOptions {
                    force,
                    v: true,
                    link: false,
                }),
            )
            .await,
        _ => return Err(format!("未知操作: {action}")),
    }
    .map_err(|e| {
        log::warn!("容器 {} {} 失败: {e}", super::short_id(&id), action);
        format!("容器执行 {action} 失败: {e}")
    })
}

/// 在线更新运行中容器的配置（docker update）：None 的字段保持不变。
/// 注意内存上限只能改大或改小、不能清除（daemon 限制）；若新内存超过
/// 已设置的 memory-swap，daemon 会报错原文透出。
#[tauri::command]
pub async fn update_container_config(
    id: String,
    spec: ContainerUpdateSpec,
) -> CmdResult<()> {
    log::info!("容器 {} 更新配置", super::short_id(&id));
    let (memory, nano_cpus) = match (spec.memory_mb, spec.cpus) {
        (None, None) => (None, None),
        (mb, cpu) => {
            let (m, n) = build_resources(mb, cpu)?;
            (m, n)
        }
    };
    // update 语义下字段省略 = 保持不变，因此"不重启"要显式下发 NO 清除策略
    let restart_policy = match spec.restart_policy.as_deref() {
        None => None,
        Some("no") => Some(RestartPolicy {
            name: Some(RestartPolicyNameEnum::NO),
            maximum_retry_count: None,
        }),
        Some(s) => map_restart_policy(s)?,
    };
    let d = docker().await?;
    d.update_container(
        &id,
        UpdateContainerOptions::<String> {
            memory,
            // 与 Docker 默认比例一致（swap = 2×内存）：不同步时 daemon 会因
            // 既有 memoryswap 限制拒绝内存变更（409）
            memory_swap: memory.map(|m| m.saturating_mul(2)),
            nano_cpus,
            restart_policy,
            ..Default::default()
        },
    )
    .await
    .map_err(|e| {
        log::warn!("容器 {} 更新配置失败: {e}", super::short_id(&id));
        format!("更新容器配置失败: {e}")
    })
}

// ---------------------------------------------------------------------------
// 容器创建（对齐 Docker Desktop 的 Run 能力）
// ---------------------------------------------------------------------------

/// 重启策略字符串 → bollard 枚举；空/"no" 表示不配置
fn map_restart_policy(s: &str) -> Result<Option<RestartPolicy>, String> {
    let name = match s {
        "" | "no" => None,
        "always" => Some(RestartPolicyNameEnum::ALWAYS),
        "unless-stopped" => Some(RestartPolicyNameEnum::UNLESS_STOPPED),
        "on-failure" => Some(RestartPolicyNameEnum::ON_FAILURE),
        other => return Err(format!("未知重启策略: {other}")),
    };
    Ok(name.map(|name| RestartPolicy {
        name: Some(name),
        maximum_retry_count: None,
    }))
}

/// 卷挂载转 -v 风格 bind 字符串（host:container[:ro]）
fn build_binds(volumes: &[VolumeMountSpec]) -> Vec<String> {
    volumes
        .iter()
        .map(|v| {
            let mode = if v.read_only { ":ro" } else { "" };
            format!("{}:{}{}", v.host.trim(), v.container.trim(), mode)
        })
        .collect()
}

/// 端口映射 → PortBindings 表（键为 "容器端口/协议"，同键可绑多个宿主端口）
fn build_port_bindings(
    ports: &[PortMappingSpec],
) -> HashMap<String, Option<Vec<PortBinding>>> {
    let mut map: HashMap<String, Option<Vec<PortBinding>>> = HashMap::new();
    for p in ports {
        let proto = p.proto.as_deref().unwrap_or("tcp");
        let key = format!("{}/{}", p.container, proto);
        map.entry(key)
            .or_insert_with(|| Some(Vec::new()))
            .as_mut()
            .unwrap()
            .push(PortBinding {
                host_ip: None,
                host_port: Some(p.host.to_string()),
            });
    }
    map
}

/// 环境变量转 K=V 列表（忽略空键）
fn build_kv_pairs(items: &[KeyValueSpec]) -> (Vec<String>, HashMap<String, String>) {
    let mut env = Vec::new();
    let mut labels = HashMap::new();
    for item in items {
        let key = item.key.trim();
        if key.is_empty() {
            continue;
        }
        env.push(format!("{key}={}", item.value));
        labels.insert(key.to_string(), item.value.clone());
    }
    (env, labels)
}

/// 覆盖命令按 shell 词法拆分为 argv（支持引号，如 `sh -c "a b"`）
fn parse_command(cmd: Option<&str>) -> Result<Option<Vec<String>>, String> {
    match cmd.map(str::trim) {
        Some(s) if !s.is_empty() => {
            shell_words::split(s).map(Some).map_err(|e| format!("命令解析失败: {e}"))
        }
        _ => Ok(None),
    }
}

/// 资源限制换算：MB → 字节、核数 → nano_cpus（docker --cpus 的内部单位，1 核 = 1e9）
fn build_resources(memory_mb: Option<i64>, cpus: Option<f64>) -> Result<(Option<i64>, Option<i64>), String> {
    let memory = match memory_mb {
        None => None,
        Some(mb) if mb > 0 => Some(mb * 1024 * 1024),
        Some(mb) => return Err(format!("内存上限必须是正数（收到 {mb} MB）")),
    };
    let nano = match cpus {
        None => None,
        Some(c) if c > 0.0 => Some((c * 1_000_000_000.0) as i64),
        Some(c) => return Err(format!("CPU 核数必须是正数（收到 {c}）")),
    };
    Ok((memory, nano))
}

/// 创建并启动容器；镜像不存在时返回明确错误（前端可先拉取再重试）
#[tauri::command]
pub async fn create_container(spec: ContainerCreateSpec) -> CmdResult<String> {
    if spec.image.trim().is_empty() {
        return Err("镜像不能为空".into());
    }
    log::info!(
        "创建容器：{}（镜像 {}）",
        spec.name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("<自动命名>"),
        spec.image.trim()
    );
    let policy = map_restart_policy(spec.restart_policy.as_deref().unwrap_or("no"))?;
    // daemon 会拒绝二者并存，这里提前给出可读错误
    if spec.auto_remove && policy.is_some() {
        return Err("自动移除与重启策略不能同时启用".into());
    }
    let cmd = parse_command(spec.command.as_deref())?;

    let port_bindings = build_port_bindings(&spec.ports);
    let binds = build_binds(&spec.volumes);
    let (env, mut labels) = build_kv_pairs(&spec.env);
    // 标签与环境变量共用 KeyValueSpec，但独立提交、不注入容器环境
    for item in &spec.labels {
        let key = item.key.trim();
        if !key.is_empty() {
            labels.insert(key.to_string(), item.value.clone());
        }
    }
    let (memory, nano_cpus) = build_resources(spec.memory_mb, spec.cpus)?;
    let host_config = HostConfig {
        port_bindings: (!port_bindings.is_empty()).then_some(port_bindings),
        binds: (!binds.is_empty()).then_some(binds),
        network_mode: spec.network.clone().filter(|s| !s.trim().is_empty()),
        memory,
        nano_cpus,
        privileged: Some(spec.privileged),
        auto_remove: Some(spec.auto_remove),
        restart_policy: policy,
        ..Default::default()
    };

    let config = Config {
        image: Some(spec.image.trim().to_string()),
        cmd,
        env: (!env.is_empty()).then_some(env),
        labels: (!labels.is_empty()).then_some(labels),
        hostname: spec.hostname.clone().filter(|s| !s.trim().is_empty()),
        working_dir: spec.workdir.clone().filter(|s| !s.trim().is_empty()),
        tty: Some(spec.tty),
        open_stdin: Some(spec.open_stdin),
        host_config: Some(host_config),
        ..Default::default()
    };

    let d = docker().await?;
    let name = spec
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let created = d
        .create_container(
            Some(CreateContainerOptions {
                name: name.to_string(),
                platform: None,
            }),
            config,
        )
        .await
        .map_err(|e| format!("创建容器失败: {e}"))?;
    let id = created.id;

    d.start_container(&id, None::<StartContainerOptions<String>>)
        .await
        .map_err(|e| format!("容器已创建但启动失败（可在容器列表查看或删除）: {e}"))?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// 克隆容器 / docker run 命令导入
// ---------------------------------------------------------------------------

/// compose 体系标签：克隆时剔除，避免克隆容器被误认成 compose 项目成员
const COMPOSE_LABEL_PREFIXES: [&str; 4] = [
    "com.docker.compose.",
    "com.docker.swarm.",
    "com.docker.manage-x-",
    "docker.sock.volume.",
];

/// argv 拼回命令字符串：含空白/引号的参数用双引号包裹（可被 shell_words::split 还原）
fn argv_to_command(args: &[String]) -> String {
    args.iter()
        .map(|a| {
            if a.is_empty()
                || a.chars()
                    .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '\\'))
            {
                format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\""))
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// docker --memory 风格容量 → MB（"512m"→512、"1g"→1024、无后缀按字节）
fn parse_memory_mb(s: &str) -> Result<i64, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("内存值不能为空".into());
    }
    let (num, mult): (&str, i64) = match s.chars().last().map(|c| c.to_ascii_lowercase()) {
        Some('g') => (&s[..s.len() - 1], 1024),
        Some('m') => (&s[..s.len() - 1], 1),
        Some('k') => (&s[..s.len() - 1], 0),
        Some('b') if s.len() > 1 => {
            // "512mb"/"1gb"：剥掉 b 后按 m/g 再判一次
            let head = &s[..s.len() - 1];
            match head.chars().last().map(|c| c.to_ascii_lowercase()) {
                Some('g') => (&head[..head.len() - 1], 1024),
                Some('m') => (&head[..head.len() - 1], 1),
                _ => (s, 0),
            }
        }
        _ => (s, 0),
    };
    if mult == 0 {
        // 字节 / KB：换算为 MB
        let bytes: f64 = num
            .parse()
            .map_err(|_| format!("内存值不合法: {s}"))?;
        let scale = if num.to_ascii_lowercase().ends_with('k') { 1024.0 } else { 1.0 };
        let mb = (bytes * scale / (1024.0 * 1024.0)).ceil() as i64;
        if mb <= 0 {
            return Err(format!("内存值太小（至少 1MB）: {s}"));
        }
        return Ok(mb);
    }
    let v: f64 = num
        .parse()
        .map_err(|_| format!("内存值不合法: {s}"))?;
    let mb = (v * mult as f64).ceil() as i64;
    if mb <= 0 {
        return Err(format!("内存值必须为正: {s}"));
    }
    Ok(mb)
}

/// -p 端口映射：支持 "8080:80"、"8080:80/udp"、"127.0.0.1:8080:80"；
/// "80"（随机宿主端口）无法在创建表单表达，返回明确错误
fn parse_port_spec(s: &str) -> Result<PortMappingSpec, String> {
    let (spec, proto) = match s.split_once('/') {
        Some((sp, p)) => (sp, p),
        None => (s, "tcp"),
    };
    let parts: Vec<&str> = spec.split(':').collect();
    let (host, container) = match parts.as_slice() {
        [h, c] => (*h, *c),
        [_ip, h, c] => (*h, *c),
        [_c] => {
            return Err(format!(
                "端口映射 {s} 未指定宿主端口（DockPilot 需要显式端口，如 -p 8080:80）"
            ))
        }
        _ => return Err(format!("端口映射不合法: {s}")),
    };
    let host: u16 = host
        .parse()
        .map_err(|_| format!("宿主端口不合法: {host}（{s}）"))?;
    let container: u16 = container
        .parse()
        .map_err(|_| format!("容器端口不合法: {container}（{s}）"))?;
    Ok(PortMappingSpec {
        host,
        container,
        proto: Some(proto.to_string()),
    })
}

/// -v 挂载："host:container[:ro]"；字段不足（匿名挂载 "-v /data"）无法表达，返回错误
fn parse_volume_spec(s: &str) -> Result<VolumeMountSpec, String> {
    let parts: Vec<&str> = s.splitn(3, ':').collect();
    match parts.as_slice() {
        [host, container] => Ok(VolumeMountSpec {
            host: host.to_string(),
            container: container.to_string(),
            read_only: false,
        }),
        [host, container, mode] => Ok(VolumeMountSpec {
            host: host.to_string(),
            container: container.to_string(),
            read_only: mode.contains('r') && mode.contains('o'),
        }),
        _ => Err(format!(
            "卷挂载 {s} 缺少容器路径（DockPilot 需要 host:container 形式）"
        )),
    }
}

/// -e/-l "K=V"；单独的 KEY（从环境透传）无法解析，返回错误
fn parse_kv_spec(s: &str) -> Result<KeyValueSpec, String> {
    match s.split_once('=') {
        Some((k, v)) => Ok(KeyValueSpec {
            key: k.to_string(),
            value: v.to_string(),
        }),
        None => Err(format!(
            "环境变量/标签 {s} 缺少值（请写成 KEY=VALUE 形式，无法从当前环境透传）"
        )),
    }
}

/// docker run token 列表 → 创建规格（`--` 后首个位置参数为镜像，其余为覆盖命令）
fn parse_docker_run_tokens(tokens: &[String]) -> Result<ContainerCreateSpec, String> {
    use std::collections::VecDeque;

    let mut spec = ContainerCreateSpec {
        name: None,
        image: String::new(),
        ports: vec![],
        volumes: vec![],
        env: vec![],
        labels: vec![],
        restart_policy: None,
        command: None,
        workdir: None,
        network: None,
        hostname: None,
        memory_mb: None,
        cpus: None,
        auto_remove: false,
        privileged: false,
        tty: false,
        open_stdin: false,
    };
    let mut command_args: Vec<String> = Vec::new();
    let mut pending: VecDeque<String> = tokens.iter().cloned().collect();
    // "--" 之后旗标失效：下一个位置参数是镜像，其后全部是覆盖命令
    let mut dashdash = false;

    while let Some(tok) = pending.pop_front() {
        // 镜像已确定（或 -- 后已取镜像）：剩余 token 全部是覆盖命令，不再解析旗标
        if !spec.image.is_empty() {
            command_args.push(tok);
            continue;
        }
        if !dashdash && tok == "--" {
            dashdash = true;
            continue;
        }
        let mut inline_value: Option<String> = None;
        let name: String;

        // 取旗标值：支持 "--opt value" 与 "--opt=value" 两种写法
        macro_rules! take_value {
            ($flag:expr) => {{
                match inline_value.take() {
                    Some(v) => v,
                    None => pending
                        .pop_front()
                        .ok_or_else(|| format!("选项 {} 缺少值", $flag))?,
                }
            }};
        }

        // 位置参数：首个（含 -- 之后允许 - 开头）即镜像
        if (dashdash || !tok.starts_with('-') || tok == "-") && spec.image.is_empty() {
            spec.image = tok;
            continue;
        }

        if tok.starts_with("--") {
            // 长旗标：--name xxx 或 --name=xxx
            match tok.split_once('=') {
                Some((n, v)) => {
                    name = n.to_string();
                    inline_value = Some(v.to_string());
                }
                None => name = tok.clone(),
            }
        } else if tok.len() > 2 {
            let rest = &tok[2..];
            let first = tok[1..].chars().next().unwrap_or_default();
            // "-p80:80" / "-p=80:80"：首字母为带值短旗标时按内联值处理
            if matches!(first, 'p' | 'v' | 'e' | 'l' | 'm' | 'w' | 'h') && !rest.is_empty() {
                name = format!("-{first}");
                inline_value = Some(rest.strip_prefix('=').unwrap_or(rest).to_string());
            } else {
                // "-it"/"-dit" 等无值组合：逐字母重新入队
                for ch in tok[1..].chars().rev() {
                    pending.push_front(format!("-{ch}"));
                }
                continue;
            }
        } else {
            name = tok.clone();
        }

        match name.as_str() {
            "-p" | "--publish" => spec
                .ports
                .push(parse_port_spec(&take_value!(&name))?),
            "-v" | "--volume" => spec
                .volumes
                .push(parse_volume_spec(&take_value!(&name))?),
            "-e" | "--env" => spec
                .env
                .push(parse_kv_spec(&take_value!(&name))?),
            "-l" | "--label" => spec
                .labels
                .push(parse_kv_spec(&take_value!(&name))?),
            "--name" => spec.name = Some(take_value!(&name)),
            "--restart" => {
                let v = take_value!(&name);
                spec.restart_policy = Some(v.split(':').next().unwrap_or("no").to_string());
            }
            "-m" | "--memory" => {
                let v = take_value!(&name);
                spec.memory_mb = Some(parse_memory_mb(&v)?);
            }
            "--cpus" => {
                let v = take_value!(&name);
                let c: f64 = v.parse().map_err(|_| format!("CPU 核数不合法: {v}"))?;
                spec.cpus = Some(c);
            }
            "-w" | "--workdir" => spec.workdir = Some(take_value!(&name)),
            "--network" | "--net" => spec.network = Some(take_value!(&name)),
            "-h" | "--hostname" => spec.hostname = Some(take_value!(&name)),
            "--rm" => spec.auto_remove = true,
            "--privileged" => spec.privileged = true,
            "-t" | "--tty" => spec.tty = true,
            "-i" | "--interactive" => spec.open_stdin = true,
            "-d" | "--detach" => {}
            other => {
                return Err(format!(
                    "暂不支持的 docker run 选项: {other}（可手动删除后重新导入）"
                ))
            }
        }
    }

    if spec.image.is_empty() {
        return Err("命令中未找到镜像名".into());
    }
    if !command_args.is_empty() {
        spec.command = Some(argv_to_command(&command_args));
    }
    Ok(spec)
}

/// 解析 `docker run ...` 命令为创建规格，供前端回填创建弹窗
#[tauri::command]
pub fn parse_docker_run(cmd: String) -> CmdResult<ContainerCreateSpec> {
    let tokens = shell_words::split(cmd.trim()).map_err(|e| format!("命令解析失败: {e}"))?;
    if tokens.is_empty() {
        return Err("命令为空".into());
    }
    // 允许整条粘贴（带 "docker run" 前缀）
    let tokens: Vec<String> = if tokens.len() >= 2 && tokens[0] == "docker" && tokens[1] == "run" {
        tokens[2..].to_vec()
    } else {
        tokens
    };
    parse_docker_run_tokens(&tokens)
}

/// Binds 字符串 "host:container[:mode]" → 挂载规格（inspect 反解析用）
fn split_bind(s: &str) -> VolumeMountSpec {
    let mut parts = s.splitn(3, ':');
    let host = parts.next().unwrap_or_default().to_string();
    let container = parts.next().unwrap_or_default().to_string();
    // 模式可为逗号组合（如 "ro,z"）；按词精确匹配，避免 "rw"/"rshared" 误判为只读
    let read_only = parts
        .next()
        .map(|m| m.split(',').any(|p| p.trim() == "ro"))
        .unwrap_or(false);
    VolumeMountSpec {
        host,
        container,
        read_only,
    }
}

/// 字节 → MB（向上取整，避免克隆时限制被静默缩小）
fn bytes_to_mb(bytes: i64) -> i64 {
    if bytes <= 0 {
        return 0;
    }
    (bytes + 1024 * 1024 - 1) / (1024 * 1024)
}

/// nano_cpus → 核数（保留三位小数）
fn nano_to_cpus(nano: i64) -> f64 {
    if nano <= 0 {
        return 0.0;
    }
    (nano as f64 / 1_000_000_000.0 * 1000.0).round() / 1000.0
}

/// inspect 现有容器 → 可回填创建弹窗的规格（克隆容器用）。
/// compose 标签被剔除；daemon 注入的 PATH 等默认环境变量保留原样。
#[tauri::command]
pub async fn container_spec(id: String) -> CmdResult<ContainerCreateSpec> {
    let d = docker().await?;
    let inspect = d
        .inspect_container(&id, None::<bollard::container::InspectContainerOptions>)
        .await
        .map_err(|e| format!("查看容器失败: {e}"))?;

    let config = inspect.config.clone().unwrap_or_default();
    let host_config = inspect.host_config.clone().unwrap_or_default();

    let ports = host_config
        .port_bindings
        .unwrap_or_default()
        .iter()
        .filter_map(|(key, bindings)| {
            let (container, proto) = key.split_once('/')?;
            let container: u16 = container.parse().ok()?;
            bindings
                .as_ref()?
                .iter()
                .filter_map(|b| b.host_port.as_deref().and_then(|p| p.parse::<u16>().ok()))
                .map(|host| PortMappingSpec {
                    host,
                    container,
                    proto: Some(proto.to_string()),
                })
                .collect::<Vec<_>>()
                .into()
        })
        .flatten()
        .collect();

    let (env, labels) = {
        let mut env = Vec::new();
        for e in config.env.unwrap_or_default() {
            if let Some(spec) = parse_kv_spec(&e).ok() {
                env.push(spec);
            }
        }
        let mut labels = Vec::new();
        for (k, v) in config.labels.unwrap_or_default() {
            if COMPOSE_LABEL_PREFIXES.iter().any(|p| k.starts_with(p)) {
                continue;
            }
            labels.push(KeyValueSpec { key: k, value: v });
        }
        (env, labels)
    };

    let restart_policy = host_config
        .restart_policy
        .as_ref()
        .and_then(|p| p.name.as_ref())
        .map(|n| match n {
            RestartPolicyNameEnum::ALWAYS => "always".to_string(),
            RestartPolicyNameEnum::UNLESS_STOPPED => "unless-stopped".to_string(),
            RestartPolicyNameEnum::ON_FAILURE => "on-failure".to_string(),
            _ => "no".to_string(),
        });

    // "container:xxx" 共享网络命名空间无法在创建表单表达，跳过
    let network = host_config
        .network_mode
        .clone()
        .filter(|n| !n.is_empty() && !n.starts_with("container:"));

    Ok(ContainerCreateSpec {
        name: inspect.name.map(|n| n.trim_start_matches('/').to_string()),
        image: config.image.clone().unwrap_or_default(),
        ports,
        volumes: host_config
            .binds
            .unwrap_or_default()
            .iter()
            .map(|b| split_bind(b))
            .collect(),
        env,
        labels,
        restart_policy,
        command: config.cmd.as_ref().map(|c| argv_to_command(c)),
        workdir: config.working_dir.clone().filter(|s| !s.is_empty()),
        network,
        hostname: config.hostname.clone().filter(|s| !s.is_empty()),
        memory_mb: {
            let mb = bytes_to_mb(host_config.memory.unwrap_or(0));
            (mb > 0).then_some(mb)
        },
        cpus: {
            let c = nano_to_cpus(host_config.nano_cpus.unwrap_or(0));
            (c > 0.0).then_some(c)
        },
        auto_remove: host_config.auto_remove.unwrap_or(false),
        privileged: host_config.privileged.unwrap_or(false),
        tty: config.tty.unwrap_or(false),
        open_stdin: config.open_stdin.unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_puts_running_first_then_by_created_desc() {
        let mk = |name: &str, state: &str, created: i64| ContainerDto {
            id: name.into(),
            name: name.into(),
            image: String::new(),
            state: state.into(),
            health: None,
            status: String::new(),
            created,
            ports: vec![],
            compose_project: None,
            compose_service: None,
        };
        let mut list = vec![
            mk("exited-new", "exited", 500),
            mk("running-old", "running", 100),
            mk("exited-old", "exited", 200),
            mk("running-new", "running", 400),
            mk("paused", "paused", 300),
        ];
        sort_containers(&mut list);
        let names: Vec<&str> = list.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["running-new", "running-old", "paused", "exited-new", "exited-old"]);
    }

    #[test]
    fn restart_policy_mapping() {
        assert!(map_restart_policy("").unwrap().is_none());
        assert!(map_restart_policy("no").unwrap().is_none());
        assert!(map_restart_policy("always").unwrap().is_some());
        assert!(map_restart_policy("unless-stopped").unwrap().is_some());
        assert!(map_restart_policy("on-failure").unwrap().is_some());
        assert!(map_restart_policy("forever").is_err());
    }

    #[test]
    fn binds_formatting() {
        let v = |host: &str, container: &str, read_only: bool| VolumeMountSpec {
            host: host.into(),
            container: container.into(),
            read_only,
        };
        let binds = build_binds(&[v("/data", "/srv", false), v("/conf", "/etc/a", true)]);
        assert_eq!(binds, vec!["/data:/srv", "/conf:/etc/a:ro"]);
    }

    #[test]
    fn port_bindings_grouped_by_container_port() {
        let p = |host: u16, container: u16, proto: Option<&str>| PortMappingSpec {
            host,
            container,
            proto: proto.map(Into::into),
        };
        let map = build_port_bindings(&[
            p(8080, 80, None),
            p(8081, 80, Some("tcp")),
            p(5353, 53, Some("udp")),
        ]);
        assert_eq!(map.len(), 2);
        assert_eq!(
            map["80/tcp"].as_ref().unwrap().len(),
            2,
            "同容器端口应合并为多个宿主绑定"
        );
        assert_eq!(map["80/tcp"].as_ref().unwrap()[0].host_port, Some("8080".into()));
        assert_eq!(map["53/udp"].as_ref().unwrap()[0].host_port, Some("5353".into()));
    }

    #[test]
    fn kv_pairs_skip_empty_keys() {
        let (env, labels) = build_kv_pairs(&[
            KeyValueSpec { key: "FOO".into(), value: "bar".into() },
            KeyValueSpec { key: "  ".into(), value: "x".into() },
            KeyValueSpec { key: " EMPTY".into(), value: "".into() },
        ]);
        assert_eq!(env, vec!["FOO=bar", "EMPTY="]);
        assert_eq!(labels.get("FOO").map(String::as_str), Some("bar"));
        assert!(!labels.contains_key("  "));
    }

    #[test]
    fn command_parsing_supports_quotes() {
        assert!(parse_command(None).unwrap().is_none());
        assert!(parse_command(Some("  ")).unwrap().is_none());
        assert_eq!(
            parse_command(Some("sh -c \"echo hi\"")).unwrap(),
            Some(vec!["sh".into(), "-c".into(), "echo hi".into()])
        );
        // 未闭合引号应报错而不是静默丢弃
        assert!(parse_command(Some("echo \"oops")).is_err());
    }

    #[test]
    fn resource_limits_conversion() {
        let (memory, nano) = build_resources(Some(256), Some(1.5)).unwrap();
        assert_eq!(memory, Some(256 * 1024 * 1024));
        assert_eq!(nano, Some(1_500_000_000), "1.5 核应换算为 1.5e9 nano_cpus");
        assert_eq!(build_resources(None, None).unwrap(), (None, None));
        assert!(build_resources(Some(0), None).is_err());
        assert!(build_resources(None, Some(-1.0)).is_err());
    }

    #[test]
    fn health_parsing_from_status() {
        assert_eq!(parse_health("Up 3 minutes (healthy)").as_deref(), Some("healthy"));
        assert_eq!(
            parse_health("Up 3 minutes (health: starting)").as_deref(),
            Some("starting")
        );
        assert_eq!(
            parse_health("Up 2 days (unhealthy)").as_deref(),
            Some("unhealthy")
        );
        // 无健康检查、已退出、非健康相关的括号内容均视为 None
        assert_eq!(parse_health("Up 51 minutes"), None);
        assert_eq!(parse_health("Exited (0) 3 days ago"), None);
        assert_eq!(parse_health(""), None);
    }

    fn run_cmd(cmd: &str) -> Result<ContainerCreateSpec, String> {
        let tokens = shell_words::split(cmd).unwrap();
        parse_docker_run_tokens(&tokens)
    }

    #[test]
    fn docker_run_basic_flags() {
        // docker 语义：旗标在镜像之前，镜像之后全部是覆盖命令
        let s = run_cmd(
            "-p 8080:80 -p 5353:53/udp -v /data:/srv:ro -e FOO=bar -l app=web --name web --restart on-failure:5 -m 512m --cpus 1.5 -w /app --net mynet -h web1 --rm --privileged -it nginx:1.25 sh -c \"echo hi\"",
        )
        .unwrap();
        assert_eq!(s.image, "nginx:1.25");
        assert_eq!(s.name.as_deref(), Some("web"));
        assert_eq!(s.ports.len(), 2);
        assert_eq!(s.ports[0].host, 8080);
        assert_eq!(s.ports[0].container, 80);
        assert_eq!(s.ports[0].proto.as_deref(), Some("tcp"));
        assert_eq!(s.ports[1].proto.as_deref(), Some("udp"));
        assert_eq!(s.volumes[0].host, "/data");
        assert_eq!(s.volumes[0].container, "/srv");
        assert!(s.volumes[0].read_only);
        assert_eq!(s.env[0].key, "FOO");
        assert_eq!(s.labels[0].value, "web");
        assert_eq!(s.restart_policy.as_deref(), Some("on-failure"), "重试次数应被剥离");
        assert_eq!(s.memory_mb, Some(512));
        assert_eq!(s.cpus, Some(1.5));
        assert_eq!(s.workdir.as_deref(), Some("/app"));
        assert_eq!(s.network.as_deref(), Some("mynet"));
        assert_eq!(s.hostname.as_deref(), Some("web1"));
        assert!(s.auto_remove);
        assert!(s.privileged);
        assert!(s.tty);
        assert!(s.open_stdin);
        assert_eq!(s.command.as_deref(), Some("sh -c \"echo hi\""));
    }

    #[test]
    fn docker_run_inline_and_cluster_forms() {
        // --opt=value 与 -p80:80、组合短旗标 -dit
        let s = run_cmd("--name=b1 -p8080:80 -dit busybox").unwrap();
        assert_eq!(s.image, "busybox");
        assert_eq!(s.name.as_deref(), Some("b1"));
        assert_eq!(s.ports[0].host, 8080);
        assert!(s.tty && s.open_stdin);
        // 带 docker run 前缀的整条命令；-- 之后镜像可带 - 开头参数
        let s2 = parse_docker_run("docker run -e A=1 busybox".into()).unwrap();
        assert_eq!(s2.image, "busybox");
        assert_eq!(s2.env[0].key, "A");
        let s3 = run_cmd("-- alpine ping -c 2 localhost").unwrap();
        assert_eq!(s3.image, "alpine");
        assert_eq!(s3.command.as_deref(), Some("ping -c 2 localhost"));
    }

    #[test]
    fn docker_run_rejects_unknown_and_invalid() {
        // 旗标在镜像之前才会被解析为 docker 选项
        assert!(run_cmd("--user root nginx").is_err(), "不支持的选项应报错");
        assert!(run_cmd("-p 80 nginx").is_err(), "缺少宿主端口应报错");
        assert!(run_cmd("-e BARE nginx").is_err(), "无值环境变量应报错");
        assert!(run_cmd("--name web").is_err(), "缺镜像应报错");
        assert!(run_cmd("--restart").is_err(), "缺旗标值应报错");
        assert!(run_cmd("-m bogus nginx").is_err(), "内存值不合法应报错");
        // 镜像之后的旗标按 docker 语义属于覆盖命令，不应报错
        let s = run_cmd("nginx --user root").unwrap();
        assert_eq!(s.image, "nginx");
        assert_eq!(s.command.as_deref(), Some("--user root"));
    }

    #[test]
    fn memory_parsing() {
        assert_eq!(parse_memory_mb("512m").unwrap(), 512);
        assert_eq!(parse_memory_mb("1g").unwrap(), 1024);
        assert_eq!(parse_memory_mb("1.5g").unwrap(), 1536);
        assert_eq!(parse_memory_mb("2gb").unwrap(), 2048);
        // 无后缀按字节、k 按 KB，向上取整到 MB
        assert_eq!(parse_memory_mb("1048576").unwrap(), 1);
        assert_eq!(parse_memory_mb("1048577").unwrap(), 2);
        assert_eq!(parse_memory_mb("1024k").unwrap(), 1);
        assert!(parse_memory_mb("").is_err());
        assert!(parse_memory_mb("abc").is_err());
    }

    #[test]
    fn port_spec_variants() {
        let p = parse_port_spec("127.0.0.1:8080:80").unwrap();
        assert_eq!((p.host, p.container), (8080, 80));
        assert_eq!(p.proto.as_deref(), Some("tcp"));
        let u = parse_port_spec("5353:53/udp").unwrap();
        assert_eq!(u.proto.as_deref(), Some("udp"));
        assert!(parse_port_spec("80").is_err(), "随机宿主端口应明确报错");
        assert!(parse_port_spec("a:b").is_err());
    }

    #[test]
    fn argv_command_roundtrip() {
        // 含空格/引号的 argv 经 argv_to_command 后可被 shell_words 还原
        let args = vec!["sh".to_string(), "-c".to_string(), "echo \"a b\"".to_string(), "".to_string()];
        let joined = argv_to_command(&args);
        assert_eq!(
            shell_words::split(&joined).unwrap(),
            args,
            "拼接后的命令应能无损还原 argv"
        );
    }

    #[test]
    fn bind_split_and_conversions() {
        let v = split_bind("/data:/srv:ro");
        assert_eq!((v.host.as_str(), v.container.as_str(), v.read_only), ("/data", "/srv", true));
        let v2 = split_bind("/data:/srv");
        assert!(!v2.read_only);
        // 显式 rw / 组合模式 / 传播模式不得误判为只读（克隆数据库容器曾因此挂载变 ro）
        assert!(!split_bind("/data:/srv:rw").read_only, "rw 应解析为可写");
        assert!(!split_bind("/data:/srv:rw,z").read_only);
        assert!(!split_bind("/data:/srv:rshared").read_only);
        assert!(split_bind("/data:/srv:ro,z").read_only);
        assert!(split_bind("/data:/srv:z,ro").read_only);
        // 字节 → MB 向上取整、nano_cpus → 核数三位小数
        assert_eq!(bytes_to_mb(256 * 1024 * 1024), 256);
        assert_eq!(bytes_to_mb(256 * 1024 * 1024 + 1), 257);
        assert_eq!(bytes_to_mb(0), 0);
        assert_eq!(nano_to_cpus(1_500_000_000), 1.5);
        assert_eq!(nano_to_cpus(1_234_000_000), 1.234);
        assert_eq!(nano_to_cpus(0), 0.0);
    }
}
