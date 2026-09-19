import { ChevronDown, X } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { useEffect } from "react";
import { withDragRegion } from "../lib/drag";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------------------------------------------------------------- */
/* Button — macOS 四型：accent 实底 / tinted 浅底 / ghost 素色 /      */
/* outline 描边，danger 为红色实底。默认高度 32px。                  */
/* ---------------------------------------------------------------- */

type ButtonVariant = "primary" | "tinted" | "ghost" | "outline" | "danger";

const buttonStyles: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent/90 active:bg-accent/80",
  tinted: "bg-accent/10 text-accent hover:bg-accent/15 active:bg-accent/20",
  ghost: "text-fg2 hover:bg-hover hover:text-fg active:bg-hover",
  outline:
    "border border-edge-strong bg-panel text-fg hover:bg-hover active:bg-panel2",
  danger: "bg-err text-white hover:bg-err/90 active:bg-err/80",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "ghost", className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-btn px-2.5 text-[13px] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40",
        buttonStyles[variant],
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({
  className,
  title,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-btn text-fg3 transition-colors duration-150 hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

/* ---------------------------------------------------------------- */
/* 状态 — 圆点 + 文字（OrbStack 主视觉），Badge 仅保留给端口等标签      */
/* ---------------------------------------------------------------- */

const STATE_LABEL: Record<string, string> = {
  running: "运行中",
  exited: "已退出",
  paused: "已暂停",
  created: "已创建",
  restarting: "重启中",
  removing: "移除中",
  dead: "已死亡",
};

const STATE_TONE: Record<string, string> = {
  running: "ok",
  paused: "warn",
  restarting: "warn",
  created: "accent",
  exited: "fg3",
  dead: "err",
  removing: "err",
};

export function statusColor(state: string): string {
  const tone = STATE_TONE[state] ?? "fg3";
  return { ok: "bg-ok", warn: "bg-warn", accent: "bg-accent", err: "bg-err", fg3: "bg-fg3" }[tone] ?? "bg-fg3";
}

export function statusText(state: string): string {
  return STATE_LABEL[state] ?? (state || "未知");
}

export function StatusDot({
  state,
  className,
}: {
  state: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("h-2 w-2 shrink-0 rounded-full", statusColor(state), className)}
    />
  );
}

export function StateBadge({ state }: { state: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg2">
      <StatusDot state={state} />
      {statusText(state)}
    </span>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "accent" | "ok" | "warn" | "err";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-fg3/10 text-fg2",
    accent: "bg-accent/10 text-accent",
    ok: "bg-ok/10 text-ok",
    warn: "bg-warn/10 text-warn",
    err: "bg-err/10 text-err",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
        tones[tone] ?? tones.neutral,
      )}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- */
/* 表单控件                                                          */
/* ---------------------------------------------------------------- */

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-8 rounded-ctl border border-edge-strong bg-panel px-2.5 text-[13px] text-fg outline-none transition-shadow placeholder:text-fg3 focus:border-accent focus:ring-[3px] focus:ring-accent/25",
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn("relative", className)}>
      <select
        className="h-8 w-full appearance-none rounded-ctl border border-edge-strong bg-panel pl-2.5 pr-7 text-[13px] text-fg outline-none transition-shadow focus:border-accent focus:ring-[3px] focus:ring-accent/25"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-fg3"
      />
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[13px] text-fg2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-accent"
      />
      {label}
    </label>
  );
}

/* ---------------------------------------------------------------- */
/* 分段控件 — 详情页 Tab                                             */
/* ---------------------------------------------------------------- */

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-ctl bg-panel2 p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn(
            "h-6.5 rounded-[5px] px-3 text-[12px] font-medium transition-colors duration-150",
            value === o.key
              ? "bg-panel text-fg shadow-sm"
              : "text-fg2 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 反馈与覆盖层                                                       */
/* ---------------------------------------------------------------- */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="animate-fade fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="animate-pop w-full max-w-md rounded-xl border border-edge bg-panel p-5 shadow-[var(--app-shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
          <IconButton title="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="text-[13px] text-fg2">{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-fg3/60 border-t-transparent",
        className,
      )}
    />
  );
}

export function EmptyState({
  icon,
  title,
  desc,
}: {
  icon?: ReactNode;
  title: string;
  desc?: string;
}) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-1.5 p-8 text-center">
      {icon && <div className="mb-2 text-fg3/70">{icon}</div>}
      <div className="text-[13px] font-medium text-fg2">{title}</div>
      {desc && <div className="max-w-sm text-xs text-fg3">{desc}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 工具栏（页面头）— 兼作可拖拽标题栏延伸                              */
/* ---------------------------------------------------------------- */

export function PageHeader({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div
      {...withDragRegion()}
      className="flex h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-edge bg-panel px-4"
    >
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="truncate text-[15px] font-semibold text-fg">{title}</h1>
        {desc && <p className="hidden truncate text-xs text-fg3 md:block">{desc}</p>}
      </div>
      {children && (
        <div className="flex flex-wrap items-center gap-2" data-no-drag>
          {children}
        </div>
      )}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
      <div className="max-w-lg break-all text-center text-[13px] text-err">{message}</div>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}
