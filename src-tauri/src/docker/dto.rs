use serde::Serialize;

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
