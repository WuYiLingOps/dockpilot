import { getCurrentWindow } from "@tauri-apps/api/window";
import { Moon, PanelLeftClose, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme, type ThemeMode } from "../lib/theme";
import { withDragRegion } from "../lib/drag";
import { IconButton } from "./ui";

const win = getCurrentWindow();

/** Windows 经典窗口按钮：细线减号 / 方框 / 叉号，固定在窗口右上角。
 *  z-50 压过内容区的 DisconnectedOverlay（z-40）——Windows 版启动即处于
 *  未连接态，按钮若低于遮罩会永远不可见；模态弹窗挂在 body 且同为 z-50、
 *  DOM 靠后，仍然盖过本组件 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized).catch(() => {});
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  return (
    <div className="absolute right-0 top-0 z-50 flex h-11 items-stretch" data-no-drag>
      <button
        type="button"
        title="最小化"
        aria-label="最小化"
        onClick={() => void win.minimize()}
        className="flex w-11 items-center justify-center text-fg2 transition-colors hover:bg-hover hover:text-fg"
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
          <path d="M2 6h8" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        onClick={() => void win.toggleMaximize()}
        className="flex w-11 items-center justify-center text-fg2 transition-colors hover:bg-hover hover:text-fg"
      >
        {maximized ? (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
            <path
              d="M4 2.5h5.5V8M2.5 4h5.5V9.5H2.5z"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
            <rect x="2.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        title="关闭"
        aria-label="关闭"
        onClick={() => void win.close()}
        className="flex w-11 items-center justify-center text-fg2 transition-colors hover:bg-err hover:text-white"
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
          <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1" />
        </svg>
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

function BrandMark() {
  return (
    <div className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent">
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
        <path d="M12 2a10 10 0 1 0 10 10h-3.2A6.8 6.8 0 1 1 12 5.2V2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </div>
  );
}

/**
 * 侧栏顶部 44px 区域：应用名 + 主题切换 + 收起按钮。
 * 整块可拖拽（按钮豁免），双击切换最大化。
 * 收起态退化为居中 logo 图标栏，主题切换移到 logo 下方一行。
 */
export function SidebarTopBar({
  collapsed = false,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  if (collapsed) {
    return (
      <>
        <div
          {...withDragRegion()}
          className="flex h-11 shrink-0 items-center justify-center"
        >
          <BrandMark />
        </div>
        <div className="flex shrink-0 justify-center pb-1">
          <ThemeToggle />
        </div>
      </>
    );
  }
  return (
    <div
      {...withDragRegion()}
      className="flex h-11 shrink-0 items-center gap-2.5 px-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <BrandMark />
        <span className="truncate text-[13px] font-semibold text-fg">DockPilot</span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
        {onToggleCollapse && (
          <IconButton title="收起侧栏" aria-label="收起侧栏" onClick={onToggleCollapse}>
            <PanelLeftClose size={15} />
          </IconButton>
        )}
      </div>
    </div>
  );
}
