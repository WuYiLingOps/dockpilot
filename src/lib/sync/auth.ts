/**
 * GitHub 认证与 token 存取（移植自 Netcatty GitHubAdapter 的 Device Flow 部分）。
 *
 * Device Flow（RFC 8628）只需 OAuth App 的 client_id：
 *   1. github_device_flow_start 取 device_code + user_code，用户浏览器输入
 *   2. 按 interval 轮询 github_device_flow_poll，处理
 *      authorization_pending / slow_down(+5s) / expired_token / access_denied
 *   3. token 存系统钥匙串（Rust secret_store），返回实际落点由调用方记录
 */

import { invoke } from "@tauri-apps/api/core";
import { SYNC_CONSTANTS, type DeviceFlowStart, type OAuthTokens, type ProviderAccount } from "../../types/sync";

// ---------------------------------------------------------------------------
// Device Flow
// ---------------------------------------------------------------------------

export const startDeviceFlow = async (clientId = SYNC_CONSTANTS.GITHUB_CLIENT_ID): Promise<DeviceFlowStart> => {
  return invoke<DeviceFlowStart>("github_device_flow_start", { clientId, scope: "gist read:user" });
};

export interface DeviceFlowPollEvents {
  onPending?: () => void;
  /** slow_down 响应后通知（间隔已 +5s） */
  onSlowDown?: () => void;
}

/**
 * 轮询直到拿到 token / 被拒绝 / 过期 / 用户取消（abort.signal）。
 * 遵守服务端 interval，最低 5 秒；slow_down 时 +5 秒。
 */
export const pollForToken = async (
  start: DeviceFlowStart,
  events: DeviceFlowPollEvents = {},
  signal?: AbortSignal,
): Promise<OAuthTokens> => {
  const clientId = SYNC_CONSTANTS.GITHUB_CLIENT_ID;
  let intervalMs = Math.max(start.interval, 5) * 1000;

  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("GitHub 认证已取消", "AbortError"));
        },
        { once: true },
      );
    });

  while (Date.now() < start.expiresAt) {
    await sleep(intervalMs);
    if (signal?.aborted) throw new DOMException("GitHub 认证已取消", "AbortError");

    // 单次轮询的网络失败（瞬态超时等）不中断授权流程，按 pending 处理等下一轮
    const data = await invoke<Record<string, unknown>>("github_device_flow_poll", {
      clientId,
      deviceCode: start.deviceCode,
    }).catch(() => null);
    if (!data) {
      events.onPending?.();
      continue;
    }

    if (typeof data.access_token === "string" && data.access_token) {
      return {
        accessToken: data.access_token,
        tokenType: typeof data.token_type === "string" ? data.token_type : "bearer",
        scope: typeof data.scope === "string" ? data.scope : undefined,
      };
    }

    const error = typeof data.error === "string" ? data.error : undefined;
    if (error === "authorization_pending") {
      events.onPending?.();
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 5000;
      events.onSlowDown?.();
      continue;
    }
    if (error === "expired_token") {
      throw new Error("设备码已过期，请重新连接");
    }
    if (error === "access_denied") {
      throw new Error("用户拒绝了授权");
    }
    if (error) {
      const desc = typeof data.error_description === "string" ? data.error_description : error;
      throw new Error(`GitHub 认证失败: ${desc}`);
    }
  }

  throw new Error("设备码已过期，请重新连接");
};

// ---------------------------------------------------------------------------
// 用户信息
// ---------------------------------------------------------------------------

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

/** GET /user（api.github.com 自带 CORS，直接 fetch） */
export const getUserInfo = async (accessToken: string): Promise<ProviderAccount> => {
  const res = await fetch(`${SYNC_CONSTANTS.GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!res.ok) throw new Error(`获取 GitHub 账号信息失败: ${res.status} ${res.statusText}`);
  const user = (await res.json()) as GitHubUser;
  return {
    id: String(user.id),
    login: user.login,
    name: user.name || user.login,
    email: user.email || undefined,
    avatarUrl: user.avatar_url,
  };
};

/** 校验 token 是否仍有效 */
export const validateToken = async (accessToken: string): Promise<boolean> => {
  try {
    const res = await fetch(`${SYNC_CONSTANTS.GITHUB_API_BASE}/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Token 持久化（系统钥匙串 / 加密文件，落点由调用方记录到同步配置）
// ---------------------------------------------------------------------------

export type TokenBackend = "keyring" | "file";

export const saveToken = async (token: string): Promise<TokenBackend> =>
  invoke<TokenBackend>("sync_save_github_token", { token });

export const loadToken = async (backend: TokenBackend): Promise<string | null> =>
  invoke<string | null>("sync_load_github_token", { backend });

export const deleteToken = async (backend: TokenBackend): Promise<void> => {
  await invoke("sync_delete_github_token", { backend });
};

// ---------------------------------------------------------------------------
// 同步密码持久化（记住密码：解锁后自动保存，锁定时清除）
// ---------------------------------------------------------------------------

export const saveSyncPassword = async (password: string): Promise<TokenBackend> =>
  invoke<TokenBackend>("sync_save_sync_password", { password });

export const loadSyncPassword = async (backend: TokenBackend): Promise<string | null> =>
  invoke<string | null>("sync_load_sync_password", { backend });

export const deleteSyncPassword = async (backend: TokenBackend): Promise<void> => {
  await invoke("sync_delete_sync_password", { backend });
};
