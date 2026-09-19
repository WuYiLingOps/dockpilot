import { X } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { useEffect } from "react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "ghost" | "outline" | "danger";

const buttonStyles: Record<ButtonVariant, string> = {
  primary: "bg-emerald-500 text-zinc-950 hover:bg-emerald-400",
  ghost: "text-zinc-300 hover:bg-panel2 hover:text-zinc-100",
  outline: "border border-edge text-zinc-300 hover:bg-panel2 hover:text-zinc-100",
  danger: "bg-rose-500/90 text-white hover:bg-rose-500",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "ghost", className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
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
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-panel2 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export function Badge({ tone = "zinc", children }: { tone?: string; children: ReactNode }) {
  const tones: Record<string, string> = {
    emerald: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    sky: "bg-sky-500/15 text-sky-400 border-sky-500/25",
    amber: "bg-amber-500/15 text-amber-400 border-amber-500/25",
    rose: "bg-rose-500/15 text-rose-400 border-rose-500/25",
    zinc: "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium",
        tones[tone] ?? tones.zinc,
      )}
    >
      {children}
    </span>
  );
}

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
  running: "emerald",
  paused: "amber",
  restarting: "amber",
  created: "sky",
  exited: "zinc",
  dead: "rose",
  removing: "rose",
};

export function StateBadge({ state }: { state: string }) {
  return (
    <Badge tone={STATE_TONE[state] ?? "zinc"}>
      {STATE_LABEL[state] ?? (state || "未知")}
    </Badge>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 rounded-lg border border-edge bg-panel px-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30",
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
    <select
      className={cn(
        "h-9 rounded-lg border border-edge bg-panel px-2.5 text-sm text-zinc-200 outline-none focus:border-emerald-500/50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
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
    <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-sm text-zinc-400">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-emerald-500"
      />
      {label}
    </label>
  );
}

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-edge bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
          <IconButton title="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="text-sm text-zinc-300">{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent",
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
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-zinc-600">{icon}</div>}
      <div className="text-sm font-medium text-zinc-400">{title}</div>
      {desc && <div className="text-xs text-zinc-500">{desc}</div>}
    </div>
  );
}

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
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-6 py-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">{title}</h1>
        {desc && <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
      <div className="max-w-lg break-all text-center text-sm text-rose-400">{message}</div>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}
