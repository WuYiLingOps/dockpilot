import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  Container,
  Image as ImageIcon,
  ScrollText,
  SquareTerminal,
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "./ui";

export type PageKey = "containers" | "images" | "logs" | "terminal" | "monitor";

const NAV: { key: PageKey; label: string; icon: typeof Boxes }[] = [
  { key: "containers", label: "容器", icon: Boxes },
  { key: "images", label: "镜像", icon: ImageIcon },
  { key: "logs", label: "日志", icon: ScrollText },
  { key: "terminal", label: "终端", icon: SquareTerminal },
  { key: "monitor", label: "监控", icon: Activity },
];

export function Sidebar({
  page,
  onChange,
}: {
  page: PageKey;
  onChange: (p: PageKey) => void;
}) {
  const { data: info } = useQuery({
    queryKey: ["dockerInfo"],
    queryFn: api.dockerInfo,
    retry: false,
    refetchInterval: 15000,
  });

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-panel">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
          <Container size={18} />
        </div>
        <div>
          <div className="text-sm font-semibold text-zinc-100">DockPilot</div>
          <div className="text-[10px] text-zinc-500">Docker 桌面管理</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
              page === key
                ? "bg-emerald-500/10 text-emerald-400"
                : "text-zinc-400 hover:bg-panel2 hover:text-zinc-200",
            )}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>

      <div className="border-t border-edge px-5 py-4">
        {info ? (
          <div className="space-y-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <span className="text-zinc-300">Docker {info.version}</span>
            </div>
            <div className="pl-4 text-zinc-500">
              容器 {info.running} 运行 / {info.containers} 总计 · 镜像 {info.images}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />
            <span className="text-zinc-400">Docker 未连接</span>
          </div>
        )}
      </div>
    </aside>
  );
}
