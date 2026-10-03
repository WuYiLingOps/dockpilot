/**
 * 应用更新的模块级 store：启动/手动检查、下载更新包与状态机。
 * 发现新版本不打扰使用（不弹 toast），统一在设置「关于 → 软件更新」展示与操作。
 * 模块级单例模式仿 lib/sync/engine.ts；localStorage 读写仿 lib/theme.ts（隐私模式降级）。
 */
import { useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { api } from "./api";
import { applog } from "./applog";
import type { AppUpdateInfo } from "../types/appUpdate";

// ---------------------------------------------------------------------------
// 纯函数（vitest node 环境直接覆盖）
// ---------------------------------------------------------------------------

/** 启动检查节流间隔：24h（GitHub 匿名限额 60 次/时/IP，远低于上限） */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 手动检查「已是最新版本」提示的停留时长，超时回 idle 避免设置页残留状态 */
export const UP_TO_DATE_RESET_MS = 5000;

/** 启动检查是否需要发起：距上次检查超过 24h（或从未检查过） */
export function shouldRunStartupCheck(lastCheckAt: number | null, now: number): boolean {
  return lastCheckAt === null || now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// 状态机（单通道：检查 → 下载 → 拉起安装器；归约函数便于单测）
// ---------------------------------------------------------------------------

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "up-to-date"
  | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  /** 最近一次检查到的 release（无论是否有更新，供设置页展示） */
  latest: AppUpdateInfo | null;
  /** 仅手动检查的错误进入状态；启动检查失败静默回 idle */
  error: string | null;
  /** 上次检查成功时刻（本地毫秒时间戳，localStorage 持久化） */
  lastCheckAt: number | null;
  /** 下载进度（total 为 0 表示长度未知） */
  downloadProgress: { downloaded: number; total: number } | null;
  /** 已下载更新包的落盘路径（会话内有效；每次新下载前旧包会被清理） */
  downloadedPath: string | null;
}

export type AppUpdateEvent =
  | { type: "check-started" }
  | { type: "check-succeeded"; info: AppUpdateInfo; at: number; manual: boolean }
  | { type: "check-failed"; error: string; manual: boolean }
  | { type: "download-started" }
  | { type: "download-progress"; downloaded: number; total: number }
  | { type: "download-finished"; path: string }
  | { type: "download-failed" }
  | { type: "install-started" }
  | { type: "install-failed" }
  | { type: "reset" };

export function reduce(state: AppUpdateState, event: AppUpdateEvent): AppUpdateState {
  switch (event.type) {
    case "check-started":
      return { ...state, status: "checking", error: null };
    case "check-succeeded": {
      // 发现更新 → available（持续展示直到下次检查）；已是最新：手动检查显示
      // 「已是最新版本」5s 后回 idle，启动检查静默回 idle（仅更新 lastCheckAt）
      return {
        ...state,
        status: event.info.has_update ? "available" : event.manual ? "up-to-date" : "idle",
        latest: event.info,
        error: null,
        lastCheckAt: event.at,
      };
    }
    case "check-failed":
      // 启动检查静默：状态回 idle、错误不进 UI（日志由调用方记录）
      return event.manual
        ? { ...state, status: "error", error: event.error }
        : { ...state, status: "idle" };
    case "download-started":
      return { ...state, status: "downloading", downloadProgress: null, error: null };
    case "download-progress":
      return {
        ...state,
        downloadProgress: { downloaded: event.downloaded, total: event.total },
      };
    case "download-finished":
      return {
        ...state,
        status: "downloaded",
        downloadedPath: event.path,
        downloadProgress: null,
        error: null,
      };
    case "download-failed":
      // 回到 available 供重试，错误经 toast 呈现（调用方处理）
      return { ...state, status: "available", downloadProgress: null };
    case "install-started":
      return { ...state, status: "installing", error: null };
    case "install-failed":
      // 回到 downloaded 供重试（「应用更新」或「打开更新包」），错误经 toast 呈现
      return { ...state, status: "downloaded" };
    case "reset":
      return { ...state, status: "idle", error: null };
  }
}

// ---------------------------------------------------------------------------
// 模块级 store（快照引用仅在 notify 时更新，供 useSyncExternalStore）
// ---------------------------------------------------------------------------

const LAST_CHECK_KEY = "dockpilot.update.lastCheckAt";
/** Dto 缺 html_url 时的兜底链接 */
export const RELEASES_FALLBACK_URL = "https://github.com/WuYiLingOps/dockpilot/releases/latest";

function loadLastCheckAt(): number | null {
  try {
    const n = Number(localStorage.getItem(LAST_CHECK_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null; // 隐私模式等 localStorage 不可用场景
  }
}

const state: AppUpdateState = {
  status: "idle",
  latest: null,
  error: null,
  lastCheckAt: loadLastCheckAt(),
  downloadProgress: null,
  downloadedPath: null,
};

let snapshot: Readonly<AppUpdateState> = { ...state };
const listeners = new Set<() => void>();

export function getState(): Readonly<AppUpdateState> {
  return snapshot;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function apply(event: AppUpdateEvent): void {
  Object.assign(state, reduce(state, event));
  snapshot = { ...state };
  for (const listener of listeners) listener();
}

export function useAppUpdateStore(): Readonly<AppUpdateState> {
  return useSyncExternalStore(subscribe, getState, getState);
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 检查防重入锁：检查进行中忽略后续请求 */
let checking = false;
/** 下载防重入锁：下载进行中禁止新的检查与下载 */
let downloading = false;
/** 手动检查「已是最新」的自动回落定时器 */
let upToDateTimer: ReturnType<typeof setTimeout> | null = null;

function errText(e: unknown): string {
  // Tauri 命令的 Err(String) 以字符串 reject
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

/**
 * 检查更新。manual=false 为启动检查：失败静默（仅日志）、未发现更新不进 UI；
 * manual=true 为手动检查：失败进 error 态并 toast，「已是最新」5s 后自动回 idle。
 */
export async function checkNow(manual: boolean): Promise<void> {
  if (checking || downloading || getState().status === "installing") return;
  checking = true;
  if (upToDateTimer) {
    clearTimeout(upToDateTimer);
    upToDateTimer = null;
  }
  apply({ type: "check-started" });
  try {
    const info = await api.checkAppUpdate();
    const at = Date.now();
    try {
      localStorage.setItem(LAST_CHECK_KEY, String(at));
    } catch {
      // 忽略持久化失败
    }
    apply({ type: "check-succeeded", info, at, manual });
    if (manual && !info.has_update) {
      upToDateTimer = setTimeout(() => {
        upToDateTimer = null;
        apply({ type: "reset" });
      }, UP_TO_DATE_RESET_MS);
    }
  } catch (e) {
    const msg = errText(e);
    applog.warn(`检查应用更新失败: ${msg}`);
    apply({ type: "check-failed", error: msg, manual });
    if (manual) toast.error(msg, { duration: 10000 });
  } finally {
    checking = false;
  }
}

/** 下载当前平台更新包（进度进状态机），完成后自动按发行形态应用更新 */
export async function downloadAndOpen(): Promise<void> {
  if (downloading) return;
  const url = getState().latest?.download?.url;
  if (!url) {
    // 未匹配到当前平台附件：回落跳转 Releases 页
    openReleasePage();
    return;
  }
  downloading = true;
  apply({ type: "download-started" });
  try {
    const path = await api.downloadAppUpdate(url, (p) =>
      apply({ type: "download-progress", downloaded: p.downloaded, total: p.total }),
    );
    apply({ type: "download-finished", path });
    await installAppUpdate();
  } catch (e) {
    const msg = errText(e);
    applog.warn(`下载更新包失败: ${msg}`);
    apply({ type: "download-failed" });
    toast.error(msg, { duration: 10000 });
  } finally {
    downloading = false;
  }
}

/**
 * 自动应用已下载的更新包（下载完成后自动调用；失败后可经「应用更新」重试）。
 * Windows 安装版：NSIS 被动安装并自动重启；便携版：原位替换自身后拉起新版本。
 * Linux：deb 经 pkexec 授权安装，完成后自动重启。
 * 成功路径下应用会被关闭/重启，本函数通常不会返回到后续 UI 状态。
 */
export async function installAppUpdate(): Promise<void> {
  const path = getState().downloadedPath;
  if (!path) return;
  apply({ type: "install-started" });
  try {
    await api.installAppUpdate(path);
  } catch (e) {
    const msg = errText(e);
    applog.warn(`自动应用更新失败: ${msg}`);
    apply({ type: "install-failed" });
    toast.error(msg, { duration: 10000 });
  }
}

/** 拉起已下载的更新包（自动更新失败时的兜底；便携版返回手动替换指引） */
export async function openDownloadedInstaller(): Promise<void> {
  const path = getState().downloadedPath;
  if (!path) return;
  try {
    await api.openDownloadedUpdate(path);
  } catch (e) {
    toast.error(errText(e), { duration: 10000 });
  }
}

/** 打开最新 release 页（无匹配附件时的兜底出口） */
export function openReleasePage(): void {
  const url = getState().latest?.html_url || RELEASES_FALLBACK_URL;
  // 只放行 https，避免异常响应数据把其他 scheme 喂给系统打开器
  void openUrl(url.startsWith("https://") ? url : RELEASES_FALLBACK_URL).catch(() => {});
}
