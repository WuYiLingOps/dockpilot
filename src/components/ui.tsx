import { Check, ChevronDown, RefreshCw, Search, X } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { useEffect, useRef } from "react";
import { withDragRegion } from "../lib/drag";
import { t, useT } from "../lib/i18n";
import type { MsgKey } from "../lib/i18n/zh";
import type { PortDto } from "../types/docker";

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

export function Button({ variant = "ghost", className, type = "button", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-btn px-2.5 text-[13px] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40",
        buttonStyles[variant],
        className,
      )}
      type={type}
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

const STATE_KEYS: Record<string, MsgKey> = {
  running: "state.running",
  exited: "state.exited",
  paused: "state.paused",
  created: "state.created",
  restarting: "state.restarting",
  removing: "state.removing",
  dead: "state.dead",
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
  const key = STATE_KEYS[state];
  return key ? t(key) : state || t("state.unknown");
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
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-fg2">
      <StatusDot state={state} />
      {statusText(state)}
    </span>
  );
}

/** 健康检查状态：文案与色调的单一来源（列表徽标、详情卡片共用）。未知状态回落原值 */
export function healthMeta(health: string): {
  tone: "ok" | "warn" | "err";
  label: string;
  title: string;
} {
  switch (health) {
    case "healthy":
      return { tone: "ok", label: t("health.healthy"), title: t("health.healthyTitle") };
    case "unhealthy":
      return { tone: "err", label: t("health.unhealthy"), title: t("health.unhealthyTitle") };
    case "starting":
      return { tone: "warn", label: t("health.starting"), title: t("health.startingTitle") };
    default:
      return { tone: "warn", label: health, title: health };
  }
}

const KNOWN_HEALTH = new Set(["healthy", "unhealthy", "starting"]);

/** 健康检查徽标：着色小圆片，与 compose 项目徽标同视觉语言，置于容器名旁 */
export function HealthBadge({ health }: { health: string }) {
  // 未知状态不渲染徽标（与 HEALTH_META 缺项返回 null 的历史行为一致）
  if (!KNOWN_HEALTH.has(health)) return null;
  const meta = healthMeta(health);
  return (
    <span
      aria-label={meta.title}
      title={meta.title}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium leading-4",
        meta.tone === "ok" && "bg-ok/10 text-ok",
        meta.tone === "warn" && "bg-warn/10 text-warn",
        meta.tone === "err" && "bg-err/10 text-err",
      )}
    >
      {meta.label}
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

/** 端口徽章：最多展示 2 个，多余合并为 +N */
export function PortChips({ ports }: { ports: PortDto[] }) {
  if (ports.length === 0) return <span className="text-fg3">—</span>;
  const chips = ports.slice(0, 2).map((p, i) => (
    <Badge key={`${p.public_port}-${p.private_port}-${i}`}>
      <span className="font-mono">
        {p.public_port != null ? `${p.public_port}→${p.private_port}` : p.private_port}
      </span>
    </Badge>
  ));
  const more = ports.length > 2 ? <span className="text-[11px] text-fg3">+{ports.length - 2}</span> : null;
  return (
    <div className="flex items-center gap-1" title={ports.map((p) => (p.public_port != null ? `${p.public_port}→${p.private_port}` : `${p.private_port}`)).join("  ")}>
      {chips}
      {more}
    </div>
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

/** 列表页统一搜索框：页头使用，输入即过滤当前列表 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("relative", className)}>
      <Search
        size={13}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg3"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t("common.search")}
        data-no-drag
        className={cn(
          "h-8 w-full rounded-ctl border border-edge-strong bg-panel pl-7 pr-7 text-[13px] text-fg outline-none transition-shadow placeholder:text-fg3 focus:border-accent focus:ring-[3px] focus:ring-accent/25",
          value && "pr-7",
        )}
      />
      {value && (
        <button
          type="button"
          aria-label={t("common.clearSearch")}
          data-no-drag
          onClick={() => onChange("")}
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-fg3 transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={12} />
        </button>
      )}
    </div>
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
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  // 单一 button 承载点击（CheckDot 退化为纯视觉圆点）：
  // 不能用 label 包裹可交互 button——WebKitGTK 下点击圆点会同时触发
  // button 激活与 label 转发，状态切换两次等于没切
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      title={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex select-none items-center gap-1.5 text-[13px] text-fg2",
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
      )}
    >
      <CheckDot checked={checked} disabled={disabled} />
      {label}
    </button>
  );
}

/** 滑动开关（布尔设置的开关语义，Checkbox 的替代样式；禁用时降透明度且不可点） */
export function Switch({
  checked,
  disabled,
  title,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5.5 w-10 shrink-0 select-none items-center rounded-full transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-40",
        checked
          ? "bg-accent hover:bg-accent/90"
          : "border border-edge-strong bg-panel2 hover:bg-hover",
      )}
    >
      <span
        className={cn(
          "absolute inline-block h-4.5 w-4.5 rounded-full transition-[left] duration-150",
          checked ? "left-[calc(100%-1.25rem)] bg-on-accent" : "left-0.75 bg-fg3",
        )}
      />
    </button>
  );
}

/**
 * 圆形对勾指示器：未选 = 空心圆环（悬停描边变蓝），选中 = 蓝色实心圆 + 白勾。
 * 传 onClick 时自身是可点的 checkbox 按钮；不传时为纯展示（嵌入整行可点的卡片/表格行，
 * 点击行为由外层处理）。
 */
export function CheckDot({
  checked,
  disabled,
  title,
  onClick,
}: {
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const dot = (
    <span
      className={cn(
        "flex h-4.5 w-4.5 items-center justify-center rounded-full border-2 transition-colors",
        disabled
          ? "border-edge/60 bg-panel"
          : checked
            ? "border-accent bg-accent"
            : "border-edge-strong bg-panel hover:border-accent/60",
      )}
    >
      {checked && <Check size={11} strokeWidth={3.5} className="text-on-accent" />}
    </span>
  );
  if (!onClick) return <span className="shrink-0">{dot}</span>;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      onClick={onClick}
      className="shrink-0 disabled:cursor-not-allowed"
    >
      {dot}
    </button>
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
  size = "md",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** md：普通确认/输入弹窗；lg：宽表单弹窗（创建容器等） */
  size?: "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const t = useT();
  if (!open) return null;
  return (
    <div
      className="animate-fade fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className={cn(
          "animate-pop w-full rounded-xl border border-edge bg-panel p-5 shadow-[var(--app-shadow)]",
          size === "md" ? "max-w-md" : "max-w-2xl",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
          <IconButton title={t("common.close")} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="text-[13px] text-fg2">{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* RefreshIcon — 页头刷新图标。激活时匀速旋转；停止时从当前角度      */
/* 缓动补完剩余角度回正（CSS animate-spin 停止时会从中途角度瞬跳回 0°）*/
/* ---------------------------------------------------------------- */

/** 匀速一整圈的时长（ms） */
const REFRESH_SPIN_MS = 900;
/** 停止时补完剩余角度的缓动时长（ms） */
const REFRESH_SETTLE_MS = 450;

export function RefreshIcon({
  spinning,
  size = 15,
  className,
}: {
  spinning: boolean;
  size?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const angleRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    // 减弱动态效果时保持静止
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!spinning) {
      const from = angleRef.current % 360;
      if (from === 0) return;
      // 停止：从当前角度转完这一圈（剩余角度 ease-out），结束后回正
      const start = performance.now();
      const delta = 360 - from;
      cancelAnimationFrame(rafRef.current);
      const settle = (now: number) => {
        const t = Math.min(1, Math.max(0, now - start) / REFRESH_SETTLE_MS);
        const eased = 1 - (1 - t) ** 3;
        angleRef.current = t < 1 ? from + delta * eased : 0;
        if (ref.current) ref.current.style.transform = `rotate(${angleRef.current}deg)`;
        if (t < 1) rafRef.current = requestAnimationFrame(settle);
      };
      rafRef.current = requestAnimationFrame(settle);
      return () => cancelAnimationFrame(rafRef.current);
    }
    // 启动/重启：按帧间隔增量累加角度，从当前角度无缝续转
    // （rAF 帧时间戳可能早于 effect 执行时刻，dt 钳制为非负避免首帧回跳）
    cancelAnimationFrame(rafRef.current);
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.max(0, now - last);
      last = now;
      angleRef.current = (angleRef.current + (dt / REFRESH_SPIN_MS) * 360) % 360;
      if (ref.current) ref.current.style.transform = `rotate(${angleRef.current}deg)`;
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [spinning]);

  return (
    <span ref={ref} className={cn("inline-flex will-change-transform", className)}>
      <RefreshCw size={size} />
    </span>
  );
}

export function Spinner({
  className,
  color = "border-fg3/60",
}: {
  className?: string;
  /** border 颜色类（与默认色互斥，不能靠 className 追加覆盖） */
  color?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-t-transparent",
        color,
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
      className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-edge bg-panel py-1 pl-4 pr-0"
    >
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="truncate text-[15px] font-semibold text-fg" title={title}>
          {title}
        </h1>
        {desc && <p className="hidden truncate text-xs text-fg3 md:block">{desc}</p>}
      </div>
      {children && (
        <div
          className="mr-[8.25rem] flex max-w-full grow flex-wrap items-center justify-end gap-2"
          data-no-drag
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
      <div className="max-w-lg break-all text-center text-[13px] text-err">{message}</div>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}
