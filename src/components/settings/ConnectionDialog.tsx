import { X } from "lucide-react";
import { useEffect } from "react";
import { IconButton } from "../ui";
import { ConnectionSettings } from "./ConnectionSettings";

/**
 * 连接管理弹窗：连接是「实体管理」（增删改测）而非偏好设置，
 * 从设置中独立出来；由侧栏底部「管理连接…」与断连引导页唤起。
 * 弹窗不改变当前页面，关闭后回到原上下文。
 */
export function ConnectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Esc 关闭；使用日志查看器在前台时让位（与设置弹窗同一约定）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector("[data-app-log-viewer]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="animate-fade fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="animate-pop flex h-[min(640px,100%)] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-edge bg-panel shadow-[var(--app-shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-4">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-fg">Docker 连接管理</h2>
            <p className="truncate text-[11px] text-fg3">
              添加 / 编辑 / 测试连接；点击列表中的连接即可切换（即时生效）
            </p>
          </div>
          <IconButton title="关闭（Esc）" onClick={onClose} data-no-drag>
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4" data-no-drag>
          <ConnectionSettings />
        </div>
      </div>
    </div>
  );
}
