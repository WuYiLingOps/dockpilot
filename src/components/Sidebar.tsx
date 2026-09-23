import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  Check,
  ChevronUp,
  Eraser,
  HardDrive,
  House,
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  Layers,
  Network,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { activeConnection, useSettings, useSwitchConnection } from "../lib/settings";
import type { ConnectionKind } from "../types/settings";
import { SidebarTopBar } from "./TitleBar";
import { cn, Spinner, StatusDot } from "./ui";

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

const KIND_ICON: Record<ConnectionKind, typeof Boxes> = {
  local: House,
  ssh: KeyRound,
  tls: ShieldCheck,
  tcp: Network,
};

/** 侧栏底部：当前连接状态 + 连接切换下拉 */
function ConnectionFooter({ onManage }: { onManage: () => void }) {
  const [open, setOpen] = useState(false);
  const { data: settings } = useSettings();
  const switchConn = useSwitchConnection();
  const info = useQuery({
    queryKey: ["dockerInfo"],
    queryFn: api.dockerInfo,
    retry: false,
    refetchInterval: 15000,
  });

  const connections = settings?.connections ?? [];
  const active = activeConnection(settings);
  const ActiveIcon = KIND_ICON[active.kind] ?? House;

  return (
    <div className="relative border-t border-edge px-3 py-2.5">
      <button
        type="button"
        data-no-drag
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-btn px-1 py-1 text-left transition-colors hover:bg-hover"
      >
        {info.data ? (
          <>
            <StatusDot state="running" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg2" title={active.name}>
              <ActiveIcon size={11} className="mr-1 inline align-[-1px] text-fg3" />
              {active.name}
            </span>
          </>
        ) : (
          <>
            <span
              className={
                info.isError
                  ? "h-2 w-2 shrink-0 rounded-full bg-err"
                  : "h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn"
              }
            />
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg2">
              {info.isError ? "Docker 未连接" : "正在连接 Docker…"}
            </span>
          </>
        )}
        <ChevronUp
          size={13}
          className={cn("shrink-0 text-fg3 transition-transform", open && "rotate-180")}
        />
      </button>
      <div className="pl-4 pt-0.5 text-[11px] text-fg3">
        {info.data
          ? `Docker ${info.data.version} · ${info.data.running} 运行 · ${info.data.containers} 容器`
          : ""}
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-3 right-3 z-50 mb-1.5 overflow-hidden rounded-ctl border border-edge bg-panel p-1 shadow-[var(--app-shadow)]">
            <div className="px-2 py-1 text-[11px] text-fg3">切换连接</div>
            {connections.map((c) => {
              const Icon = KIND_ICON[c.kind] ?? House;
              const isActive = c.id === settings?.active_connection_id;
              const switching = switchConn.isPending && switchConn.variables === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  data-no-drag
                  title={isActive ? "当前连接" : `切换到 ${c.name}`}
                  onClick={() => {
                    if (isActive) {
                      setOpen(false);
                      return;
                    }
                    switchConn.mutate(c.id, { onSettled: () => setOpen(false) });
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-[12px] transition-colors",
                    isActive ? "text-accent" : "text-fg2 hover:bg-hover hover:text-fg",
                  )}
                >
                  {switching ? (
                    <Spinner className="h-3 w-3 shrink-0" />
                  ) : (
                    <Icon size={13} className="shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-left">{c.name}</span>
                  {isActive && <Check size={13} className="shrink-0" />}
                </button>
              );
            })}
            <div className="my-1 border-t border-edge/60" />
            <button
              type="button"
              data-no-drag
              onClick={() => {
                setOpen(false);
                onManage();
              }}
              className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-[12px] text-fg2 transition-colors hover:bg-hover hover:text-fg"
            >
              <Settings size={13} className="shrink-0" />
              管理连接…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Sidebar({
  page,
  onChange,
}: {
  page: PageKey;
  onChange: (p: PageKey) => void;
}) {
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

      <ConnectionFooter onManage={() => onChange("settings")} />
    </aside>
  );
}
