/**
 * 锚点决策（移植自 Netcatty syncAnchorDecision.js + syncSignature）。
 *
 * "远端自上次观察以来是否变化过？"——四种关键判定：
 *   1. 无锚点 + 远端无文件     → 未变化（首次同步无事可合并）
 *   2. 无锚点 + 远端有数据     → 已变化（走三方合并，空 base 并集）
 *   3. resourceId 漂移         → 已变化（新建了 Gist，旧锚点无意义）
 *   4. 签名不一致              → 已变化（同文件新密文，标准漂移）
 * 其余情况视为未变化，调用方直接短路。
 */

import type { ProviderSyncAnchor, SyncedFile } from "../../types/sync";
import { arrayBufferToBase64, sha256 } from "./encryption";

export interface RemoteChangedDecision {
  remoteChanged: boolean;
  reason: string;
}

export function decideRemoteChanged(input: {
  currentSignature: string | null;
  currentResourceId: string | null;
  anchor: ProviderSyncAnchor | null;
  hasRemoteFile: boolean;
}): RemoteChangedDecision {
  const { currentSignature, currentResourceId, anchor, hasRemoteFile } = input;

  if (!anchor) {
    if (!hasRemoteFile) {
      return { remoteChanged: false, reason: "no-anchor-no-remote" };
    }
    if (currentSignature === null) {
      // 文件存在但算不出签名（结构异常/新 schema）→ 视为已变化，
      // 走解密合并路径把错误暴露给用户，好过静默覆盖
      return { remoteChanged: true, reason: "unreadable-remote" };
    }
    return { remoteChanged: true, reason: "no-anchor-remote-has-data" };
  }

  // 资源漂移：Gist 被重建过，旧锚点签名失效
  if ((anchor.resourceId ?? null) !== currentResourceId) {
    return { remoteChanged: true, reason: "resource-id-changed" };
  }

  // 同一资源、签名不同 → 新密文/新 meta
  if ((anchor.signature ?? null) !== currentSignature) {
    return { remoteChanged: true, reason: "signature-mismatch" };
  }

  return { remoteChanged: false, reason: "anchor-matches" };
}

/**
 * 云端文件指纹：SHA-256(JSON(meta + 密文)) 的 Base64。
 * meta 含 iv/salt/version，任何一次真实上传都会改变签名。
 */
export async function createSyncedFileSignature(syncedFile: SyncedFile | null): Promise<string | null> {
  if (!syncedFile) return null;
  const bytes = new TextEncoder().encode(JSON.stringify({ meta: syncedFile.meta, payload: syncedFile.payload }));
  return arrayBufferToBase64(await sha256(bytes));
}
