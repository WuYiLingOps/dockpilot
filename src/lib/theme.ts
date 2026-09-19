import { useCallback, useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";

const KEY = "dockpilot.theme";
const listeners = new Set<() => void>();

let mode: ThemeMode = load();

function load(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
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

export function setThemeMode(next: ThemeMode) {
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 忽略持久化失败
  }
  apply();
  emit();
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
