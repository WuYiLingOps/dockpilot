import { useCallback, useSyncExternalStore } from "react";
import { api } from "./api";
import type { AppSettings } from "../types/settings";

export type ThemeMode = "system" | "light" | "dark";

/** 启动缓存：首帧前 index.html 内联脚本读取；持久化的源头是设置文件 */
const BOOT_CACHE_KEY = "dockpilot.theme";
const listeners = new Set<() => void>();

let mode: ThemeMode = loadBootCache();

function loadBootCache(): ThemeMode {
  try {
    const v = localStorage.getItem(BOOT_CACHE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // 隐私模式等 localStorage 不可用场景，回落 system
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function isDark(m: ThemeMode): boolean {
  return m === "dark" || (m === "system" && systemPrefersDark());
}

function apply() {
  const dark = isDark(mode);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function emit() {
  listeners.forEach((l) => l());
}

function setModeInternal(next: ThemeMode) {
  mode = next;
  apply();
  emit();
}

/** 仅同步内存状态，不触发持久化（设置加载后调用） */
export function syncThemeFromSettings(theme: string) {
  if (theme === "light" || theme === "dark" || theme === "system") {
    if (theme !== mode) setModeInternal(theme);
  }
}

/** 用户切换主题：更新内存 + 启动缓存 + 设置文件 */
export function setThemeMode(next: ThemeMode) {
  setModeInternal(next);
  try {
    localStorage.setItem(BOOT_CACHE_KEY, next);
  } catch {
    // 忽略持久化失败
  }
  // 合并当前设置后整包写回，避免覆盖其他设置项
  void (async () => {
    try {
      const s = await api.getSettings();
      await api.setSettings({ ...s, theme: next } satisfies AppSettings);
    } catch {
      // 设置文件不可写时主题仍然生效（内存 + 启动缓存）
    }
  })();
}

// 跟随系统实时切换
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (mode === "system") {
    apply();
    emit();
  }
});

// 模块加载即生效，避免首帧闪错色
apply();

export function useTheme() {
  const m = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => mode,
  );
  const setMode = useCallback((next: ThemeMode) => setThemeMode(next), []);
  return { mode: m, setMode, isDark: isDark(m) };
}
