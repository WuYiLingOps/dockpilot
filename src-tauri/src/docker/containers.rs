use std::collections::HashMap;

use bollard::container::{
    Config, CreateContainerOptions, ListContainersOptions, RemoveContainerOptions,
    RestartContainerOptions, StartContainerOptions, StopContainerOptions,
};
use bollard::models::{
    ContainerSummary, HostConfig, PortBinding, RestartPolicy, RestartPolicyNameEnum,
};

use super::conn::{docker, CmdResult};
use super::dto::{
    ContainerCreateSpec, ContainerDto, KeyValueSpec, PortDto, PortMappingSpec, VolumeMountSpec,
};

pub(super) fn map_container(c: &ContainerSummary) -> ContainerDto {
    let labels = c.labels.as_ref();
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
        status: c.status.clone().unwrap_or_default(),
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
pub async fn list_containers(all: bool) -> CmdResult<Vec<ContainerDto>> {
    let d = docker().await?;
    let list = d
        .list_containers(Some(ListContainersOptions::<String> {
            all,
            ..Default::default()
        }))
        .await
        .map_err(|e| format!("获取容器列表失败: {e}"))?;
    Ok(list.iter().map(map_container).collect())
}

/// action: start | stop | restart | pause | unpause | remove
#[tauri::command]
pub async fn container_action(id: String, action: String, force: bool) -> CmdResult<()> {
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
    .map_err(|e| format!("容器执行 {action} 失败: {e}"))
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
