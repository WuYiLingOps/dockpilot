import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from "react";

const win = getCurrentWindow();

// 可交互元素不参与窗口拖拽
const INTERACTIVE = "button, input, select, textarea, a, label, [data-no-drag]";

function handlePointerDown(e: ReactPointerEvent) {
  if (e.button !== 0) return;
  const el = e.target as HTMLElement | null;
  if (el?.closest(INTERACTIVE)) return;
  // 双击标题栏区域切换最大化
  if (e.detail === 2) {
    void win.toggleMaximize();
    return;
  }
  void win.startDragging();
}

/** 展开到容器上，使整个区域成为可拖拽标题栏（子交互元素自动豁免） */
export function withDragRegion<T extends SyntheticEvent>(handlers?: {
  onPointerDown?: (e: T) => void;
}): { onPointerDown: (e: T) => void } {
  return {
    onPointerDown: (e: T) => {
      handlePointerDown(e as unknown as ReactPointerEvent);
      handlers?.onPointerDown?.(e);
    },
  };
}
