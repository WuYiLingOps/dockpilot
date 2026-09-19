import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Moon, Square, Sun, X } from "lucide-react";
import { useTheme, type ThemeMode } from "../lib/theme";
import { withDragRegion } from "../lib/drag";

const win = getCurrentWindow();

/** macOS 红绿灯窗口控制（悬停显图标，OrbStack 同款位置：左上） */
function TrafficLights() {
  return (
    <div className="group/lights flex items-center gap-2" data-no-drag>
      <button
        type="button"
        title="关闭"
        onClick={() => win.close()}
        className="flex h-3 w-3 items-center justify-center rounded-full bg-[#ff5f57] text-transparent transition-colors hover:text-[#7d0000]/80"
      >
        <X size={8} strokeWidth={2.5} />
      </button>
      <button
        type="button"
        title="最小化"
        onClick={() => win.minimize()}
        className="flex h-3 w-3 items-center justify-center rounded-full bg-[#febc2e] text-transparent transition-colors hover:text-[#965a00]/80"
      >
        <Minus size={8} strokeWidth={2.5} />
      </button>
      <button
        type="button"
        title="最大化 / 还原"
        onClick={() => void win.toggleMaximize()}
        className="flex h-3 w-3 items-center justify-center rounded-full bg-[#28c840] text-transparent transition-colors hover:text-[#0a5a00]/80"
      >
        <Square size={7} strokeWidth={2.5} />
      </button>
    </div>
  );
}

const THEME_ORDER: ThemeMode[] = ["system", "light", "dark"];

function ThemeToggle() {
  const { mode, setMode, isDark } = useTheme();
  const next = () =>
    setMode(THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length]);
  const label = mode === "system" ? "跟随系统" : mode === "light" ? "亮色" : "暗色";
  return (
    <button
      type="button"
      title={`主题：${label}（点击切换）`}
      onClick={next}
      className="flex h-6 w-6 items-center justify-center rounded-btn text-fg3 transition-colors hover:bg-hover hover:text-fg"
    >
      {mode === "system" ? (
        <SunMoonGlyph isDark={isDark} />
      ) : mode === "light" ? (
        <Sun size={14} />
      ) : (
        <Moon size={14} />
      )}
    </button>
  );
}

function SunMoonGlyph({ isDark }: { isDark: boolean }) {
  return isDark ? <Moon size={14} /> : <Sun size={14} />;
}

/**
 * 侧栏顶部 44px 区域：红绿灯 + 应用名 + 主题切换。
 * 整块可拖拽（红绿灯与主题按钮豁免），双击切换最大化。
 */
export function SidebarTopBar() {
  return (
    <div
      {...withDragRegion()}
      className="flex h-11 shrink-0 items-center gap-3 px-4"
    >
      <TrafficLights />
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex h-5.5 w-5.5 items-center justify-center rounded-md bg-accent/12 text-accent">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
            <path d="M12 2a10 10 0 1 0 10 10h-3.2A6.8 6.8 0 1 1 12 5.2V2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </div>
        <span className="truncate text-[13px] font-semibold text-fg">DockPilot</span>
      </div>
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </div>
  );
}
