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
  PanelLeftOpen,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useState } from "react";
import { api } from "../lib/api";
import { activeConnection, useSettings, useSwitchConnection } from "../lib/settings";
import type { ConnectionKind } from "../types/settings";
import { SidebarTopBar } from "./TitleBar";
import { cn, IconButton, Spinner, StatusDot } from "./ui";

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

/** 侧栏折叠为图标栏的持久化（纯本地 UI 偏好，不进设置文件 / 云同步） */
const COLLAPSED_KEY = "dockpilot.sidebar.collapsed";

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 侧栏底部：当前连接状态 + 连接切换下拉 */
function ConnectionFooter({
  onManage,
  collapsed = false,
  onExpand,
}: {
  onManage: () => void;
  collapsed?: boolean;
  onExpand?: () => void;
}) {
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
  const statusText = info.data
    ? `${active.name} · Docker ${info.data.version} · ${info.data.running} 运行 · ${info.data.containers} 容器`
    : info.isError
      ? "Docker 未连接"
      : "正在连接 Docker…";

  // 折叠态下面板固定宽度、在图标栏上方居中弹出，避免被 56px 容器压扁
  const dropdown = open && (
    <>
      <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      <div
        className={cn(
          "absolute bottom-full z-50 mb-1.5 overflow-hidden rounded-ctl border border-edge bg-panel p-1 shadow-[var(--app-shadow)]",
          // 折叠态：56px 图标栏贴着窗口左缘，居中弹出会被裁切，
          // 改为面板左缘对齐图标栏右缘、整体向右弹出
          collapsed ? "left-14 w-60" : "left-3 right-3",
        )}
      >
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
  );

  if (collapsed) {
    return (
      <div className="relative flex flex-col items-center gap-1 border-t border-edge py-2">
        <IconButton title={statusText} aria-label="切换连接" data-no-drag onClick={() => setOpen((v) => !v)}>
          {info.data ? (
            <ActiveIcon size={16} />
          ) : (
            <span
              className={
                info.isError
                  ? "h-2 w-2 rounded-full bg-err"
                  : "h-2 w-2 animate-pulse rounded-full bg-warn"
              }
            />
          )}
        </IconButton>
        {onExpand && (
          <IconButton title="展开侧栏" aria-label="展开侧栏" onClick={onExpand}>
            <PanelLeftOpen size={15} />
          </IconButton>
        )}
        {dropdown}
      </div>
    );
  }

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

      {dropdown}
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
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // 忽略持久化失败，折叠态仍在本会话内生效
      }
      return next;
    });
  }, []);

  // 数量徽章要求启动即显示：列表查询常驻启用。与各页面共用 queryKey，观察者去重不产生重复请求；
  // docker 事件触发 App.tsx 的 invalidate 时数量随之实时刷新，页面轮询仍由页面自身的观察者决定
  const containers = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
  });
  const images = useQuery({
    queryKey: ["images"],
    queryFn: api.listImages,
  });
  const composeProjects = useQuery({
    queryKey: ["composeProjects"],
    queryFn: api.listComposeProjects,
  });
  const volumes = useQuery({
    queryKey: ["volumes"],
    queryFn: api.listVolumes,
  });
  const counts: Partial<Record<PageKey, number | undefined>> = {
    containers: containers.data?.length,
    images: images.data?.length,
    compose: composeProjects.data?.length,
    storage: volumes.data?.length,
  };

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-edge bg-sidebar",
        collapsed ? "w-14" : "w-56",
      )}
    >
      <SidebarTopBar collapsed={collapsed} onToggleCollapse={toggleCollapsed} />

      <nav className={cn("mt-1.5 flex-1 space-y-0.5", collapsed ? "px-2" : "px-3")}>
        {NAV.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            title={collapsed ? label : undefined}
            aria-label={collapsed ? label : undefined}
            className={cn(
              "flex w-full items-center rounded-btn py-1.5 text-[13px] font-medium transition-colors duration-150",
              collapsed ? "justify-center" : "gap-2 px-2",
              page === key
                ? "bg-accent/12 text-accent"
                : "text-fg2 hover:bg-hover hover:text-fg",
            )}
          >
            <Icon size={15} className={cn("shrink-0", page === key ? "" : "text-fg3")} />
            {!collapsed && label}
            {!collapsed && counts[key] !== undefined && (
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

      <ConnectionFooter
        onManage={() => onChange("settings")}
        collapsed={collapsed}
        onExpand={toggleCollapsed}
      />
    </aside>
  );
}
