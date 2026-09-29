/** 与 src-tauri/src/diagnostics.rs 的 DTO 对应 */

/** 上次异常退出信息；kind："panic"（有归因）| "abnormal"（仅感知，如 SIGKILL/断电） */
export interface LastCrashInfo {
  kind: "panic" | "abnormal";
  timestamp: string | null;
  message: string | null;
  location: string | null;
  version: string | null;
}

/** 日志目录中的单个文件（当前会话 + 归档会话） */
export interface LogFileMeta {
  name: string;
  size: number;
  /** epoch 秒；读取失败为 null */
  modified: number | null;
}

/** 单条日志（插件默认行格式解析结果，本地时间） */
export interface AppLogEntry {
  ts: string;
  /** ERROR / WARN / INFO / DEBUG / TRACE */
  level: string;
  target: string;
  message: string;
}

/** read_app_log 返回：entries + 下次增量读取的起始字节 */
export interface AppLogPage {
  entries: AppLogEntry[];
  next_offset: number;
  size: number;
}

/** 日志清理结果（cleanup_app_logs） */
export interface AppLogCleanupResult {
  removed: number;
  /** 释放的字节数 */
  bytes: number;
}
