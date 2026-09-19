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
  created: number;
  ports: PortDto[];
  /** compose 项目名（来自容器标签，非 compose 容器为 null） */
  compose_project: string | null;
  /** compose 服务名 */
  compose_service: string | null;
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

export interface NetworkDto {
  id: string;
  name: string;
  driver: string;
}
