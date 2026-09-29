import type { ReactNode } from "react";

/** 设置分组卡片（设置弹窗与各分组组件共用的 markup） */
export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
      <div className="border-b border-edge/60 bg-panel2/40 px-4 py-2.5 text-[13px] font-semibold text-fg">
        {title}
      </div>
      <div className="divide-y divide-edge/60">{children}</div>
    </section>
  );
}

/** 设置行：左 label/desc + 右控件 */
export function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-13 items-center justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] text-fg">{label}</div>
        {desc && <div className="mt-0.5 text-[11px] leading-4 text-fg3">{desc}</div>}
      </div>
      <div className="shrink-0" data-no-drag>
        {children}
      </div>
    </div>
  );
}
