/**
 * 云同步的 React 集成：
 * - useCloudSyncState：订阅引擎状态（useSyncExternalStore）
 * - useCloudSync：应用级自动化——启动远端检查（门闩 + 退避重试）、
 *   设置变更去抖 3 秒自动同步（序列化哈希去重 + 回填跳过）、窗口重新可见时检查
 * - useSyncActions：设置页/横幅用的动作（手动同步、冲突解决、恢复远端等）
 *
 * 触发时机（方案 5.4）：订阅 React Query 的 ["settings"]，连接增删改 /
 * registry 增删 / 标量修改后去抖 3 秒；对 payload 做指纹哈希，无变化不推。
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useSettings, useUpdateSettings } from "../lib/settings";
import * as engine from "../lib/sync/engine";
import { applySyncPayload, buildSyncPayload, payloadFingerprint } from "../lib/sync/payload";
import type { AppSettings } from "../types/settings";
import type { SyncPayload, SyncResult } from "../types/sync";

/** 订阅引擎状态快照 */
export function useCloudSyncState(): Readonly<engine.CloudSyncState> {
  return useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);
}

const DEBOUNCE_MS = 3000;
/** 启动检查失败的退避序列（方案 5.3：30s/60s/120s/240s） */
const STARTUP_RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000];
/** 窗口重新可见触发的远端检查节流 */
const VISIBILITY_CHECK_THROTTLE_MS = 30_000;

/** 应用合并/下载载荷到本机设置（走 set_settings 持久化并更新缓存） */
export function useSyncApplyLocal(): (payload: SyncPayload) => Promise<void> {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  return useCallback(
    async (payload) => {
      const current = settingsRef.current;
      if (!current) throw new Error("设置尚未加载，无法应用同步数据");
      const next = applySyncPayload(current, payload);
      await update.mutateAsync(next);
      // SSH 凭证落地本机 secret_store（此步在连接档案写入后，条目必然已存在；
      // 失败不阻断设置应用，凭证可由下次同步重新导入）
      const creds = payload.ssh_credentials;
      if (creds?.length) {
        try {
          await api.importSshSecrets(creds);
        } catch (e) {
          toast.error(`SSH 凭证写入本机失败: ${String(e)}`);
        }
      }
    },
    [update],
  );
}

/** 手动同步等动作（设置页与横幅共用） */
export function useSyncActions() {
  const applyLocal = useSyncApplyLocal();
  const { data: settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /** 结果反馈：冲突/阻塞/空库等需要 UI 决策的结果不弹错误 */
  const report = useCallback((r: SyncResult, okMessage: string) => {
    if (r.success) {
      const actionText =
        r.action === "merge" ? "已合并同步" : r.action === "download" ? "已拉取云端数据" : r.action === "upload" ? "已上传" : okMessage;
      toast.success(actionText);
    } else if (
      !r.conflictDetected &&
      !r.shrinkBlocked &&
      r.error !== "empty-vault-guard"
    ) {
      toast.error(`同步失败: ${r.error ?? "未知错误"}`);
    }
    return r;
  }, []);

  const manualSync = useCallback(async () => {
    const s = settingsRef.current;
    if (!s) return;
    const r = await engine.syncNow(s, { reason: "manual", applyLocal });
    report(r, "云端与本地一致");
  }, [applyLocal, report]);

  const resolveConflictRemote = useCallback(
    async (cloudPassword: string) => {
      const r = await engine.resolveConflictUseRemote(cloudPassword, applyLocal);
      // 失败原因（密码错误等）由弹窗内联展示，不走全局 toast
      if (r.success) toast.success("已恢复云端数据");
      return r;
    },
    [applyLocal],
  );

  const resolveConflictLocal = useCallback(async () => {
    const s = settingsRef.current;
    if (!s) return;
    const r = await engine.resolveConflictUseLocal(s);
    report(r, "已推送本地数据");
  }, [report]);

  const restoreBlockedRemote = useCallback(async () => {
    const r = await engine.restoreRemoteFromBlocked(applyLocal);
    report(r, "已恢复云端数据");
  }, [applyLocal, report]);

  const forcePushBlockedLocal = useCallback(async () => {
    const s = settingsRef.current;
    if (!s) return;
    const r = await engine.forcePushLocal(s);
    report(r, "已强制推送本地数据");
  }, [report]);

  const restoreEmptyVault = useCallback(async () => {
    const r = await engine.confirmEmptyVaultRestore(applyLocal);
    report(r, "已恢复云端数据");
  }, [applyLocal, report]);

  const pushEmptyVault = useCallback(async () => {
    const s = settingsRef.current;
    if (!s) return;
    const r = await engine.confirmEmptyVaultPush(s);
    report(r, "已推送本地数据");
  }, [report]);

  const dismissEmptyVault = useCallback(() => engine.dismissEmptyVaultPrompt(), []);

  /** 恢复到指定历史版本（云端 + 本机一起回到该内容，作为新版本推送） */
  const restoreRevision = useCallback(
    async (sha: string) => {
      const s = settingsRef.current;
      if (!s) {
        return { success: false, action: "none" as const, error: "设置尚未加载" };
      }
      const r = await engine.restoreRevision(sha, applyLocal);
      report(r, "已恢复历史版本");
      return r;
    },
    [applyLocal, report],
  );

  return {
    manualSync,
    resolveConflictRemote,
    resolveConflictLocal,
    restoreBlockedRemote,
    forcePushBlockedLocal,
    restoreEmptyVault,
    pushEmptyVault,
    dismissEmptyVault,
    restoreRevision,
  };
}

/**
 * 应用级云同步自动化（App 挂载一次）。
 * 安全护栏：启动检查完成（startupChecked）前自动同步不触发；
 * 空库 / 冲突 / 阻塞状态不自动继续，等待用户决策。
 */
export function useCloudSync(): void {
  const state = useCloudSyncState();
  const applyLocal = useSyncApplyLocal();
  const { data: settings } = useSettings();

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const applyLocalRef = useRef(applyLocal);
  applyLocalRef.current = applyLocal;

  // 引擎初始化（一次）：加载配置 / token / 密码配置
  useEffect(() => {
    void engine.initialize();
  }, []);

  const canSync = state.connected && state.securityState === "UNLOCKED";

  // 启动远端检查：成功（或冲突/阻塞/空库等已"看见"远端的状态）后解除门闩；
  // 失败按 30s/60s/120s/240s 退避重试，退避耗尽放行本轮会话的自动同步
  useEffect(() => {
    if (!canSync || !settings || state.startupChecked) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const attempt = (delayMs: number, retryIndex: number) => {
      timer = setTimeout(() => {
        const s = settingsRef.current;
        if (cancelled || !s) return;
        void engine.syncNow(s, { reason: "startup", applyLocal: (p) => applyLocalRef.current(p) }).then((r) => {
          if (cancelled) return;
          if (r.success || r.conflictDetected || r.shrinkBlocked || r.error === "empty-vault-guard") {
            engine.markStartupChecked();
          } else if (retryIndex < STARTUP_RETRY_BACKOFF_MS.length) {
            attempt(STARTUP_RETRY_BACKOFF_MS[retryIndex], retryIndex + 1);
          } else {
            engine.markStartupChecked();
          }
        });
      }, delayMs);
    };

    attempt(1000, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canSync, settings, state.startupChecked]);

  // 设置变更 → 去抖 3 秒自动同步（指纹去重 + 回填跳过在引擎侧）；
  // 载荷含 SSH 凭证时需经 IPC 异步导出，改用异步构建 + cancelled 标记防竞态
  useEffect(() => {
    if (!settings || !canSync || !state.autoSync || !state.startupChecked) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const payload = await buildSyncPayload(settings);
      if (cancelled || engine.isPayloadSkipped(payload)) return;

      timer = setTimeout(() => {
        const s = settingsRef.current;
        if (!s) return;
        // 定时器触发前设置可能又变了：以最新设置构建载荷再查一次指纹
        void (async () => {
          const latest = await buildSyncPayload(s);
          if (engine.isPayloadSkipped(latest)) return;
          const r = await engine.syncNow(s, {
            reason: "auto",
            applyLocal: (p) => applyLocalRef.current(p),
          });
          if (!r.success && r.error && !r.conflictDetected && !r.shrinkBlocked && r.error !== "empty-vault-guard") {
            toast.error(`云同步失败: ${r.error}`);
          }
        })().catch(() => {});
      }, DEBOUNCE_MS);
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [settings, canSync, state.autoSync, state.startupChecked]);

  // 窗口重新可见 → 强制检查远端（节流 30 秒；不依赖自动同步开关）
  useEffect(() => {
    if (!canSync || !state.startupChecked) return;
    let last = 0;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < VISIBILITY_CHECK_THROTTLE_MS) return;
      last = now;
      const s = settingsRef.current;
      if (!s) return;
      void engine.syncNow(s, { reason: "auto", applyLocal: (p) => applyLocalRef.current(p) }).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [canSync, state.startupChecked]);
}

/** 供日志/调试：当前本地载荷指纹（判断"是否真的变了"） */
export async function localPayloadFingerprint(settings: AppSettings): Promise<string> {
  return payloadFingerprint(await buildSyncPayload(settings));
}
