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
  /** ssh: 跳板机地址（user@host[:port]，空 = 直连，经 ProxyJump 中转） */
  jump_host: string;
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
  /** 容器异常（非零退出/OOM/健康检查失败）时发送系统通知 */
  notifications_enabled: boolean;
  /** 镜像仓库凭据列表（密码不在此处，由系统钥匙串/加密文件保存） */
  registries: RegistryProfile[];
}

/** 镜像仓库类型（决定域名预设与提示文案） */
export type RegistryKind = "aliyun" | "harbor" | "generic";

/** 与后端 RegistryProfile 对应；密码等敏感信息不在此结构中 */
export interface RegistryProfile {
  id: string;
  name: string;
  kind: RegistryKind;
  /** registry 地址：域名[:端口]，无 scheme（如 registry.cn-hangzhou.aliyuncs.com） */
  registry: string;
  username: string;
  /** 密钥实际存储位置："keyring"（系统钥匙串）| "file"（机器绑定加密文件） */
  secret_backend: string;
  /** 测试连接时跳过 TLS 证书校验（自签名证书用） */
  skip_tls_verify: boolean;
  /** 创建时间（unix 秒） */
  created_at: number;
}

/** 新建/编辑凭据的提交规格；password 为空串表示"不修改密码" */
export interface RegistrySpec {
  id?: string | null;
  name: string;
  kind: RegistryKind;
  registry: string;
  username: string;
  password: string;
  skip_tls_verify: boolean;
}

/** 后端 test_registry 返回 */
export interface RegistryTestResult {
  ok: boolean;
  latency_ms: number;
  error: string | null;
  /** 经 HTTP 访问成功：推送前需在 daemon.json 配置 insecure-registries */
  via_http: boolean;
}

/** 仓库类型的中文标签 */
export const REGISTRY_KINDS: { key: RegistryKind; label: string }[] = [
  { key: "aliyun", label: "阿里云 ACR" },
  { key: "harbor", label: "Harbor" },
  { key: "generic", label: "通用仓库" },
];

export function registryKindLabel(kind: RegistryKind): string {
  return REGISTRY_KINDS.find((k) => k.key === kind)?.label ?? kind;
}

/** 密钥存储方式的展示文案 */
export function secretBackendLabel(backend: string): string {
  switch (backend) {
    case "keyring":
      return "系统钥匙串";
    case "file":
      return "加密文件";
    default:
      return backend;
  }
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
