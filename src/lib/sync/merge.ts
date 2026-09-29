/**
 * 三方合并（移植自 Netcatty syncMerge.ts，裁剪到 connections/registries/标量设置）。
 *
 * 以"上次成功同步的快照"为 base，按实体 id 检测两侧变化：
 *   - 仅一侧存在           → 新增，保留
 *   - base 有、一侧删除    → 若另一侧未修改则删除，修改过则保留修改（更安全）
 *   - 仅一侧修改           → 保留修改侧
 *   - 两侧都修改           → 本地优先，计入冲突
 * base 不可用（首次同步）时退化为按 id 并集，重复 id 本地优先。
 *
 * 标量设置按字段三方合并：两侧都改时本地优先（首次合并远端优先，让新设备
 * 能拉到云端既有设置），冲突计数。
 */

import type { RegistryProfile, ConnectionProfile } from "../../types/settings";
import type { SyncPayload, SyncedScalarSettings } from "../../types/sync";
import { SYNC_SCALAR_SETTING_KEYS } from "../../types/sync";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export interface MergeSummary {
  added: { local: number; remote: number };
  deleted: { local: number; remote: number };
  modified: { local: number; remote: number; conflicts: number };
}

export interface MergeResult {
  payload: SyncPayload;
  /** 是否存在双改冲突（本地优先解决） */
  hadConflicts: boolean;
  summary: MergeSummary;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 确定性 JSON 序列化（对象键排序），用于内容级比较 */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

interface EntityMergeResult<T> {
  merged: T[];
  conflicts: number;
  added: { local: number; remote: number };
  deleted: { local: number; remote: number };
  modified: { local: number; remote: number };
}

// ---------------------------------------------------------------------------
// 实体数组合并（connections / registries）
// ---------------------------------------------------------------------------

function mergeEntityArrays<T extends { id: string }>(
  base: T[],
  local: T[],
  remote: T[],
): EntityMergeResult<T> {
  const baseMap = new Map(base.map((e) => [e.id, e]));
  const localMap = new Map(local.map((e) => [e.id, e]));
  const remoteMap = new Map(remote.map((e) => [e.id, e]));

  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  const merged: T[] = [];
  let conflicts = 0;
  const added = { local: 0, remote: 0 };
  const deleted = { local: 0, remote: 0 };
  const modified = { local: 0, remote: 0 };

  for (const id of allIds) {
    const baseItem = baseMap.get(id);
    const localItem = localMap.get(id);
    const remoteItem = remoteMap.get(id);

    const inBase = baseItem !== undefined;
    const inLocal = localItem !== undefined;
    const inRemote = remoteItem !== undefined;

    if (!inBase && inLocal && !inRemote) {
      merged.push(localItem);
      added.local++;
    } else if (!inBase && !inLocal && inRemote) {
      merged.push(remoteItem);
      added.remote++;
    } else if (!inBase && inLocal && inRemote) {
      // 双方都新增了同 id —— 本地优先
      merged.push(localItem);
      if (fingerprint(localItem) !== fingerprint(remoteItem)) conflicts++;
    } else if (inBase && inLocal && inRemote) {
      const localChanged = fingerprint(localItem) !== fingerprint(baseItem);
      const remoteChanged = fingerprint(remoteItem) !== fingerprint(baseItem);

      if (!localChanged && !remoteChanged) {
        merged.push(baseItem);
      } else if (localChanged && !remoteChanged) {
        merged.push(localItem);
        modified.local++;
      } else if (!localChanged && remoteChanged) {
        merged.push(remoteItem);
        modified.remote++;
      } else {
        // 双改 —— 本地优先
        merged.push(localItem);
        if (fingerprint(localItem) !== fingerprint(remoteItem)) conflicts++;
        modified.local++;
        modified.remote++;
      }
    } else if (inBase && !inLocal && inRemote) {
      // 本地已删除：远端也改过则保留修改（避免误删远端的新内容）
      const remoteChanged = fingerprint(remoteItem) !== fingerprint(baseItem);
      if (remoteChanged) {
        merged.push(remoteItem);
        conflicts++;
      } else {
        deleted.local++;
      }
    } else if (inBase && inLocal && !inRemote) {
      // 远端已删除：本地改过则保留修改
      const localChanged = fingerprint(localItem) !== fingerprint(baseItem);
      if (localChanged) {
        merged.push(localItem);
        conflicts++;
      } else {
        deleted.remote++;
      }
    }
    // inBase && !inLocal && !inRemote → 两侧都删除 → 移除
  }

  return { merged, conflicts, added, deleted, modified };
}

// ---------------------------------------------------------------------------
// 标量设置合并（扁平键值，双改本地优先；首次合并 base 缺失时远端优先）
// ---------------------------------------------------------------------------

type ScalarObj = SyncedScalarSettings | undefined;

function mergeScalarSettings(
  base: ScalarObj,
  local: ScalarObj,
  remote: ScalarObj,
  preferRemoteOnConflict: boolean,
): { merged: ScalarObj; conflicts: number } {
  if (!local && !remote) return { merged: undefined, conflicts: 0 };
  if (!local) return { merged: remote, conflicts: 0 };
  if (!remote) return { merged: local, conflicts: 0 };

  const b = base ?? {};
  const allKeys = new Set<string>([
    ...SYNC_SCALAR_SETTING_KEYS,
    ...Object.keys(b),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);

  const merged: Record<string, unknown> = {};
  let conflicts = 0;

  for (const key of allKeys) {
    const bVal = (b as Record<string, unknown>)[key];
    const lVal = (local as Record<string, unknown>)[key];
    const rVal = (remote as Record<string, unknown>)[key];

    const lChanged = fingerprint(lVal) !== fingerprint(bVal);
    const rChanged = fingerprint(rVal) !== fingerprint(bVal);

    if (!lChanged && !rChanged) {
      if (bVal !== undefined) merged[key] = bVal;
    } else if (lChanged && !rChanged) {
      if (lVal !== undefined) merged[key] = lVal;
    } else if (!lChanged && rChanged) {
      if (rVal !== undefined) merged[key] = rVal;
    } else {
      // 双改：本地优先（首次合并远端优先，见函数注释）
      conflicts++;
      const winner = preferRemoteOnConflict ? rVal : lVal;
      if (winner !== undefined) merged[key] = winner;
    }
  }

  return {
    merged: Object.keys(merged).length > 0 ? (merged as SyncedScalarSettings) : undefined,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 三方合并同步载荷。
 * @param base   上次成功同步的快照（null = 首次同步 / 快照丢失）
 * @param local  本机当前数据
 * @param remote 云端下载数据
 */
export function mergeSyncPayloads(
  base: SyncPayload | null,
  local: SyncPayload,
  remote: SyncPayload,
): MergeResult {
  const emptyBase: SyncPayload = { connections: [], registries: [], settings: undefined, syncedAt: 0 };
  const b = base ?? emptyBase;

  const connections = mergeEntityArrays<ConnectionProfile>(
    b.connections ?? [],
    local.connections ?? [],
    remote.connections ?? [],
  );
  const registries = mergeEntityArrays<RegistryProfile>(
    b.registries ?? [],
    local.registries ?? [],
    remote.registries ?? [],
  );

  const summary: MergeSummary = {
    added: { local: connections.added.local + registries.added.local, remote: connections.added.remote + registries.added.remote },
    deleted: { local: connections.deleted.local + registries.deleted.local, remote: connections.deleted.remote + registries.deleted.remote },
    modified: {
      local: connections.modified.local + registries.modified.local,
      remote: connections.modified.remote + registries.modified.remote,
      conflicts: connections.conflicts + registries.conflicts,
    },
  };

  const settings = mergeScalarSettings(b.settings, local.settings, remote.settings, base === null);
  summary.modified.conflicts += settings.conflicts;

  const payload: SyncPayload = {
    connections: connections.merged,
    registries: registries.merged,
    settings: settings.merged,
    syncedAt: Date.now(),
  };

  return { payload, hadConflicts: summary.modified.conflicts > 0, summary };
}
