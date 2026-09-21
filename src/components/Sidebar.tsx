import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  Eraser,
  HardDrive,
  Image as ImageIcon,
  LayoutDashboard,
  Layers,
  Settings,
} from "lucide-react";
import { api } from "../lib/api";
import { SidebarTopBar } from "./TitleBar";
import { cn, StatusDot } from "./ui";

export type PageKey =
  | "overview"
  | "containers"
  | "images"
  | "compose"
  | "storage"
  | "cleanup"
  | "settings";

const NAV: { key: PageKey; label: string; icon: typeof Boxes }[] = [
  { key: "overview", label: "系统概览", icon: LayoutDashboard },
  { key: "containers", label: "容器", icon: Boxes },
  { key: "images", label: "镜像", icon: ImageIcon },
  { key: "compose", label: "编排", icon: Layers },
  { key: "storage", label: "存储和网络", icon: HardDrive },
  { key: "cleanup", label: "空间清理", icon: Eraser },
  { key: "settings", label: "设置", icon: Settings },
];

export function Sidebar({
  page,
  onChange,
}: {
  page: PageKey;
  onChange: (p: PageKey) => void;
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
  const composeProjects = useQuery({
    queryKey: ["composeProjects"],
    queryFn: api.listComposeProjects,
    enabled: page === "compose",
  });
  const volumes = useQuery({
    queryKey: ["volumes"],
    queryFn: api.listVolumes,
    enabled: page === "storage",
  });

  const counts: Partial<Record<PageKey, number | undefined>> = {
    containers: containers.data?.length,
    images: images.data?.length,
    compose: composeProjects.data?.length,
    storage: volumes.data?.length,
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-sidebar">
      <SidebarTopBar />

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
