/** 云同步域类型与常量（对应方案 sync-gist-plan.md；算法移植自 Netcatty） */

import type {
  AppSettings,
  ConnectionProfile,
  RegistryProfile,
  SshIdentity,
  SshKeyEntry,
  ThemeMode,
  TerminalShell,
} from "./settings";

// ============================================================================
// 状态机
// ============================================================================

/** 安全状态：是否已设置同步密码 / 是否已解锁（密码只存内存） */
export type SecurityState = "NO_KEY" | "LOCKED" | "UNLOCKED";

/** 同步操作状态机 */
export type SyncState = "IDLE" | "SYNCING" | "CONFLICT" | "BLOCKED" | "ERROR";

/** 冲突解决策略 */
export type ConflictResolution = "USE_REMOTE" | "USE_LOCAL";

// ============================================================================
// 云端加密文件结构（Gist 内 dockpilot-vault.json 的内容）
// ============================================================================

/** 明文元数据（供版本比对与解密参数） */
export interface SyncFileMeta {
  /** 每次上传 = 远端版本 + 1 */
  version: number;
  /** Unix 毫秒 */
  updatedAt: number;
  deviceId: string;
  deviceName?: string;
  appVersion: string;
  /** AES-GCM 初始向量（Base64） */
  iv: string;
  /** KDF 盐（Base64） */
  salt: string;
  algorithm: "AES-256-GCM";
  kdf: "PBKDF2";
  kdfIterations: number;
}

/** Gist 文件完整结构 */
export interface SyncedFile {
  meta: SyncFileMeta;
  /** Base64(AES-GCM(JSON(SyncPayload))) */
  payload: string;
}

/** 同步的标量设置（设备本地字段不入内：active_connection_id、docker_socket） */
export interface SyncedScalarSettings {
  theme?: ThemeMode;
  containers_refresh_secs?: number;
  images_refresh_secs?: number;
  logs_default_tail?: number;
  logs_timestamps?: boolean;
  terminal_shell?: TerminalShell;
  notifications_enabled?: boolean;
  /** 云同步是否携带 SSH 凭证（默认开） */
  sync_credentials?: boolean;
}

/** 云同步携带的 SSH 凭证条目（明文；整体载荷由同步密码信封加密保护） */
export interface SshCredentialSync {
  /** 连接 id（password / key_passphrase）或钥匙串条目 id（keychain_*） */
  target_id: string;
  /** "password" | "key_passphrase" | "keychain_pem" | "keychain_passphrase" | "identity_password" */
  kind: string;
  value: string;
}

/** 解密后的同步载荷 */
export interface SyncPayload {
  connections: ConnectionProfile[];
  /** SSH 钥匙串条目元数据（材料经 ssh_credentials 同步） */
  ssh_keys?: SshKeyEntry[];
  /** SSH 身份元数据（密码经 ssh_credentials 同步） */
  ssh_identities?: SshIdentity[];
  /** 仅元数据；secret_backend 为设备本地字段，上传前归一化为空串 */
  registries: RegistryProfile[];
  settings?: SyncedScalarSettings;
  /** SSH 凭证（sync_credentials 开启时由本机 secret_store 导出；对端应用后写入其本机 secret_store） */
  ssh_credentials?: SshCredentialSync[];
  syncedAt: number;
}

// ============================================================================
// 锚点与护栏
// ============================================================================

/** 远端锚点：上次观察到的云端文件指纹（localStorage 持久化） */
export interface ProviderSyncAnchor {
  /** SHA-256(meta+密文) 的 Base64；远端文件不可读时为 null */
  signature: string | null;
  version: number;
  updatedAt: number;
  deviceId?: string;
  /** Gist ID */
  resourceId: string | null;
  observedAt: number;
}

export type SyncEntityType = "connections" | "registries";

export type ShrinkFinding =
  | { suspicious: false }
  | {
      suspicious: true;
      reason: "bulk-shrink" | "large-shrink";
      entityType: SyncEntityType;
      baseCount: number;
      outgoingCount: number;
      lost: number;
      /** base 缺失时以远端为参照 */
      viaRemote?: boolean;
    };

// ============================================================================
// 同步结果与冲突信息
// ============================================================================

export interface SyncResult {
  success: boolean;
  action: "upload" | "download" | "merge" | "none";
  version?: number;
  error?: string;
  /** 解密失败（两端密码不同），需要用户选择远端/本地 */
  conflictDetected?: boolean;
  /** 合并成功时返回应应用到本地的载荷 */
  mergedPayload?: SyncPayload;
  /** 被收缩护栏拦截 */
  shrinkBlocked?: boolean;
  finding?: ShrinkFinding;
}

export interface ConflictInfo {
  localVersion: number;
  localUpdatedAt: number;
  localDeviceName?: string;
  remoteVersion: number;
  remoteUpdatedAt: number;
  remoteDeviceName?: string;
  /** 解密成功时附带的远端载荷（供"使用远端"直接应用） */
  remotePayload?: SyncPayload;
}

// ============================================================================
// 主密钥（同步密码）
// ============================================================================

/** 持久化的主密钥配置（localStorage，不含密码） */
export interface MasterKeyConfig {
  /** Base64(SHA-256(派生密钥))，用于解锁校验 */
  verificationHash: string;
  /** Base64 KDF 盐 */
  salt: string;
  kdf: "PBKDF2";
  kdfIterations: number;
  createdAt: number;
}

/** 解锁后的密钥状态（仅内存） */
export interface UnlockedMasterKey {
  derivedKey: CryptoKey;
  salt: Uint8Array;
  unlockedAt: number;
}

// ============================================================================
// GitHub 认证与账号
// ============================================================================

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

export interface OAuthTokens {
  accessToken: string;
  tokenType: string;
  scope?: string;
}

export interface ProviderAccount {
  id: string;
  login?: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

// ============================================================================
// 本地同步配置（localStorage 持久化）
// ============================================================================

export interface SyncConfig {
  /** 自动同步开关 */
  autoSync: boolean;
  /** 已发现的同步 Gist ID */
  gistId: string | null;
  /** GitHub token 的实际落点（钥匙串/加密文件），由 Rust 侧返回 */
  tokenBackend: "keyring" | "file" | null;
  /** 记住的同步密码的实际落点（解锁后自动保存，锁定时清除） */
  passwordBackend: "keyring" | "file" | null;
  /** OAuth 账号信息（展示用） */
  account: ProviderAccount | null;
  /** 上次成功同步时间（含一致性检查；持久化，重启后展示不丢） */
  lastSyncAt: number | null;
  /** 上次同步达到的云端版本 */
  lastSyncVersion: number | null;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  autoSync: true,
  gistId: null,
  tokenBackend: null,
  passwordBackend: null,
  account: null,
  lastSyncAt: null,
  lastSyncVersion: null,
};

// ============================================================================
// 存储键与常量
// ============================================================================

export const SYNC_STORAGE_KEYS = {
  SYNC_CONFIG: "dockpilot.sync.config",
  MASTER_KEY_CONFIG: "dockpilot.sync.masterKeyConfig",
  BASE_PAYLOAD: "dockpilot.sync.base",
  ANCHOR: "dockpilot.sync.anchor",
  DEVICE: "dockpilot.sync.device",
} as const;

const readBuildEnv = (key: string): string => {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const value = env?.[key];
  return value && value.trim().length ? value : "";
};

export const SYNC_CONSTANTS = {
  // 加密
  AES_KEY_LENGTH: 256,
  GCM_IV_LENGTH: 12,
  GCM_TAG_LENGTH: 128,
  SALT_LENGTH: 32,

  // PBKDF2（OWASP 推荐下限）
  PBKDF2_ITERATIONS: 600000,
  PBKDF2_HASH: "SHA-256",

  // Gist
  SYNC_FILE_NAME: "dockpilot-vault.json",
  GIST_DESCRIPTION: "DockPilot Encrypted Vault (DO NOT EDIT MANUALLY)",

  // GitHub
  GITHUB_CLIENT_ID: readBuildEnv("VITE_SYNC_GITHUB_CLIENT_ID"),
  GITHUB_API_BASE: "https://api.github.com",
  GITHUB_DEVICE_URL: "https://github.com/login/device",

  // 设备本地字段不参与同步
  SYNC_DEVICE_NAME_PREFIX: "DockPilot",
} as const;

// ============================================================================
// 辅助函数
// ============================================================================

export const generateDeviceId = (): string => crypto.randomUUID();

export const getDefaultDeviceName = (): string => {
  const platform = navigator.platform || "Unknown";
  return `${SYNC_CONSTANTS.SYNC_DEVICE_NAME_PREFIX} (${platform})`;
};

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
}

/** 读取或初始化设备标识 */
export const loadDeviceInfo = (): DeviceInfo => {
  try {
    const raw = localStorage.getItem(SYNC_STORAGE_KEYS.DEVICE);
    if (raw) {
      const parsed = JSON.parse(raw) as DeviceInfo;
      if (parsed.deviceId && parsed.deviceName) return parsed;
    }
  } catch {
    // 损坏则重建
  }
  const info: DeviceInfo = { deviceId: generateDeviceId(), deviceName: getDefaultDeviceName() };
  try {
    localStorage.setItem(SYNC_STORAGE_KEYS.DEVICE, JSON.stringify(info));
  } catch {
    // localStorage 不可用时每次会话内重建
  }
  return info;
};

/** 格式化同步时间：一分钟内"刚刚"，一小时内"N 分钟前"，否则 yyyyMMdd HHmm */
export const formatLastSync = (timestamp?: number | null): string => {
  if (!timestamp) return "从未同步";
  const diff = Date.now() - timestamp;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
};

/** 判断载荷是否有实质数据（空库保护用） */
export const hasSyncPayloadEntityData = (payload: SyncPayload): boolean =>
  payload.connections.length > 0 || payload.registries.length > 0;

/** 设置载荷中出现的标量设置键（合并与收缩统计用） */
export const SYNC_SCALAR_SETTING_KEYS = [
  "theme",
  "containers_refresh_secs",
  "images_refresh_secs",
  "logs_default_tail",
  "logs_timestamps",
  "terminal_shell",
  "notifications_enabled",
  "sync_credentials",
] as const satisfies readonly (keyof SyncedScalarSettings)[];

export type SyncScalarSettingKey = (typeof SYNC_SCALAR_SETTING_KEYS)[number];

/** 从 AppSettings 提取参与同步的标量设置 */
export const pickSyncedSettings = (s: AppSettings): SyncedScalarSettings => ({
  theme: s.theme,
  containers_refresh_secs: s.containers_refresh_secs,
  images_refresh_secs: s.images_refresh_secs,
  logs_default_tail: s.logs_default_tail,
  logs_timestamps: s.logs_timestamps,
  terminal_shell: s.terminal_shell,
  notifications_enabled: s.notifications_enabled,
  sync_credentials: s.sync_credentials,
});
