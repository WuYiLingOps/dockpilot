/**
 * 收缩护栏（移植自 Netcatty syncGuards.ts，阈值按 DockPilot 数据量调整）。
 *
 * 拒绝推送"静默丢数据"的载荷：本机数据局部丢失（钥匙串故障、半载、
 * hydration 竞态）时，合并/上传结果会比 base 少一大截。base 缺失时
 * 退化为以当前远端为参照（首次同步、快照丢失场景，#779 同款问题）。
 */

import type { SyncEntityType, SyncPayload, ShrinkFinding } from "../../types/sync";

/** 相对收缩：丢失 ≥30% 且 ≥2 个实体 */
const BULK_SHRINK_RATIO = 0.3;
const BULK_SHRINK_MIN_ABSOLUTE = 2;
/** 绝对收缩：丢失 ≥10 个直接判定（大库小比例也能拦住） */
const LARGE_SHRINK_ABSOLUTE = 10;

const CHECKED_ENTITIES: readonly SyncEntityType[] = ["connections", "registries"];

const countOf = (p: SyncPayload, key: SyncEntityType): number => {
  const v = p[key];
  return Array.isArray(v) ? v.length : 0;
};

export function detectSuspiciousShrink(
  outgoing: SyncPayload,
  base: SyncPayload | null,
  remote?: SyncPayload | null,
): ShrinkFinding {
  // base 缺失时才用远端兜底：合法的"设备后来反超旧远端快照"不受影响
  const reference = base ?? remote ?? null;
  const viaRemote = !base && !!remote;
  if (!reference) return { suspicious: false };

  for (const entityType of CHECKED_ENTITIES) {
    const baseCount = countOf(reference, entityType);
    const outgoingCount = countOf(outgoing, entityType);
    const lost = baseCount - outgoingCount;
    if (lost <= 0) continue;

    if (lost >= LARGE_SHRINK_ABSOLUTE) {
      return {
        suspicious: true,
        reason: "large-shrink",
        entityType,
        baseCount,
        outgoingCount,
        lost,
        ...(viaRemote ? { viaRemote: true } : {}),
      };
    }

    if (baseCount > 0 && lost / baseCount >= BULK_SHRINK_RATIO && lost >= BULK_SHRINK_MIN_ABSOLUTE) {
      return {
        suspicious: true,
        reason: "bulk-shrink",
        entityType,
        baseCount,
        outgoingCount,
        lost,
        ...(viaRemote ? { viaRemote: true } : {}),
      };
    }
  }

  return { suspicious: false };
}
