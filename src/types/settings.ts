/** 与 src-tauri/src/settings.rs 的 AppSettings 对应 */

export type ThemeMode = "system" | "light" | "dark";
export type TerminalShell = "bash" | "sh" | "ash";
export type ConnectionKind = "local" | "tcp" | "tls" | "ssh";

/** 与后端 ConnectionProfile 对应；kind 决定各字段语义 */
export interface ConnectionProfile {
  id: string;
  name: string;
  kind: ConnectionKind;
  /** local: socket 路径（空 = 默认 /var/run/docker.sock） */
  socket_path: string;
  /** tcp/tls: host:port；ssh: user@host[:port] */
  host: string;
  /** tls: 证书目录（含 ca.pem / cert.pem / key.pem） */
  cert_path: string;
  /** ssh: 可选私钥路径 */
  key_path: string;
  /** ssh: 远程 docker socket 路径（空 = /var/run/docker.sock） */
  remote_socket: string;
}

/** 后端 test_connection 返回 */
export interface ConnectionTestResult {
  ok: boolean;
  latency_ms: number | null;
  version: string;
  error: string;
}

export interface AppSettings {
  theme: ThemeMode;
  docker_socket: string;
  connections: ConnectionProfile[];
  active_connection_id: string;
  containers_refresh_secs: number;
  images_refresh_secs: number;
  logs_default_tail: number;
  logs_timestamps: boolean;
  terminal_shell: TerminalShell;
  mirror_custom: string[];
}

/** 连接类型的中文标签与说明 */
export const CONNECTION_KINDS: { key: ConnectionKind; label: string }[] = [
  { key: "local", label: "本地" },
  { key: "ssh", label: "SSH" },
  { key: "tls", label: "TLS" },
  { key: "tcp", label: "TCP" },
];

export function connectionKindLabel(kind: ConnectionKind): string {
  return CONNECTION_KINDS.find((k) => k.key === kind)?.label ?? kind;
}
