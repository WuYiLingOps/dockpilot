import type { PortDto } from "./docker";

/** 与 Rust docker/compose.rs 的 DTO 对应（snake_case） */

export interface ComposeServiceDto {
  name: string;
  container_id: string;
  state: string;
  status: string;
  image: string;
  ports: PortDto[];
}

/** 项目来源：containers = 运行容器标签识别；其余为本地跟踪（down 后/未 up 也可见） */
export type ComposeSource = "containers" | "remembered" | "registered" | "scanned";

export interface ComposeProjectDto {
  name: string;
  working_dir: string;
  config_files: string[];
  /** 每个服务容器一条；副本扩容时同名服务会出现多行 */
  services: ComposeServiceDto[];
  running_count: number;
  total_count: number;
  source: ComposeSource;
}

export interface ComposeCliInfoDto {
  available: boolean;
  version: string;
  /** "plugin"（docker compose 子命令）| "standalone"（docker-compose 二进制）| "none" */
  source: "plugin" | "standalone" | "none";
}

/** compose CLI 子进程输出：code 非空表示进程已结束（含退出码），error 非空表示异常终止或被取消 */
export interface ComposeOutput {
  stream: "out" | "err";
  data: string;
  code: number | null;
  error: string | null;
}

/** 目录扫描结果（与后端 ScanComposeResultDto 对应） */
export interface ScanComposeResultDto {
  /** 扫描到的 compose 文件数 */
  found: number;
  /** 新增/更新的跟踪记录数 */
  discovered: number;
  /** 当前连接的跟踪记录总数 */
  tracked_total: number;
}
