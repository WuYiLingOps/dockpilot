/** 与 src-tauri/src/settings.rs 的 AppSettings 对应 */
import { t } from "../lib/i18n";
export type ThemeMode = "system" | "light" | "dark";
/** 界面语言：system 跟随系统（按 navigator.language 解析），zh 简体中文，en 英文 */
export type UiLanguage = "system" | "zh" | "en";
export type TerminalShell = "bash" | "sh" | "ash";
export type ConnectionKind = "local" | "tcp" | "tls" | "ssh";
export type CloseAction = "ask" | "minimize" | "exit";
/** ssh 认证方式：key = 私钥/agent（默认）；password = 密码（存系统钥匙串/加密文件） */
export type ConnectionAuth = "key" | "password";

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
  /** ssh: 可选私钥路径（文件型凭证；key_id 非空时不用） */
  key_path: string;
  /** ssh: SSH 钥匙串私钥条目 id（空 = 不用钥匙串；随云同步跨设备可用） */
  key_id: string;
  /** ssh: SSH 身份条目 id（空 = 不用身份；非空时用户名与认证由身份决定） */
  identity_id: string;
  /** ssh: 远程 docker socket 路径（空 = /var/run/docker.sock） */
  remote_socket: string;
  /** ssh: 认证方式（空 = key）；连接一律由内置 russh 引擎承载 */
  auth: ConnectionAuth | "";
  /** ssh: 密码/私钥口令实际存储位置（"keyring" | "file"，空 = 未保存过） */
  secret_backend: string;
}

/** 后端 test_connection 返回 */
export interface ConnectionTestResult {
  ok: boolean;
  latency_ms: number | null;
  version: string;
  error: string;
}

/** SSH 钥匙串条目（与后端 SshKeyEntry 对应；PEM/口令存本机密钥库，此处仅元数据） */
export interface SshKeyEntry {
  id: string;
  label: string;
  /** 公钥指纹（OpenSSH SHA256:xxx，导入时计算；旧迁移条目可为空） */
  fingerprint: string;
  /** OpenSSH 公钥全文（导入时由 PEM 推导，可复制到服务器 authorized_keys） */
  public_key: string;
  /** 创建时间（unix 秒） */
  created_at: number;
}

/** SSH 身份（与后端 SshIdentity 对应；密码存本机密钥库，此处仅元数据） */
export interface SshIdentity {
  id: string;
  label: string;
  username: string;
  /** 可选关联的钥匙串私钥条目 id（空 = 密码认证） */
  key_id: string;
  /** 创建时间（unix 秒） */
  created_at: number;
}

export interface AppSettings {
  theme: ThemeMode;
  /** 界面语言（不参与云同步：语言偏好与设备环境相关，保持设备独立） */
  language: UiLanguage;
  docker_socket: string;
  connections: ConnectionProfile[];
  /** SSH 钥匙串：跨连接复用的导入式私钥条目（材料在本机密钥库） */
  ssh_keys: SshKeyEntry[];
  /** SSH 身份：跨连接复用的登录身份（密码在本机密钥库） */
  ssh_identities: SshIdentity[];
  active_connection_id: string;
  containers_refresh_secs: number;
  images_refresh_secs: number;
  logs_default_tail: number;
  logs_timestamps: boolean;
  terminal_shell: TerminalShell;
  /** 终端字号（px，重开终端会话后生效） */
  terminal_font_size: number;
  /** 终端回滚行数（重开终端会话后生效） */
  terminal_scrollback: number;
  /** 容器异常（非零退出/OOM/健康检查失败）时发送系统通知 */
  notifications_enabled: boolean;
  /** 启动时自动检查更新（仅提醒，不自动下载；手动「检查更新」不受此开关限制） */
  auto_check_updates: boolean;
  /** 云同步携带 SSH 凭证（登录密码/口令/钥匙串私钥；明文进同步载荷，由同步密码信封加密） */
  sync_credentials: boolean;
  /** 关闭窗口行为：ask 每次关闭时弹窗询问（默认）；minimize 最小化到托盘；exit 完全退出 */
  close_action: CloseAction;
  /** 调试日志：开启后应用运行日志降为 Debug 级别（立即生效），供故障排查 */
  debug_logging: boolean;
  /** 使用日志保留天数（0 = 永久保留；历史会话日志超期后自动清理） */
  log_retention_days: number;
  /** 镜像仓库凭据列表（密码不在此处，由系统钥匙串/加密文件保存） */
  registries: RegistryProfile[];
  /** 编排跟踪记录（未运行的 compose 项目仍可见，按连接绑定，不参与云同步） */
  compose_projects: TrackedComposeProject[];
  /** 编排扫描目录（按连接绑定） */
  compose_scan_dirs: ComposeScanDir[];
}

/** 编排跟踪记录（与后端 TrackedComposeProject 对应） */
export interface TrackedComposeProject {
  id: string;
  connection_id: string;
  /** compose 项目名（重建 CLI 命令时的 -p 参数值） */
  name: string;
  working_dir: string;
  config_files: string[];
  /** remembered = 容器标签自动记忆；registered = 手动添加；scanned = 目录扫描发现 */
  source: "remembered" | "registered" | "scanned";
  added_at: number;
}

/** 编排扫描目录 */
export interface ComposeScanDir {
  id: string;
  connection_id: string;
  path: string;
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

/** 仓库类型（标签文案经 registryKindLabel 取当前语言） */
export const REGISTRY_KINDS: { key: RegistryKind; label: string }[] = [
  { key: "aliyun", label: "registryKindLabel:aliyun" },
  { key: "harbor", label: "registryKindLabel:harbor" },
  { key: "generic", label: "registryKindLabel:generic" },
];

export function registryKindLabel(kind: RegistryKind): string {
  switch (kind) {
    case "aliyun":
      return t("push.kindAliyun");
    case "harbor":
      return t("push.kindHarbor");
    case "generic":
      return t("push.kindGeneric");
    default:
      return kind;
  }
}

/** 密钥存储方式的展示文案 */
export function secretBackendLabel(backend: string): string {
  switch (backend) {
    case "keyring":
      return t("reg.backendKeyring");
    case "file":
      return t("reg.backendFile");
    default:
      return backend;
  }
}

/** 连接类型（标签文案经 connectionKindLabel 取当前语言） */
export const CONNECTION_KINDS: { key: ConnectionKind; label: string }[] = [
  { key: "local", label: "connectionKindLabel:local" },
  { key: "ssh", label: "SSH" },
  { key: "tls", label: "TLS" },
  { key: "tcp", label: "TCP" },
];

export function connectionKindLabel(kind: ConnectionKind): string {
  if (kind === "local") return t("conn.defaultLocal");
  return CONNECTION_KINDS.find((k) => k.key === kind)?.label ?? kind;
}

/** ssh 认证方式（标签文案经 connectionAuthLabel 取当前语言） */
export const CONNECTION_AUTHS: { key: ConnectionAuth; label: string }[] = [
  { key: "key", label: "connectionAuthLabel:key" },
  { key: "password", label: "connectionAuthLabel:password" },
];

export function connectionAuthLabel(auth: string): string {
  return auth === "password" ? t("reg.authPassword") : t("reg.authKey");
}
