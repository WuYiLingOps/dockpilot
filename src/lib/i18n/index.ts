/**
 * 界面语言（zh/en）的模块级 store，机制仿 lib/theme.ts。
 *
 * 持久化源头是设置文件的 settings.language（"system" | "zh" | "en"）；
 * localStorage["dockpilot.lang"] 只存解析结果（zh/en）供首帧防闪烁
 * （index.html 内联脚本读取）。语言的应用入口是 syncLangFromSettings：
 * 设置加载/变更后由 useSettingsLangSync 调用，一次性完成内存切换、
 * 首帧缓存、html lang、窗口标题与后端上报（"system" 的解析结果只有
 * 前端知道，后端错误消息/托盘/通知都使用上报值）。
 */
import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../api";
import { zh, type MsgKey } from "./zh";
import { en } from "./en";

export type Lang = "zh" | "en";

const BOOT_CACHE_KEY = "dockpilot.lang";
const DICTS: Record<Lang, Record<MsgKey, string>> = { zh, en };
const listeners = new Set<() => void>();

let lang: Lang = loadBootCache();
/** 是否已按设置完成过一次同步（未同步前 t() 用的是首帧缓存的语言） */
let synced = false;

function loadBootCache(): Lang {
  try {
    const v = localStorage.getItem(BOOT_CACHE_KEY);
    if (v === "zh" || v === "en") return v;
  } catch {
    // 隐私模式等 localStorage 不可用场景，按系统语言解析
  }
  return resolveLang("system");
}

/** settings.language → 界面语言："system" 按 navigator.language 解析（node/异常环境回落中文） */
export function resolveLang(setting: string): Lang {
  if (setting === "zh" || setting === "en") return setting;
  let sys = "";
  try {
    sys = typeof navigator !== "undefined" ? String(navigator.language ?? "") : "";
  } catch {
    // 无 navigator 的环境按基准语言处理
  }
  if (!sys) return "zh";
  return sys.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** {name} 占位符插值：未提供的占位符原样保留（与后端 i18n.rs 同构） */
export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}

function emit() {
  listeners.forEach((l) => l());
}

/** 当前语言下的文案（非 React 场景直接调用；组件内用 useT 保证语言切换重渲染） */
export function t(key: MsgKey, params?: Record<string, string | number>): string {
  const template = DICTS[lang][key];
  return params ? interpolate(template, params) : template;
}

export type TFunc = typeof t;

/** 把解析后的语言应用到内存 + 首帧缓存 + 文档（html lang 与标题）+ 原生窗口标题 */
function applyLang(next: Lang) {
  lang = next;
  try {
    localStorage.setItem(BOOT_CACHE_KEY, next);
  } catch {
    // 忽略持久化失败
  }
  try {
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    document.title = t("app.title");
  } catch {
    // node 环境（单测）无 document，忽略
  }
  getCurrentWindow()
    .setTitle(t("app.title"))
    .catch(() => {
      // 浏览器预览等无原生窗口的环境，忽略
    });
  emit();
}

/**
 * 设置加载/变更后的同步入口：解析语言，变化时应用并上报后端。
 * 上报失败仅忽略——后端按 settings.language 解析（"system" 默认中文）
 */
export function syncLangFromSettings(setting: string) {
  const next = resolveLang(setting);
  const first = !synced;
  synced = true;
  if (next !== lang || first) {
    applyLang(next);
    void api.setUiLanguage(next).catch(() => {});
  }
}

/** 语言变化的 React 订阅：组件内 const t = useT()，切换语言时自动重渲染 */
export function useT(): TFunc {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
  );
  return t;
}

/** 读取当前语言值（供 useMemo/useCallback 把语言纳入依赖，切换时重算） */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
  );
}
