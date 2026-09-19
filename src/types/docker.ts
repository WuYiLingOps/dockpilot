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
