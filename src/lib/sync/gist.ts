/**
 * GitHub Gist CRUD（移植自 Netcatty GitHubAdapter 的 Gist 部分）。
 *
 * api.github.com 自带 CORS，直接用 WebView fetch；raw 内容下载（截断兜底）
 * 走 Rust 命令 github_gist_raw_content（CORS 不确定 + origin 校验）。
 * accessToken 只在内存中流转，由调用方（engine）从钥匙串加载。
 */

import { invoke } from "@tauri-apps/api/core";
import { SYNC_CONSTANTS, type SyncedFile } from "../../types/sync";

// ---------------------------------------------------------------------------
// GitHub API 类型
// ---------------------------------------------------------------------------

export interface GitHubGistFile {
  filename: string;
  /** Gist API 内嵌内容，约 1MB 处截断（truncated=true 时） */
  content?: string;
  truncated?: boolean;
  raw_url?: string;
  /** 文件大小（UTF-8 字节；JS 字符串 .length 是 UTF-16 码元） */
  size?: number;
}

interface GitHubGist {
  id: string;
  description: string;
  files: Record<string, GitHubGistFile>;
  updated_at?: string;
  history?: Array<{ version: string; committed_at: string }>;
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    ...extra,
  };
}

/**
 * WebView fetch 无自动重试：直连 api.github.com 存在间歇性超时（尤其国内网络），
 * 网络类失败自动重试，间隔 1s / 2s。仅对"请求根本没发出去/中途断开"重试，
 * HTTP 错误响应（401/404 等）原样返回交给调用方处理。
 */
async function fetchWithRetry(url: string, init: RequestInit, what: string): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
    try {
      return await fetch(url, init);
    } catch (e) {
      lastError = e;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${what}失败: 网络异常（已自动重试 3 次）: ${detail}。可稍后重试；若本机需要代理访问 GitHub，请设置 HTTPS_PROXY 环境变量后重启应用`);
}

async function gistResponse<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${what}失败: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Gist 操作
// ---------------------------------------------------------------------------

/** 在用户 Gist 列表中查找 DockPilot 同步库 */
export async function findSyncGist(accessToken: string): Promise<string | null> {
  const res = await fetchWithRetry(`${SYNC_CONSTANTS.GITHUB_API_BASE}/gists?per_page=100`, { headers: authHeaders(accessToken) }, "获取 Gist 列表");
  const gists = await gistResponse<GitHubGist[]>(res, "获取 Gist 列表");
  const syncGist = gists.find(
    (g) => g.description === SYNC_CONSTANTS.GIST_DESCRIPTION && g.files[SYNC_CONSTANTS.SYNC_FILE_NAME],
  );
  return syncGist?.id ?? null;
}

/** 创建私有同步 Gist，返回 Gist ID */
export async function createSyncGist(accessToken: string, syncedFile: SyncedFile): Promise<string> {
  const res = await fetchWithRetry(
    `${SYNC_CONSTANTS.GITHUB_API_BASE}/gists`,
    {
      method: "POST",
      headers: authHeaders(accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        description: SYNC_CONSTANTS.GIST_DESCRIPTION,
        public: false,
        files: { [SYNC_CONSTANTS.SYNC_FILE_NAME]: { content: JSON.stringify(syncedFile, null, 2) } },
      }),
    },
    "创建同步 Gist",
  );
  const gist = await gistResponse<GitHubGist>(res, "创建同步 Gist");
  return gist.id;
}

/** 更新已有同步 Gist */
export async function updateSyncGist(accessToken: string, gistId: string, syncedFile: SyncedFile): Promise<void> {
  const res = await fetchWithRetry(
    `${SYNC_CONSTANTS.GITHUB_API_BASE}/gists/${gistId}`,
    {
      method: "PATCH",
      headers: authHeaders(accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        files: { [SYNC_CONSTANTS.SYNC_FILE_NAME]: { content: JSON.stringify(syncedFile, null, 2) } },
      }),
    },
    "更新同步 Gist",
  );
  if (!res.ok) throw new Error(`更新同步 Gist 失败: ${res.status} ${res.statusText}`);
}

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/** 截断双检：truncated 标记，或 size（UTF-8 字节）大于内嵌内容的实际字节数 */
function gistFileNeedsRawFetch(file: GitHubGistFile): boolean {
  if (file.truncated) return true;
  if (
    typeof file.size === "number" &&
    typeof file.content === "string" &&
    file.size > utf8ByteLength(file.content)
  ) {
    return true;
  }
  return false;
}

const parseSyncedFile = (raw: string): SyncedFile => {
  const parsed = JSON.parse(raw) as SyncedFile;
  // 结构校验：畸形数据（手工编辑的 Gist / 截断残留）给出明确错误，
  // 而不是让 "meta undefined" 一类的 TypeError 一路烧到冲突分支
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.payload !== "string" ||
    !parsed.meta ||
    typeof parsed.meta.version !== "number" ||
    typeof parsed.meta.salt !== "string" ||
    typeof parsed.meta.iv !== "string"
  ) {
    throw new Error("云端同步文件格式异常（缺少有效的 meta/payload，可能被手工修改或损坏）");
  }
  return parsed;
};

/** 下载单个 Gist 文件并解析为 SyncedFile；截断时经 Rust 拉 raw_url 兜底 */
async function parseSyncedFileFromGistFile(
  accessToken: string,
  file: GitHubGistFile | undefined,
): Promise<SyncedFile | null> {
  if (!file) return null;

  if (gistFileNeedsRawFetch(file)) {
    if (!file.raw_url) {
      throw new Error("同步文件被截断且没有 raw_url，内容可能超出 Gist 大小限制");
    }
    return parseSyncedFile(
      await invoke<string>("github_gist_raw_content", { accessToken, rawUrl: file.raw_url }),
    );
  }

  if (!file.content) return null;
  try {
    return parseSyncedFile(file.content);
  } catch (error) {
    // #2643 防御路径：内嵌 JSON 不完整但 truncated 未标记
    if (error instanceof SyntaxError && file.raw_url) {
      return parseSyncedFile(
        await invoke<string>("github_gist_raw_content", { accessToken, rawUrl: file.raw_url }),
      );
    }
    throw error;
  }
}

/** 下载同步文件；Gist 不存在返回 null */
export async function downloadSyncGist(accessToken: string, gistId: string): Promise<SyncedFile | null> {
  const res = await fetchWithRetry(
    `${SYNC_CONSTANTS.GITHUB_API_BASE}/gists/${gistId}`,
    { headers: authHeaders(accessToken) },
    "下载同步文件",
  );
  if (res.status === 404) return null;
  const gist = await gistResponse<GitHubGist>(res, "下载同步文件");
  return parseSyncedFileFromGistFile(accessToken, gist.files[SYNC_CONSTANTS.SYNC_FILE_NAME]);
}

/** 删除同步 Gist（断开/重置用） */
export async function deleteSyncGist(accessToken: string, gistId: string): Promise<void> {
  const res = await fetchWithRetry(
    `${SYNC_CONSTANTS.GITHUB_API_BASE}/gists/${gistId}`,
    { method: "DELETE", headers: authHeaders(accessToken) },
    "删除同步 Gist",
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`删除同步 Gist 失败: ${res.status} ${res.statusText}`);
  }
}

/** Gist 自带的修订历史（可用于版本回滚），按时间倒序 */
export async function getGistHistory(
  accessToken: string,
  gistId: string,
): Promise<Array<{ version: string; date: Date }>> {
  const res = await fetchWithRetry(
    `${SYNC_CONSTANTS.GITHUB_API_BASE}/gists/${gistId}`,
    { headers: authHeaders(accessToken) },
    "获取 Gist 历史",
  );
  const gist = await gistResponse<GitHubGist>(res, "获取 Gist 历史");
  return (gist.history ?? []).map((h) => ({ version: h.version, date: new Date(h.committed_at) }));
}

/** 下载指定历史修订的同步文件（GET /gists/{id}/{sha}），同样处理截断兜底；无该文件返回 null */
export async function downloadGistRevision(
  accessToken: string,
  gistId: string,
  sha: string,
): Promise<SyncedFile | null> {
  const res = await fetchWithRetry(
    `${SYNC_CONSTANTS.GITHUB_API_BASE}/gists/${gistId}/${sha}`,
    { headers: authHeaders(accessToken) },
    "下载历史修订",
  );
  if (res.status === 404) return null;
  const gist = await gistResponse<GitHubGist>(res, "下载历史修订");
  return parseSyncedFileFromGistFile(accessToken, gist.files[SYNC_CONSTANTS.SYNC_FILE_NAME]);
}
