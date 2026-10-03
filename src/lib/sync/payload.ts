/**
 * AppSettings ↔ SyncPayload 映射。
 *
 * 设备本地字段不入载荷：
 * - active_connection_id（各设备当前选择）
 * - docker_socket（旧版迁移字段）
 * - close_action（关闭窗口行为属桌面使用习惯，各设备可不同）
 * - RegistryProfile.secret_backend（密码在本机的存储落点，两台设备可能不同：
 *   钥匙串 vs 加密文件。上传前归一化为空串，应用到本地时对已存在的条目
 *   保留本机值——否则两端互刷该字段会造成合并震荡）
 */

import type { AppSettings, RegistryProfile } from "../../types/settings";
import { pickSyncedSettings, type SyncPayload } from "../../types/sync";
import { api } from "../api";
import { applog } from "../applog";

/** 上传/比较用的载荷视图：剔除设备本地字段 */
export function toSyncPayload(settings: AppSettings): SyncPayload {
  return {
    connections: settings.connections.map((c) => ({ ...c })),
    ssh_keys: settings.ssh_keys.map((k) => ({ ...k })),
    ssh_identities: settings.ssh_identities.map((i) => ({ ...i })),
    registries: settings.registries.map((r) => ({ ...r, secret_backend: "" })),
    settings: pickSyncedSettings(settings),
    syncedAt: Date.now(),
  };
}

/**
 * 构建本机上传载荷：sync_credentials 开启时先从本机 secret_store 导出 SSH 凭证
 * （登录密码 / 口令 / 导入式私钥）注入载荷。凭证明文随整体载荷由同步密码信封
 * 加密后上传（两层加密域中的"可移植层"；本机静态安全仍由 secret_store 承担）。
 * 导出失败降级为不带凭证继续同步（下次成功导出自动补齐），不阻断同步。
 */
export async function buildSyncPayload(settings: AppSettings): Promise<SyncPayload> {
  const payload = toSyncPayload(settings);
  if (!settings.sync_credentials) return payload;
  try {
    const ssh_credentials = await api.exportSshSecrets();
    return { ...payload, ssh_credentials };
  } catch (e) {
    applog.warn(
      `导出 SSH 凭证失败，本次同步不携带凭证: ${e instanceof Error ? e.message : String(e)}`,
    );
    return payload;
  }
}

/**
 * 将合并/下载的载荷应用到本机设置。
 * 保留设备本地的 active_connection_id 与 docker_socket；
 * 已存在 registry 的 secret_backend 保留本机值（新条目置空待首次录入密码时回填）；
 * SSH 钥匙串元数据随载荷落地（载荷无该字段时保留本机——旧云端载荷 / 开关关闭），
 * 连接的 key_id 引用据此解析，凭证材料随后经 import_ssh_secrets 写入本机密钥库。
 */
export function applySyncPayload(settings: AppSettings, payload: SyncPayload): AppSettings {
  const localBackends = new Map(settings.registries.map((r) => [r.id, r.secret_backend]));
  const registries: RegistryProfile[] = payload.registries.map((r) => ({
    ...r,
    secret_backend: localBackends.get(r.id) ?? "",
  }));

  return {
    ...settings,
    connections: payload.connections.map((c) => ({ ...c })),
    ssh_keys: payload.ssh_keys ?? settings.ssh_keys,
    registries,
    ...(payload.settings ?? {}),
  };
}

/** 载荷的规范化指纹（剔除 syncedAt 时间戳，用于变更检测与跳过哈希；null → 空串） */
export function payloadFingerprint(payload: SyncPayload | null): string {
  if (!payload) return "";
  const { syncedAt: _syncedAt, ...rest } = payload;
  return JSON.stringify(rest, (_key, v) => {
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
