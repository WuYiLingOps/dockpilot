/**
 * 应用自身日志（DockPilot 运行日志）的前端写入与全局错误兜底。
 * 写入经 @tauri-apps/plugin-log 落到与 Rust 侧同一份日志文件（target=webview），
 * 供设置 → 故障诊断的「使用日志查看器」浏览。
 */
import { error as pluginError, info as pluginInfo, warn as pluginWarn } from "@tauri-apps/plugin-log";

function normalize(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export const applog = {
  info: (msg: string) => void pluginInfo(msg).catch(() => {}),
  warn: (msg: string) => void pluginWarn(msg).catch(() => {}),
  error: (msg: string) => void pluginError(msg).catch(() => {}),
  /** 未知类型错误的统一记录入口 */
  errorOf: (prefix: string, e: unknown) => void pluginError(`${prefix}: ${normalize(e)}`).catch(() => {}),
};

/**
 * 全局兜底：未捕获的同步异常与 Promise 拒绝。
 * main.tsx 中调用一次；同一消息只记一次，避免循环抛错时刷爆日志。
 */
export function installGlobalErrorHandlers() {
  let lastMessage = "";
  const remember = (msg: string) => {
    if (msg === lastMessage) return false;
    lastMessage = msg;
    return true;
  };
  window.addEventListener("error", (e) => {
    const msg = `未捕获异常: ${e.message} (${e.filename}:${e.lineno})`;
    if (remember(msg)) applog.error(msg);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const msg = `未处理的 Promise 拒绝: ${normalize(e.reason)}`;
    if (remember(msg)) applog.error(msg);
  });
}

/* ---------------------------------------------------------------- */
/* 查看器打开信号：横幅（App）与诊断卡片（设置）共用，由 App 挂载查看器  */
/* ---------------------------------------------------------------- */

type ViewerListener = () => void;
const viewerListeners = new Set<ViewerListener>();

export function onOpenAppLogViewer(cb: ViewerListener): () => void {
  viewerListeners.add(cb);
  return () => viewerListeners.delete(cb);
}

export function openAppLogViewer() {
  viewerListeners.forEach((cb) => cb());
}
