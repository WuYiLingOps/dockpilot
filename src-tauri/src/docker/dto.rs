use serde::{Deserialize, Serialize};

/// 发送给前端的数据结构；字段名与前端 TS 类型一一对应（snake_case）

#[derive(Debug, Clone, Serialize)]
pub struct PortDto {
    pub ip: Option<String>,
    pub private_port: u16,
    pub public_port: Option<u16>,
    pub proto: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContainerDto {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub created: i64,
    pub ports: Vec<PortDto>,
    /// compose 项目名（来自容器标签 com.docker.compose.project，非 compose 容器为 None）
    pub compose_project: Option<String>,
    /// compose 服务名（来自标签 com.docker.compose.service）
    pub compose_service: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComposeServiceDto {
    pub name: String,
    pub container_id: String,
    pub state: String,
    pub status: String,
    pub image: String,
    pub ports: Vec<PortDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComposeProjectDto {
    pub name: String,
    pub working_dir: String,
    pub config_files: Vec<String>,
    /// 每个服务容器一条；副本扩容时同名服务会出现多行
    pub services: Vec<ComposeServiceDto>,
    pub running_count: usize,
    pub total_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComposeCliInfoDto {
    pub available: bool,
    pub version: String,
    /// "plugin"（docker compose 子命令）| "standalone"（docker-compose 独立二进制）| "none"
    pub source: String,
}

/// compose CLI 子进程输出：code 非空表示进程已结束（code 为退出码），error 非空表示异常终止或被取消
#[derive(Debug, Clone, Serialize)]
pub struct ComposeOutput {
    /// "out" | "err"
    pub stream: String,
    pub data: String,
    pub code: Option<i32>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// 容器创建（前端提交的规格，Deserialize；与 TS types/docker.ts 的 ContainerSpec 对应）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct PortMappingSpec {
    pub host: u16,
    pub container: u16,
    /// "tcp" | "udp"，缺省 tcp
    #[serde(default)]
    pub proto: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VolumeMountSpec {
    pub host: String,
    pub container: String,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeyValueSpec {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContainerCreateSpec {
    /// 缺省由 daemon 自动生成
    #[serde(default)]
    pub name: Option<String>,
    pub image: String,
    #[serde(default)]
    pub ports: Vec<PortMappingSpec>,
    #[serde(default)]
    pub volumes: Vec<VolumeMountSpec>,
    #[serde(default)]
    pub env: Vec<KeyValueSpec>,
    #[serde(default)]
    pub labels: Vec<KeyValueSpec>,
    /// "no" | "always" | "unless-stopped" | "on-failure"
    #[serde(default)]
    pub restart_policy: Option<String>,
    /// 覆盖命令（按 shell 词法拆分为 argv）
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub workdir: Option<String>,
    /// 网络名（缺省 daemon 默认 bridge）
    #[serde(default)]
    pub network: Option<String>,
    #[serde(default)]
    pub hostname: Option<String>,
    /// 内存上限（MB）；None 不限制
    #[serde(default)]
    pub memory_mb: Option<i64>,
    /// CPU 核数（可小数，如 1.5）；None 不限制
    #[serde(default)]
    pub cpus: Option<f64>,
    #[serde(default)]
    pub auto_remove: bool,
    #[serde(default)]
    pub privileged: bool,
    #[serde(default)]
    pub tty: bool,
    #[serde(default)]
    pub open_stdin: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkDto {
    pub id: String,
    pub name: String,
    pub driver: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImageDto {
    pub id: String,
    pub tags: Vec<String>,
    pub size: i64,
    pub created: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DockerInfoDto {
    pub version: String,
    pub api_version: String,
    pub os: String,
    pub arch: String,
    pub containers: u64,
    pub running: u64,
    pub paused: u64,
    pub stopped: u64,
    pub images: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogChunk {
    /// "out" | "err"
    pub stream: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DockerEventDto {
    /// "container" | "image" | "network" | "volume"
    pub kind: String,
    pub action: String,
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatsTick {
    pub cpu_percent: f64,
    pub mem_usage: u64,
    pub mem_limit: u64,
    pub mem_percent: f64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub block_read: u64,
    pub block_write: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullProgress {
    pub status: Option<String>,
    pub id: Option<String>,
    pub progress: Option<String>,
    pub error: Option<String>,
    pub done: bool,
}
