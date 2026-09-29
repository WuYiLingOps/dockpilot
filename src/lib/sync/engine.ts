/**
 * 同步引擎：状态机 + 锚点 + 三道护栏（移植自 Netcatty CloudSyncManager /
 * providerSyncMethods，裁剪到单 provider GitHub Gist）。
 *
 * 单次同步流程（syncNow）：
 *   下载远端 → 签名对比锚点
 *   ├─ 远端未变 & 本地载荷哈希未变 → no-op
 *   ├─ 远端未变 & 本地有改动 → 上传（version = 远端+1，过收缩护栏）
 *   └─ 远端已变（另一台设备推过）→ 解密远端 → 三方合并(base, local, remote)
 *       ├─ 合并成功 → 上传合并结果 → 应用到本地 → 写 base → 写锚点
 *       └─ 解密失败（密码不同）→ CONFLICT，由 UI 选择远端/本地
 *
 * 写入顺序（防崩溃，照抄 Netcatty）：先写 base，再写锚点。崩溃在中间 →
 * 锚点缺失/过期强制下次重查远端走合并，不会静默覆盖。
 *
 * 护栏：
 *   1. 收缩检测（guards.ts）→ BLOCKED，UI 提供"恢复远端 / 强制推送"
 *   2. 空库保护：无 base + 本地空 + 远端非空 → 挂起等待用户确认，绝不静默覆盖
 *   3. 启动门闩：startupChecked 为 false 之前自动同步不触发（hook 负责）
 *
 * 密码与 token 只存内存；localStorage 仅存配置/verificationHash/base/锚点。
 */

import { getAppVersion } from "../platform";
import { applog } from "../applog";
import type { AppSettings } from "../../types/settings";
import type {
  ConflictInfo,
  DeviceFlowStart,
  MasterKeyConfig,
  ProviderSyncAnchor,
  SecurityState,
  ShrinkFinding,
  SyncConfig,
  SyncPayload,
  SyncResult,
  SyncState,
  SyncedFile,
} from "../../types/sync";
import { DEFAULT_SYNC_CONFIG, SYNC_STORAGE_KEYS, loadDeviceInfo } from "../../types/sync";
import {
  changeMasterPassword,
  createMasterKeyConfig,
  decryptPayload,
  encryptPayload,
  verifyPassword,
} from "./encryption";
import { mergeSyncPayloads } from "./merge";
import { detectSuspiciousShrink } from "./guards";
import { createSyncedFileSignature, decideRemoteChanged } from "./anchor";
import { payloadFingerprint, toSyncPayload } from "./payload";
import * as gist from "./gist";
import * as auth from "./auth";
import type { TokenBackend } from "./auth";

export type { TokenBackend };

/** 空库保护等待用户决策时的挂起信息 */
export interface EmptyVaultPending {
  payload: SyncPayload;
  remoteFile: SyncedFile;
}

export interface CloudSyncState {
  securityState: SecurityState;
  syncState: SyncState;
  /** 同步操作进行中 */
  syncing: boolean;
  /** GitHub token 已加载（可同步） */
  connected: boolean;
  account: SyncConfig["account"];
  autoSync: boolean;
  tokenBackend: TokenBackend | null;
  gistId: string | null;
  lastSyncAt: number | null;
  lastSyncVersion: number | null;
  remoteVersion: number | null;
  lastError: string | null;
  conflict: ConflictInfo | null;
  shrinkFinding: Extract<ShrinkFinding, { suspicious: true }> | null;
  emptyVaultPending: EmptyVaultPending | null;
  /** 启动远端检查已完成（自动同步的门闩） */
  startupChecked: boolean;
}

const initialState: CloudSyncState = {
  securityState: "NO_KEY",
  syncState: "IDLE",
  syncing: false,
  connected: false,
  account: null,
  autoSync: true,
  tokenBackend: null,
  gistId: null,
  lastSyncAt: null,
  lastSyncVersion: null,
  remoteVersion: null,
  lastError: null,
  conflict: null,
  shrinkFinding: null,
  emptyVaultPending: null,
  startupChecked: false,
};

// ---------------------------------------------------------------------------
// localStorage 基础
// ---------------------------------------------------------------------------

function loadJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // WebView 存储不可用：同步退化为单次会话行为，不崩溃
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

const loadConfig = (): SyncConfig => ({ ...DEFAULT_SYNC_CONFIG, ...(loadJSON<SyncConfig>(SYNC_STORAGE_KEYS.SYNC_CONFIG) ?? {}) });
const saveConfig = (config: SyncConfig) => saveJSON(SYNC_STORAGE_KEYS.SYNC_CONFIG, config);

const loadMasterKeyConfig = (): MasterKeyConfig | null => loadJSON<MasterKeyConfig>(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG);
const saveMasterKeyConfig = (config: MasterKeyConfig) => saveJSON(SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG, config);

const loadBase = (): SyncPayload | null => loadJSON<SyncPayload>(SYNC_STORAGE_KEYS.BASE_PAYLOAD);
const saveBase = (payload: SyncPayload) => saveJSON(SYNC_STORAGE_KEYS.BASE_PAYLOAD, payload);

const loadAnchor = (): ProviderSyncAnchor | null => loadJSON<ProviderSyncAnchor>(SYNC_STORAGE_KEYS.ANCHOR);

async function saveAnchor(file: SyncedFile, resourceId: string | null): Promise<void> {
  const signature = await createSyncedFileSignature(file);
  saveJSON(SYNC_STORAGE_KEYS.ANCHOR, {
    signature,
    version: file.meta.version,
    updatedAt: file.meta.updatedAt,
    deviceId: file.meta.deviceId,
    resourceId,
    observedAt: Date.now(),
  } satisfies ProviderSyncAnchor);
}

// ---------------------------------------------------------------------------
// 引擎状态（模块级单例；快照引用仅在 notify 时更新，供 useSyncExternalStore）
// ---------------------------------------------------------------------------

const device = loadDeviceInfo();
const state: CloudSyncState = { ...initialState };

let snapshot: Readonly<CloudSyncState> = { ...state };
const listeners = new Set<() => void>();

/** 同步密码（仅内存） */
let masterPassword: string | null = null;
/** GitHub token（仅内存，从钥匙串加载） */
let accessToken: string | null = null;
/** 应用版本（meta 用） */
let appVersion = "0.0.0";
/** 防并发同步 */
let syncSeq = 0;
/** 合并应用后的跳过哈希：防止 React 状态回填触发冗余同步 */
let skipHash: string | null = null;
/** CONFLICT / BLOCKED 状态下挂起的远端加密文件（恢复远端用） */
let conflictRemoteFile: SyncedFile | null = null;
let blockedRemoteFile: SyncedFile | null = null;

export function getState(): Readonly<CloudSyncState> {
  return snapshot;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  Object.assign(state, {
    securityState: masterKeyConfigExists() ? (masterPassword ? "UNLOCKED" : "LOCKED") : "NO_KEY",
  });
  snapshot = { ...state };
  for (const listener of listeners) listener();
}

function masterKeyConfigExists(): boolean {
  return loadMasterKeyConfig() !== null;
}

function setError(error: string | null): void {
  state.lastError = error;
  notify();
}

/** 标记载荷指纹：随后一次同指纹的自动同步触发将被跳过 */
export function markSkipHash(payload: SyncPayload): void {
  skipHash = payloadFingerprint(payload);
}

/** 判断当前载荷是否就是刚被合并应用回填的内容（应跳过本轮同步） */
export function isPayloadSkipped(payload: SyncPayload): boolean {
  if (skipHash === null) return false;
  if (payloadFingerprint(payload) === skipHash) return true;
  // 指纹不同说明用户又改了东西，跳过标记作废
  skipHash = null;
  return false;
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

/** 应用启动时调用一次：加载配置 / token / 密码配置，不发起网络请求 */
export async function initialize(): Promise<void> {
  appVersion = await getAppVersion();
  const config = loadConfig();
  state.autoSync = config.autoSync;
  state.gistId = config.gistId;
  state.tokenBackend = config.tokenBackend;
  state.account = config.account;
  state.lastSyncAt = config.lastSyncAt;
  state.lastSyncVersion = config.lastSyncVersion;
  if (config.tokenBackend) {
    try {
      accessToken = await auth.loadToken(config.tokenBackend);
    } catch {
      accessToken = null;
    }
  }
  state.connected = accessToken !== null;
  // 自动解锁：记住的同步密码（钥匙串/加密文件）直接恢复，免去每次启动手动解锁；
  // 校验失败（云端密码配置已变）时清除失效记忆，回到锁定态
  if (state.connected && masterKeyConfigExists() && config.passwordBackend) {
    try {
      const stored = await auth.loadSyncPassword(config.passwordBackend);
      if (stored) {
        const ok = await unlock(stored);
        if (!ok) await forgetStoredPassword(config.passwordBackend);
      }
    } catch {
      // 密钥库不可用：保持锁定，不阻塞启动
    }
  }
  notify();
}

/** 把最近同步时间/版本写入本地配置（重启后展示不丢） */
function persistSyncState(): void {
  saveConfig({
    ...loadConfig(),
    lastSyncAt: state.lastSyncAt,
    lastSyncVersion: state.lastSyncVersion,
  });
}

/** 启动远端检查完成（成功/冲突/阻塞/退避耗尽）：解除自动同步门闩 */
export function markStartupChecked(): void {
  if (!state.startupChecked) {
    state.startupChecked = true;
    notify();
  }
}

// ---------------------------------------------------------------------------
// GitHub 连接管理
// ---------------------------------------------------------------------------

export const startDeviceFlow = auth.startDeviceFlow;

/**
 * 完成 Device Flow：轮询 token → 存钥匙串 → 拉账号 → 发现/记录 Gist。
 * onUserCode 由 UI 展示；返回的 promise 在授权完成后 resolve。
 */
export async function completeGitHubAuth(
  start: DeviceFlowStart,
  events: auth.DeviceFlowPollEvents = {},
  signal?: AbortSignal,
): Promise<void> {
  setError(null);
  const tokens = await auth.pollForToken(start, events, signal);
  const backend = await auth.saveToken(tokens.accessToken);
  accessToken = tokens.accessToken;

  let account: SyncConfig["account"] = null;
  try {
    account = await auth.getUserInfo(tokens.accessToken);
  } catch {
    // 账号信息拉取失败不阻断连接
  }

  const gistId = await gist.findSyncGist(tokens.accessToken);
  const config: SyncConfig = { ...loadConfig(), gistId, tokenBackend: backend, account };
  saveConfig(config);

  state.gistId = gistId;
  state.tokenBackend = backend;
  state.account = account;
  state.connected = true;
  notify();
}

/** 断开 GitHub：删除 token、清空合并状态（base/锚点/Gist ID），保留同步密码 */
export async function disconnectGitHub(): Promise<void> {
  const backend = state.tokenBackend;
  if (backend) {
    await auth.deleteToken(backend).catch(() => {});
  }
  accessToken = null;
  const config = loadConfig();
  const next: SyncConfig = {
    ...config,
    gistId: null,
    tokenBackend: null,
    account: null,
    lastSyncAt: null,
    lastSyncVersion: null,
  };
  saveConfig(next);
  // 清空合并状态：换账号/资源后旧 base 与锚点不可复用
  removeKey(SYNC_STORAGE_KEYS.BASE_PAYLOAD);
  removeKey(SYNC_STORAGE_KEYS.ANCHOR);
  state.gistId = null;
  state.tokenBackend = null;
  state.account = null;
  state.connected = false;
  state.lastSyncAt = null;
  state.lastSyncVersion = null;
  state.remoteVersion = null;
  state.startupChecked = false;
  if (state.syncState === "BLOCKED" || state.syncState === "CONFLICT" || state.syncState === "ERROR") {
    state.syncState = "IDLE";
    state.shrinkFinding = null;
    state.conflict = null;
    conflictRemoteFile = null;
    blockedRemoteFile = null;
  }
  notify();
}

// ---------------------------------------------------------------------------
// 同步密码管理
// ---------------------------------------------------------------------------

/** 首次设置同步密码 */
export async function setMasterPassword(password: string): Promise<void> {
  const config = await createMasterKeyConfig(password);
  saveMasterKeyConfig(config);
  masterPassword = password;
  await rememberPassword(password);
  notify();
}

/** 解锁：校验密码正确后仅在内存持有 */
export async function unlock(password: string): Promise<boolean> {
  const config = loadMasterKeyConfig();
  if (!config) return false;
  const ok = await verifyPassword(password, config);
  if (ok) {
    masterPassword = password;
    notify();
  }
  return ok;
}

/** 解锁并记住密码到本机密钥库（下次启动自动解锁）；记住失败不影响本次解锁 */
export async function unlockAndRemember(password: string): Promise<boolean> {
  const ok = await unlock(password);
  if (ok) await rememberPassword(password);
  return ok;
}

async function rememberPassword(password: string): Promise<void> {
  try {
    const backend = await auth.saveSyncPassword(password);
    saveConfig({ ...loadConfig(), passwordBackend: backend });
  } catch {
    // 密钥库不可用（无钥匙串且加密文件失败）：仅本次内存持有
  }
}

/** 清除本机记住的同步密码（backend 缺省取当前记录的落点） */
async function forgetStoredPassword(backend?: auth.TokenBackend): Promise<void> {
  const target = backend ?? loadConfig().passwordBackend;
  if (!target) return;
  try {
    await auth.deleteSyncPassword(target);
  } catch {
    // 条目不存在 / 密钥库不可用：视为已清除
  }
  saveConfig({ ...loadConfig(), passwordBackend: null });
}

export function lock(): void {
  masterPassword = null;
  // 锁定即忘记：记住的同步密码一并清除，下次启动回到锁定态
  void forgetStoredPassword();
  notify();
}

export function isUnlocked(): boolean {
  return masterPassword !== null;
}

/** 修改同步密码（下次同步将以新密码整体重传） */
export async function changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
  const config = loadMasterKeyConfig();
  if (!config) return false;
  const next = await changeMasterPassword(oldPassword, newPassword, config);
  if (!next) return false;
  saveMasterKeyConfig(next);
  masterPassword = newPassword;
  // 同步更新记住的密码，避免下次启动自动解锁失败
  await rememberPassword(newPassword);
  notify();
  return true;
}

/** 校验一段云端文件是否可用当前密码解密（换设备首次使用提示用） */
export async function canDecrypt(file: SyncedFile): Promise<boolean> {
  if (!masterPassword) return false;
  try {
    await decryptPayload(file, masterPassword);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 自动同步开关
// ---------------------------------------------------------------------------

export function setAutoSync(enabled: boolean): void {
  state.autoSync = enabled;
  saveConfig({ ...loadConfig(), autoSync: enabled });
  notify();
}

// ---------------------------------------------------------------------------
// 上传与提交
// ---------------------------------------------------------------------------

interface UploadOpts {
  overrideShrink?: boolean;
  base: SyncPayload | null;
  baseVersion: number;
}

/** 加密并上传本地载荷；过收缩护栏；成功后先写 base 再写锚点 */
async function uploadPayload(payload: SyncPayload, opts: UploadOpts): Promise<SyncResult> {
  if (!masterPassword) {
    return { success: false, action: "none", error: "同步密码未解锁" };
  }

  const shrink = detectSuspiciousShrink(payload, opts.base, null);
  if (shrink.suspicious && !opts.overrideShrink) {
    state.syncState = "BLOCKED";
    state.shrinkFinding = shrink;
    notify();
    return { success: false, action: "none", shrinkBlocked: true, finding: shrink };
  }

  const encrypted = await encryptPayload(payload, masterPassword, device.deviceId, device.deviceName, appVersion, opts.baseVersion);
  let resourceId = state.gistId;
  if (resourceId) {
    await gist.updateSyncGist(accessToken!, resourceId, encrypted);
  } else {
    resourceId = await gist.createSyncGist(accessToken!, encrypted);
    state.gistId = resourceId;
    saveConfig({ ...loadConfig(), gistId: resourceId });
  }

  commitSyncedPayload(payload, encrypted, resourceId);
  return { success: true, action: "upload", version: encrypted.meta.version };
}

/** 上传成功后的本地提交：lastSync 更新 → 先写 base → 再写锚点（顺序不可换） */
function commitSyncedPayload(payload: SyncPayload, file: SyncedFile, resourceId: string): void {
  state.lastSyncAt = Date.now();
  state.lastSyncVersion = file.meta.version;
  state.remoteVersion = file.meta.version;
  persistSyncState();
  saveBase(payload);
  void saveAnchor(file, resourceId);
}

/** 采用远端（内容一致或合并后与远端相同）：不回传云端，本地对齐并提交状态 */
async function adoptRemote(remotePayload: SyncPayload, remoteFile: SyncedFile, resourceId: string, applyLocal: (p: SyncPayload) => Promise<void>): Promise<void> {
  await applyLocal(remotePayload);
  markSkipHash(remotePayload);
  state.lastSyncAt = Date.now();
  state.lastSyncVersion = remoteFile.meta.version;
  state.remoteVersion = remoteFile.meta.version;
  persistSyncState();
  saveBase(remotePayload);
  await saveAnchor(remoteFile, resourceId);
}

// ---------------------------------------------------------------------------
// 单次同步
// ---------------------------------------------------------------------------

export interface SyncOptions {
  reason: "startup" | "auto" | "manual";
  /** 强制推送（跳过收缩护栏与合并） */
  overrideShrink?: boolean;
  /** 确认空库合并（本地空 + 远端非空 + 无 base 时需用户确认） */
  confirmedEmptyVault?: boolean;
  /** 将载荷应用到本机设置（由 hook 提供，走 set_settings 持久化） */
  applyLocal: (payload: SyncPayload) => Promise<void>;
}

export async function syncNow(settings: AppSettings, opts: SyncOptions): Promise<SyncResult> {
  if (!accessToken) {
    return { success: false, action: "none", error: "未连接 GitHub" };
  }
  if (!masterPassword) {
    return { success: false, action: "none", error: "同步密码未解锁" };
  }
  if (state.syncing) {
    return { success: false, action: "none", error: "同步正在进行中" };
  }

  const seq = ++syncSeq;
  state.syncing = true;
  state.syncState = "SYNCING";
  state.lastError = null;
  notify();

  try {
    const result = await runSync(settings, opts, seq);
    logSyncOutcome(opts.reason, result);
    return result;
  } catch (error) {
    if (seq !== syncSeq) {
      return { success: false, action: "none", error: String(error) };
    }
    const message = error instanceof Error ? error.message : String(error);
    state.syncing = false;
    state.syncState = "ERROR";
    state.lastError = message;
    notify();
    applog.error(`云同步异常（${opts.reason}）：${message}`);
    return { success: false, action: "none", error: message };
  }
}

const SYNC_ACTION_LABEL: Record<SyncResult["action"], string> = {
  upload: "已上传本地数据",
  download: "已拉取云端数据",
  merge: "已合并云端数据",
  none: "云端与本地一致",
};

/** 同步结果写入应用日志：成功 Info / 失败 Error / 需用户决策（冲突、护栏、空库确认）Warn */
function logSyncOutcome(reason: SyncOptions["reason"], r: SyncResult): void {
  if (r.success) {
    applog.info(
      `云同步完成（${reason}）：${SYNC_ACTION_LABEL[r.action]}${r.version != null ? `（v${r.version}）` : ""}`,
    );
    return;
  }
  if (!r.error) return;
  if (r.conflictDetected || r.shrinkBlocked || r.error === "empty-vault-guard") {
    applog.warn(`云同步暂停（${reason}）：${r.error}`);
  } else {
    applog.error(`云同步失败（${reason}）：${r.error}`);
  }
}

async function runSync(settings: AppSettings, opts: SyncOptions, seq: number): Promise<SyncResult> {
  const assertCurrent = () => {
    if (seq !== syncSeq) throw new Error("同步已被更新的操作取代");
  };

  // 1. 确保 Gist 可用
  let resourceId = state.gistId;
  if (!resourceId) {
    resourceId = await gist.findSyncGist(accessToken!);
    if (resourceId) {
      state.gistId = resourceId;
      saveConfig({ ...loadConfig(), gistId: resourceId });
    }
  }
  assertCurrent();

  // 2. 下载远端 + 锚点决策
  const remoteFile = resourceId ? await gist.downloadSyncGist(accessToken!, resourceId) : null;
  if (resourceId && !remoteFile) {
    // Gist 在云端被删除：清空记录，后续上传重建
    state.gistId = null;
    saveConfig({ ...loadConfig(), gistId: null });
    resourceId = null;
  }
  assertCurrent();

  const signature = await createSyncedFileSignature(remoteFile);
  const anchor = loadAnchor();
  const decision = decideRemoteChanged({
    currentSignature: signature,
    currentResourceId: resourceId,
    anchor,
    hasRemoteFile: remoteFile !== null,
  });

  const localPayload = toSyncPayload(settings);
  const base = loadBase();

  const finish = (result: SyncResult): SyncResult => {
    state.syncing = false;
    if (result.success) {
      state.syncState = "IDLE";
      state.shrinkFinding = null;
    }
    notify();
    return result;
  };

  // 3a. 远端未变化
  if (remoteFile && !decision.remoteChanged) {
    if (!opts.overrideShrink && payloadFingerprint(localPayload) === payloadFingerprint(base)) {
      // 双端一致 → no-op（补写可能缺失的锚点，防御 WebView 数据被清）。
      // 一致性检查成功也算一次"同步"：刷新并持久化时间，重启后展示不丢
      if (!anchor) await saveAnchor(remoteFile, resourceId!);
      state.lastSyncAt = Date.now();
      state.lastSyncVersion = remoteFile.meta.version;
      state.remoteVersion = remoteFile.meta.version;
      persistSyncState();
      return finish({ success: true, action: "none", version: remoteFile.meta.version });
    }
    const result = await uploadPayload(localPayload, {
      overrideShrink: opts.overrideShrink,
      base,
      baseVersion: remoteFile.meta.version,
    });
    return finish(result);
  }

  // 3b. 远端无文件（首次或被删除）→ 直接上传本地
  if (!remoteFile) {
    if (!hasLocalData(localPayload)) {
      return finish({ success: true, action: "none" });
    }
    const result = await uploadPayload(localPayload, {
      overrideShrink: opts.overrideShrink,
      base,
      baseVersion: anchor?.version ?? 0,
    });
    return finish(result);
  }

  // 3c. 远端已变化 → 解密 → 合并
  let remotePayload: SyncPayload;
  try {
    remotePayload = await decryptPayload(remoteFile, masterPassword!);
  } catch (decryptError) {
    // 密码不同（或多设备密码不一致）→ 冲突 UI；meta 缺失等畸形文件也在此兜底
    conflictRemoteFile = remoteFile;
    state.syncing = false;
    state.syncState = "CONFLICT";
    state.conflict = {
      localVersion: anchor?.version ?? 0,
      localUpdatedAt: anchor?.updatedAt ?? 0,
      localDeviceName: device.deviceName,
      remoteVersion: remoteFile.meta?.version ?? 0,
      remoteUpdatedAt: remoteFile.meta?.updatedAt ?? 0,
      remoteDeviceName: remoteFile.meta?.deviceName,
    };
    notify();
    return {
      success: false,
      action: "none",
      conflictDetected: true,
      error: `解密失败（同步密码可能不同）: ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`,
    };
  }
  assertCurrent();

  // 内容一致：仅采纳远端身份（锚点/base），不上传
  if (payloadFingerprint(remotePayload) === payloadFingerprint(localPayload)) {
    await adoptRemote(remotePayload, remoteFile, resourceId!, opts.applyLocal);
    return finish({ success: true, action: "none", version: remoteFile.meta.version });
  }

  // 空库保护：无 base + 本地无实体数据 + 远端有数据 → 等待用户确认
  if (
    base === null &&
    localPayload.connections.length === 0 &&
    !opts.confirmedEmptyVault &&
    (remotePayload.connections.length > 0 || remotePayload.registries.length > 0)
  ) {
    state.syncing = false;
    state.syncState = "IDLE";
    state.emptyVaultPending = { payload: remotePayload, remoteFile };
    notify();
    return { success: false, action: "none", error: "empty-vault-guard" };
  }

  // 三方合并
  const merged = mergeSyncPayloads(base, localPayload, remotePayload);
  const mergedPayload = merged.payload;

  // 收缩护栏：合并结果比 base 少太多 → BLOCKED
  const mergedShrink = detectSuspiciousShrink(mergedPayload, base, remotePayload);
  if (mergedShrink.suspicious && !opts.overrideShrink) {
    blockedRemoteFile = remoteFile;
    state.syncing = false;
    state.syncState = "BLOCKED";
    state.shrinkFinding = mergedShrink;
    notify();
    return { success: false, action: "none", shrinkBlocked: true, finding: mergedShrink };
  }

  // 合并结果与远端一致（本地无独有贡献）→ 采纳远端，不浪费一次上传
  if (payloadFingerprint(mergedPayload) === payloadFingerprint(remotePayload)) {
    await adoptRemote(mergedPayload, remoteFile, resourceId!, opts.applyLocal);
    return finish({ success: true, action: "download", version: remoteFile.meta.version, mergedPayload });
  }

  // 上传合并结果（version = 远端 + 1），应用本地，提交 base/锚点
  const encrypted = await encryptPayload(
    mergedPayload,
    masterPassword!,
    device.deviceId,
    device.deviceName,
    appVersion,
    remoteFile.meta.version,
  );
  await gist.updateSyncGist(accessToken!, resourceId!, encrypted);
  assertCurrent();

  await opts.applyLocal(mergedPayload);
  markSkipHash(mergedPayload);
  commitSyncedPayload(mergedPayload, encrypted, resourceId!);

  return finish({
    success: true,
    action: "merge",
    version: encrypted.meta.version,
    mergedPayload,
  });
}

function hasLocalData(payload: SyncPayload): boolean {
  return payload.connections.length > 0 || payload.registries.length > 0 || payload.settings !== undefined;
}

// ---------------------------------------------------------------------------
// 冲突 / BLOCKED / 空库的恢复动作
// ---------------------------------------------------------------------------

/**
 * 冲突解决：使用远端（应用远端数据）。
 * 冲突意味着远端是用另一台设备的密码加密的，需用户输入"云端密码"解密；
 * 成功后本机同步密码重置为该密码（verificationHash 更新），后续同步保持一致。
 */
export async function resolveConflictUseRemote(
  cloudPassword: string,
  applyLocal: (p: SyncPayload) => Promise<void>,
): Promise<SyncResult> {
  const file = conflictRemoteFile;
  if (!file || !accessToken) {
    return { success: false, action: "none", error: "无冲突的远端数据" };
  }
  let payload: SyncPayload;
  try {
    payload = await decryptPayload(file, cloudPassword);
  } catch {
    return { success: false, action: "none", error: "云端密码不正确，解密失败" };
  }
  try {
    // 对齐云端密码：下次上传以新密码加密，另一台设备可继续解密
    const config = await createMasterKeyConfig(cloudPassword);
    saveMasterKeyConfig(config);
    masterPassword = cloudPassword;
    // 同步更新记住的密码，避免下次启动自动解锁失败
    await rememberPassword(cloudPassword);
    await adoptRemote(payload, file, state.gistId ?? "", applyLocal);
    state.conflict = null;
    conflictRemoteFile = null;
    state.syncState = "IDLE";
    state.lastError = null;
    notify();
    return { success: true, action: "download", version: file.meta.version };
  } catch (error) {
    return { success: false, action: "none", error: error instanceof Error ? error.message : String(error) };
  }
}

/** 冲突解决：使用本地（强制推送本地数据覆盖云端） */
export async function resolveConflictUseLocal(settings: AppSettings): Promise<SyncResult> {
  const conflict = state.conflict;
  state.conflict = null;
  conflictRemoteFile = null;
  state.syncState = "IDLE";
  notify();
  const result = await forcePushLocal(settings, conflict?.remoteVersion);
  return result;
}

/** BLOCKED 恢复：恢复远端数据到本地 */
export async function restoreRemoteFromBlocked(applyLocal: (p: SyncPayload) => Promise<void>): Promise<SyncResult> {
  const file = blockedRemoteFile;
  if (!file || !accessToken) {
    return { success: false, action: "none", error: "无远端数据可恢复" };
  }
  try {
    const payload = await decryptPayload(file, masterPassword!);
    await adoptRemote(payload, file, state.gistId ?? "", applyLocal);
    state.shrinkFinding = null;
    blockedRemoteFile = null;
    state.syncState = "IDLE";
    state.lastError = null;
    notify();
    return { success: true, action: "download", version: file.meta.version };
  } catch (error) {
    return { success: false, action: "none", error: error instanceof Error ? error.message : String(error) };
  }
}

/** 强制推送本地（跳过收缩护栏；空库确认后的"推送本地"也走这里）。
 * baseVersion 未指定时优先用最近下载的远端版本，避免云端版本号回退。 */
export async function forcePushLocal(settings: AppSettings, baseVersion?: number): Promise<SyncResult> {
  if (!accessToken || !masterPassword) {
    return { success: false, action: "none", error: "未连接或未解锁" };
  }
  if (state.syncing) {
    return { success: false, action: "none", error: "同步正在进行中" };
  }
  ++syncSeq;
  state.syncing = true;
  state.syncState = "SYNCING";
  notify();
  try {
    const anchor = loadAnchor();
    const resolvedBaseVersion =
      baseVersion ?? blockedRemoteFile?.meta.version ?? anchor?.version ?? 0;
    const payload = toSyncPayload(settings);
    const result = await uploadPayload(payload, {
      overrideShrink: true,
      base: loadBase(),
      baseVersion: resolvedBaseVersion,
    });
    state.syncing = false;
    if (result.success) {
      state.syncState = "IDLE";
      state.shrinkFinding = null;
      blockedRemoteFile = null;
      state.emptyVaultPending = null;
    } else {
      state.syncState = "ERROR";
      state.lastError = result.error ?? "推送失败";
    }
    notify();
    return result;
  } catch (error) {
    state.syncing = false;
    state.syncState = "ERROR";
    state.lastError = error instanceof Error ? error.message : String(error);
    notify();
    return { success: false, action: "none", error: String(error) };
  }
}

/** 空库保护确认：采用远端数据恢复本地 */
export async function confirmEmptyVaultRestore(applyLocal: (p: SyncPayload) => Promise<void>): Promise<SyncResult> {
  const pending = state.emptyVaultPending;
  if (!pending) {
    return { success: false, action: "none", error: "无待恢复数据" };
  }
  state.emptyVaultPending = null;
  await adoptRemote(pending.payload, pending.remoteFile, state.gistId ?? "", applyLocal);
  state.syncState = "IDLE";
  notify();
  return { success: true, action: "download", version: pending.remoteFile.meta.version };
}

/** 空库保护：改为推送本地（通常意味着用户有意清空） */
export async function confirmEmptyVaultPush(settings: AppSettings): Promise<SyncResult> {
  const pending = state.emptyVaultPending;
  state.emptyVaultPending = null;
  notify();
  return forcePushLocal(settings, pending?.remoteFile.meta.version);
}

// ---------------------------------------------------------------------------
// 历史版本（Gist 修订历史的浏览与恢复）
// ---------------------------------------------------------------------------

export interface RevisionPreview {
  sha: string;
  version: number;
  updatedAt: number;
  deviceName?: string;
  appVersion?: string;
  connections: number;
  registries: number;
}

/** 确保 Gist 可用（引擎记录的 id 或云端现查） */
async function ensureGistId(): Promise<string | null> {
  if (!accessToken) return null;
  if (state.gistId) return state.gistId;
  const found = await gist.findSyncGist(accessToken);
  if (found) {
    state.gistId = found;
    saveConfig({ ...loadConfig(), gistId: found });
  }
  return found;
}

/** 修订历史列表（时间倒序；首条即云端当前内容） */
export async function fetchHistory(): Promise<Array<{ sha: string; date: number }>> {
  const gistId = await ensureGistId();
  if (!accessToken || !gistId) return [];
  const history = await gist.getGistHistory(accessToken, gistId);
  return history.map((h) => ({ sha: h.version, date: h.date.getTime() }));
}

/** 下载并解密指定修订，返回摘要预览（不含恢复） */
export async function previewRevision(sha: string): Promise<RevisionPreview> {
  if (!accessToken || !masterPassword) {
    throw new Error("需先连接 GitHub 并解锁同步密码");
  }
  const gistId = await ensureGistId();
  if (!gistId) throw new Error("未找到同步 Gist");
  const file = await gist.downloadGistRevision(accessToken, gistId, sha);
  if (!file) throw new Error("该修订不包含同步文件");
  let payload: SyncPayload;
  try {
    payload = await decryptPayload(file, masterPassword);
  } catch {
    // WebKit 的解密失败报错是含混的 OperationError，翻译成可行动的提示
    throw new Error(
      "解密失败：该修订可能使用了与当前不同的同步密码（修改密码只影响之后的上传），无法预览或恢复",
    );
  }
  return {
    sha,
    version: file.meta.version,
    updatedAt: file.meta.updatedAt,
    deviceName: file.meta.deviceName,
    appVersion: file.meta.appVersion,
    connections: payload.connections.length,
    registries: payload.registries.length,
  };
}

/**
 * 恢复到指定历史版本：把旧数据应用回本机，并作为**新版本**推送到云端
 * （追加式恢复，不改写 Gist 修订历史，其他设备会自动拉到恢复后的内容）。
 * 恢复是有意的覆盖，跳过收缩护栏；需处于已解锁且无待处理的冲突/阻塞。
 */
export async function restoreRevision(
  sha: string,
  applyLocal: (p: SyncPayload) => Promise<void>,
): Promise<SyncResult> {
  if (!accessToken || !masterPassword) {
    return { success: false, action: "none", error: "未连接 GitHub 或同步密码未解锁" };
  }
  if (state.syncing) {
    return { success: false, action: "none", error: "同步正在进行中" };
  }
  if (state.syncState === "CONFLICT" || state.syncState === "BLOCKED") {
    return { success: false, action: "none", error: "请先处理当前的冲突/阻塞状态" };
  }
  const gistId = await ensureGistId();
  if (!gistId) {
    return { success: false, action: "none", error: "未找到同步 Gist" };
  }

  ++syncSeq;
  state.syncing = true;
  state.syncState = "SYNCING";
  notify();
  try {
    const file = await gist.downloadGistRevision(accessToken, gistId, sha);
    if (!file) {
      throw new Error("该修订不包含同步文件");
    }
    let payload: SyncPayload;
    try {
      payload = await decryptPayload(file, masterPassword);
    } catch {
      throw new Error(
        "解密失败：该修订可能使用了与当前不同的同步密码（修改密码只影响之后的上传），无法恢复",
      );
    }

    // 以当前云端版本 + 1 作为恢复后的新版本推送（追加式，历史不被改写）。
    // remoteVersion 是内存态：重启后若锚点也缺失（少见），从云端 meta 补齐，避免版本号回退
    const anchor = loadAnchor();
    let baseVersion = Math.max(state.remoteVersion ?? 0, anchor?.version ?? 0);
    if (baseVersion === 0) {
      const current = await gist.downloadSyncGist(accessToken, gistId);
      baseVersion = current?.meta.version ?? 0;
    }
    const encrypted = await encryptPayload(
      payload,
      masterPassword,
      device.deviceId,
      device.deviceName,
      appVersion,
      baseVersion,
    );
    await gist.updateSyncGist(accessToken, gistId, encrypted);

    await applyLocal(payload);
    markSkipHash(payload);
    commitSyncedPayload(payload, encrypted, gistId);

    state.syncing = false;
    state.syncState = "IDLE";
    state.shrinkFinding = null;
    notify();
    return { success: true, action: "upload", version: encrypted.meta.version };
  } catch (error) {
    state.syncing = false;
    state.syncState = "ERROR";
    state.lastError = error instanceof Error ? error.message : String(error);
    notify();
    return { success: false, action: "none", error: error instanceof Error ? error.message : String(error) };
  }
}

export function dismissEmptyVaultPrompt(): void {
  state.emptyVaultPending = null;
  notify();
}
