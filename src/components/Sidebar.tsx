import { useQuery } from "@tanstack/react-query";
import { Boxes, Image as ImageIcon, Search } from "lucide-react";
import { api } from "../lib/api";
import { SidebarTopBar } from "./TitleBar";
import { cn, StatusDot } from "./ui";

export type PageKey = "containers" | "images";

const NAV: { key: PageKey; label: string; icon: typeof Boxes }[] = [
  { key: "containers", label: "容器", icon: Boxes },
  { key: "images", label: "镜像", icon: ImageIcon },
];

export function Sidebar({
  page,
  onChange,
  search,
  onSearch,
}: {
  page: PageKey;
  onChange: (p: PageKey) => void;
  search: string;
  onSearch: (v: string) => void;
}) {
  const info = useQuery({
    queryKey: ["dockerInfo"],
    queryFn: api.dockerInfo,
    retry: false,
    refetchInterval: 15000,
  });
  const containers = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
    enabled: page === "containers",
  });
  const images = useQuery({
    queryKey: ["images"],
    queryFn: api.listImages,
    enabled: page === "images",
  });

  const counts: Record<PageKey, number | undefined> = {
    containers: containers.data?.length,
    images: images.data?.length,
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-sidebar">
      <SidebarTopBar />

      {/* 全局搜索（过滤当前视图） */}
      <div className="px-3 pb-1 pt-2">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg3"
          />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="搜索"
            data-no-drag
            className="h-7 w-full rounded-ctl border border-edge-strong bg-panel pl-7 pr-2 text-[13px] text-fg outline-none transition-shadow placeholder:text-fg3 focus:border-accent focus:ring-[3px] focus:ring-accent/25"
          />
        </div>
      </div>

      <nav className="mt-1.5 flex-1 space-y-0.5 px-3">
        {NAV.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-[13px] font-medium transition-colors duration-150",
              page === key
                ? "bg-accent/12 text-accent"
                : "text-fg2 hover:bg-hover hover:text-fg",
            )}
          >
            <Icon size={15} className={page === key ? "" : "text-fg3"} />
            {label}
            {counts[key] !== undefined && (
              <span
                className={cn(
                  "ml-auto text-[11px] tabular-nums",
                  page === key ? "text-accent/70" : "text-fg3",
                )}
              >
                {counts[key]}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="border-t border-edge px-4 py-3">
        {info.data ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[12px]">
              <StatusDot state="running" />
              <span className="font-medium text-fg2">Docker {info.data.version}</span>
            </div>
            <div className="pl-4 text-[11px] text-fg3">
              {info.data.running} 运行 · {info.data.containers} 容器 · {info.data.images} 镜像
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[12px]">
            <span
              className={
                info.isError
                  ? "h-2 w-2 shrink-0 rounded-full bg-err"
                  : "h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn"
              }
            />
            <span className="text-fg2">
              {info.isError ? "Docker 未连接" : "正在连接 Docker…"}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
