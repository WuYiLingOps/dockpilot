import { Plus, X, type LucideIcon } from "lucide-react";
import type { KeyValueSpec } from "../../types/docker";
import { Button, IconButton, Input, cn } from "../../components/ui";

/** 卷/网络名称约束，与后端 conn.rs 的校验一致 */
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function formatDateTime(s: string | null): string {
  if (!s) return "-";
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? s : t.toLocaleString();
}

/* ---------------------------------------------------------------- */
/* 页内小组件（与 Overview 的 Card/InfoRow/StatCell 同风格）            */
/* ---------------------------------------------------------------- */

export function Panel({
  icon: Icon,
  title,
  extra,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  extra?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge/60 px-4 py-2.5 text-[12px] font-medium text-fg2">
        <Icon size={13} className="text-fg3" />
        {title}
        {extra && <div className="ml-auto flex items-center gap-2">{extra}</div>}
      </div>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </section>
  );
}

export function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-[3px]">
      <span className="w-20 shrink-0 text-right text-[12px] text-fg3">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-[12px] text-fg">{value}</span>
    </div>
  );
}

export function StatCell({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[12px] text-fg3">
        {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
        {label}
      </div>
      <div className="mt-0.5 truncate text-[16px] font-semibold tabular-nums text-fg">{value}</div>
      {sub && <div className="truncate text-[11px] text-fg3">{sub}</div>}
    </div>
  );
}

/** 标签键值对编辑行（与容器创建弹窗的交互一致） */
export function KVEditor({
  rows,
  onChange,
}: {
  rows: KeyValueSpec[];
  onChange: (rows: KeyValueSpec[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            className="h-7 flex-1 font-mono text-[12px]"
            placeholder="键"
            value={r.key}
            onChange={(e) =>
              onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
            }
          />
          <Input
            className="h-7 flex-1 font-mono text-[12px]"
            placeholder="值"
            value={r.value}
            onChange={(e) =>
              onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
            }
          />
          <IconButton
            title="移除标签"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X size={13} />
          </IconButton>
        </div>
      ))}
      <Button
        variant="ghost"
        className="h-7 px-2 text-[12px]"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus size={13} />
        添加标签
      </Button>
    </div>
  );
}
