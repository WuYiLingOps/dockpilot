import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Copy, X } from "lucide-react";
import type { ComposeOutput } from "../../types/compose";
import { copyText } from "../../lib/clipboard";
import { IconButton, Spinner, cn } from "../ui";

/**
 * compose CLI 输出面板：流式行渲染 + 贴底跟随 + 折叠/复制/取消。
 * 展示 useComposeRun 的 lines 缓冲与 result 终态。
 */
export function OutputPanel({
  label,
  lines,
  running,
  result,
  onCancel,
  onClose,
  className,
}: {
  label: string;
  lines: ComposeOutput[];
  running: boolean;
  result: { code: number | null; error: string | null } | null;
  onCancel?: () => void;
  onClose?: () => void;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // 用户上滚即暂停跟随，滚回底部恢复
  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines, collapsed]);

  const copyAll = () => {
    void copyText(lines.map((l) => l.data).join("\n"));
  };

  const failed = !running && (result?.error != null || (result?.code != null && result.code !== 0));

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]",
        className,
      )}
      data-no-drag
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel2/60 px-3">
        {running ? <Spinner className="h-3.5 w-3.5" /> : (
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              failed ? "bg-err" : "bg-ok",
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg2">
          {label}
          {running ? " · 进行中…" : failed ? " · 已失败" : " · 已完成"}
        </span>
        {running && onCancel && (
          <IconButton title="取消操作" onClick={onCancel}>
            <X size={14} />
          </IconButton>
        )}
        <IconButton title="复制输出" onClick={copyAll}>
          <Copy size={14} />
        </IconButton>
        <IconButton
          title={collapsed ? "展开" : "折叠"}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </IconButton>
        {onClose && !running && (
          <IconButton title="关闭" onClick={onClose}>
            <X size={14} />
          </IconButton>
        )}
      </div>
      {!collapsed && (
        <div
          ref={boxRef}
          onScroll={onScroll}
          className="max-h-56 min-h-24 flex-1 overflow-auto bg-canvas px-3 py-2 font-mono text-[11.5px] leading-5"
        >
          {lines.length === 0 ? (
            <div className="text-fg3">等待输出…</div>
          ) : (
            lines.map((l, i) => (
              <div
                key={i}
                className={cn(
                  "break-all whitespace-pre-wrap",
                  l.stream === "err" ? "text-err/90" : "text-fg2",
                )}
              >
                {l.data}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
