export interface PortDto {
  ip: string | null;
  private_port: number;
  public_port: number | null;
  proto: string | null;
}

export interface ContainerDto {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  /** 健康检查状态："healthy" | "unhealthy" | "starting"（未配置 healthcheck 为 null） */
  health: string | null;
  created: number;
  ports: PortDto[];
  /** compose 项目名（来自容器标签，非 compose 容器为 null） */
  compose_project: string | null;
  /** compose 服务名 */
  compose_service: string | null;
}

/** 单次健康检查结果 */
export interface HealthCheckLogDto {
  exit_code: number;
  /** RFC3339 时间字符串 */
  start: string;
  output: string;
}

/** 容器健康检查详情（inspect 的 State.Health） */
export interface ContainerHealthDto {
  /** "none" | "starting" | "healthy" | "unhealthy" */
  status: string;
  /** 连续失败次数 */
  failing_streak: number;
  /** 最近的检查记录（时间升序，前端取最近一条展示） */
  log: HealthCheckLogDto[];
}

export interface ImageDto {
  id: string;
  tags: string[];
  size: number;
  created: number;
}

export interface DockerInfoDto {
  version: string;
  api_version: string;
  os: string;
  arch: string;
  containers: number;
  running: number;
  paused: number;
  stopped: number;
  images: number;
  /** 逻辑 CPU 核数 */
  ncpu: number;
  /** 宿主总内存（字节） */
  mem_total: number;
  /** 存储驱动（overlay2 等） */
  driver: string;
  /** Docker 根目录（/var/lib/docker） */
  docker_root_dir: string;
  kernel_version: string;
  /** 完整系统名（如 Ubuntu 24.04 LTS） */
  os_name: string;
  /** "linux" | "windows" */
  os_type: string;
  /** 默认日志驱动（json-file 等） */
  logging_driver: string;
  plugins_volume: string[];
  plugins_network: string[];
  /** daemon 连接地址（unix:///path 或 DOCKER_HOST） */
  host: string;
}

/** 全部运行中容器的资源统计聚合（累计值；CPU% 与速率由前端相邻两次采样差分计算） */
export interface HostStatsDto {
  online_cpus: number;
  /** Σ cpu_usage.total_usage（累计 CPU 时间） */
  cpu_total: number;
  /** Σ system_cpu_usage（累计系统 CPU 时间） */
  system_cpu: number;
  /** Σ memory_stats.usage */
  mem_used: number;
  /** Σ 网络接收字节（累计） */
  net_rx: number;
  net_tx: number;
  /** Σ 块设备读取字节（累计） */
  block_read: number;
  block_write: number;
  /** 参与本次统计的运行中容器数 */
  containers_running: number;
}

/** 树图单项：名称 + 占用大小 */
export interface NamedSizeDto {
  name: string;
  size: number;
}

/** docker system df 的总量与明细（与 Rust docker/system.rs 的 DTO 对应） */
export interface SystemDfDto {
  images_size: number;
  images_count: number;
  /** 所有容器根目录可写层写入总量（Σ size_rw） */
  containers_size: number;
  containers_count: number;
  volumes_size: number;
  volumes_count: number;
  /** 构建缓存总量（含使用中） */
  build_cache_size: number;
  /** 构建缓存逐条明细 */
  build_cache: BuildCacheDto[];
  containers: NamedSizeDto[];
  images: NamedSizeDto[];
  volumes: NamedSizeDto[];
}

export interface LogChunk {
  stream: "out" | "err";
  data: string;
}

export interface DockerEventDto {
  kind: string;
  action: string;
  id: string;
  name: string;
}

export interface StatsTick {
  cpu_percent: number;
  mem_usage: number;
  mem_limit: number;
  mem_percent: number;
  net_rx: number;
  net_tx: number;
  block_read: number;
  block_write: number;
}

export interface PullProgress {
  status: string | null;
  id: string | null;
  progress: string | null;
  error: string | null;
  done: boolean;
}

/** 镜像导出进度：written 为已写入 tar 归档的字节数（引擎不提供总量） */
export interface ExportProgress {
  written: number;
  done: boolean;
  error: string | null;
  /** 被用户取消（后端已删除半成品文件） */
  cancelled: boolean;
}

/** 镜像推送进度：按层逐条（引擎不提供字节总量）；current/total 为该层字节数 */
export interface PushProgress {
  status: string | null;
  /** 引擎格式化的进度条文本 */
  progress: string | null;
  current: number | null;
  total: number | null;
  error: string | null;
  done: boolean;
  cancelled: boolean;
}

// ---- 容器创建（与 Rust ContainerCreateSpec 对应，snake_case）----

export interface PortMappingSpec {
  host: number;
  container: number;
  /** "tcp" | "udp"，缺省 tcp */
  proto: string | null;
}

export interface VolumeMountSpec {
  host: string;
  container: string;
  read_only: boolean;
}

export interface KeyValueSpec {
  key: string;
  value: string;
}

export interface ContainerSpec {
  /** null 时由 daemon 自动生成名称 */
  name: string | null;
  image: string;
  ports: PortMappingSpec[];
  volumes: VolumeMountSpec[];
  env: KeyValueSpec[];
  labels: KeyValueSpec[];
  /** "no" | "always" | "unless-stopped" | "on-failure"，no 传 null */
  restart_policy: string | null;
  /** 覆盖命令（按 shell 词法拆分） */
  command: string | null;
  workdir: string | null;
  network: string | null;
  hostname: string | null;
  /** 内存上限（MB），null 不限制 */
  memory_mb: number | null;
  /** CPU 核数（可小数，如 1.5），null 不限制 */
  cpus: number | null;
  auto_remove: boolean;
  privileged: boolean;
  tty: boolean;
  open_stdin: boolean;
}

/** 键值对展示（标签等，与 Rust KeyValueDto 对应） */
export interface KeyValueDto {
  key: string;
  value: string;
}

export interface NetworkDto {
  id: string;
  name: string;
  driver: string;
  /** "local" | "swarm" */
  scope: string;
  internal: boolean;
  attachable: boolean;
  enable_ipv6: boolean;
  /** RFC3339 时间字符串 */
  created: string | null;
  /** IPAM 首个配置的子网/网关（未自定义时为 null） */
  subnet: string | null;
  gateway: string | null;
  /** 已连接容器明细 */
  containers: NetworkContainerDto[];
  /** 内置网络（bridge/host/none）不可删除 */
  built_in: boolean;
  labels: KeyValueDto[];
}

export interface NetworkContainerDto {
  name: string;
  id: string;
  /** 含 CIDR 后缀（如 172.18.0.2/16） */
  ipv4: string;
  mac: string;
}

export interface VolumeDto {
  name: string;
  driver: string;
  /** "local" | "cluster" */
  scope: string;
  mountpoint: string;
  /** RFC3339 时间字符串 */
  created: string | null;
  /** 占用大小（非 local 驱动不可统计时为 0） */
  size: number;
  ref_count: number;
  in_use: boolean;
  /** 使用该卷的容器名 */
  used_by: string[];
  labels: KeyValueDto[];
}

/** 构建缓存逐条明细 */
export interface BuildCacheDto {
  id: string;
  /** "internal" | "frontend" | "source" | "exec.cachemount" | "regular" */
  typ: string;
  description: string;
  size: number;
  created_at: string | null;
  in_use: boolean;
  shared: boolean;
  usage_count: number;
}

// ---- 卷/网络创建（与 Rust VolumeCreateSpec / NetworkCreateSpec 对应）----

export interface VolumeSpec {
  name: string;
  /** null 时使用 local */
  driver: string | null;
  labels: KeyValueSpec[];
}

export interface NetworkSpec {
  name: string;
  /** null 时使用 bridge */
  driver: string | null;
  /** CIDR，null 由 daemon 自动分配 */
  subnet: string | null;
  gateway: string | null;
  internal: boolean;
  attachable: boolean;
  enable_ipv6: boolean;
  labels: KeyValueSpec[];
}
