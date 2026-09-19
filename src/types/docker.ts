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
