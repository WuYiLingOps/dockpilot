import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Container, RefreshCw, Settings as SettingsIcon, TriangleAlert } from "lucide-react";
import { Sidebar, type PageKey } from "./components/Sidebar";
import { WindowControls } from "./components/TitleBar";
import { AppLogViewer } from "./components/AppLogViewer";
import { ClosePromptDialog } from "./components/ClosePromptDialog";
import { Button } from "./components/ui";
import { SyncBanners } from "./components/settings/SyncBanners";
import { Overview } from "./pages/Overview";
import { Containers } from "./pages/Containers";
import { ContainerDetail } from "./pages/ContainerDetail";
import { Images } from "./pages/Images";
import { Compose } from "./pages/Compose";
import { ComposeDetail } from "./pages/ComposeDetail";
import { Storage, type StorageTab } from "./pages/Storage";
import { Cleanup } from "./pages/Cleanup";
import { ConnectionDialog } from "./components/settings/ConnectionDialog";
import {
  SettingsDialog,
  type SettingsCategory,
} from "./components/settings/SettingsDialog";
import { api } from "./lib/api";
import { onOpenAppLogViewer } from "./lib/applog";
import { useIsWindows } from "./lib/platform";
import { activeConnection, useSettings, useSettingsThemeSync } from "./lib/settings";
import { useCloudSync } from "./hooks/useCloudSync";
import type { LastCrashInfo } from "./types/diagnostics";

/** Docker 引擎不可达时的引导页（覆盖内容区，侧栏保持可见） */
function DisconnectedOverlay({
  message,
  onRetry,
  retrying,
  onManage,
  windows,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
  onManage: () => void;
  windows: boolean;
}) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-canvas p-8 text-center">
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-panel text-fg3 shadow-[var(--app-shadow)]">
        <Container size={30} strokeWidth={1.5} />
      </div>
      <div className="text-[15px] font-semibold text-fg">无法连接 Docker 引擎</div>
      <p className="max-w-md break-all text-[12px] text-fg3">{message}</p>
      {windows ? (
        <p className="max-w-md text-[12px] text-fg3">
          Windows 版仅支持远程连接（SSH 隧道 / TLS / TCP），
          请到「设置 → Docker 连接」添加并测试远程主机连接。
        </p>
      ) : (
        <p className="max-w-md text-[12px] text-fg3">
          本地连接请确认 Docker 服务已启动且当前用户已加入 docker 组
          （<span className="mx-1 font-mono text-fg2">sudo usermod -aG docker $USER</span>）；
          远程连接请在侧栏切换连接，或到「设置 → Docker 连接」测试并修改配置。
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={onRetry} disabled={retrying}>
          <RefreshCw size={14} className={retrying ? "animate-spin" : ""} />
          重新连接
        </Button>
        <Button variant="outline" onClick={onManage}>
          <SettingsIcon size={14} />
          连接设置
        </Button>
      </div>
    </div>
  );
}

/** 上次异常退出横幅（诊断数据由后端启动时检测，正常退出/首次运行为 null 不显示） */
function CrashBanner({
  info,
  onOpenLogs,
  onDismiss,
}: {
  info: LastCrashInfo;
  onOpenLogs: () => void;
  onDismiss: () => void;
}) {
  const when = info.timestamp ? new Date(info.timestamp).toLocaleString() : "";
  const text =
    info.kind === "panic"
      ? `上次异常退出：${info.location ?? "未知位置"} — ${info.message ?? "未知错误"}`
      : "上次未正常退出且未捕获到原因，如反复出现请到 设置 → 故障诊断 导出诊断包";
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-edge bg-warn/10 px-4 py-1.5 text-[12px] text-fg2"
      data-no-drag
    >
      <TriangleAlert size={14} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {when && <span className="text-fg3">{when}　</span>}
        {text}
      </span>
      <button
        type="button"
        onClick={onOpenLogs}
        className="shrink-0 cursor-pointer rounded-btn px-1.5 py-0.5 text-[12px] text-fg2 transition-colors hover:bg-hover hover:text-fg"
      >
        查看日志
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 cursor-pointer rounded-btn px-1.5 py-0.5 text-[12px] text-fg3 transition-colors hover:bg-hover hover:text-fg"
      >
        知道了
      </button>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<PageKey>("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [storageTab, setStorageTab] = useState<StorageTab>("volumes");
  const [search, setSearch] = useState("");
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [crashDismissed, setCrashDismissed] = useState(false);
  // 设置弹窗：可携带分类直达（同步横幅 → 同步与云）
  const [settingsDlg, setSettingsDlg] = useState<{
    open: boolean;
    category?: SettingsCategory;
  }>({ open: false });
  const openSettings = (category?: SettingsCategory) =>
    setSettingsDlg({ open: true, category });
  // 连接管理弹窗：侧栏底部「管理连接…」与断连引导唤起
  const [connDlgOpen, setConnDlgOpen] = useState(false);
  const qc = useQueryClient();
  const isWindows = useIsWindows();

  useSettingsThemeSync();
  const { data: settings } = useSettings();
  // 云同步自动化：启动远端检查、设置变更去抖上传、窗口可见时检查
  useCloudSync();

  // 使用日志查看器：横幅与设置页「故障诊断」经信号打开
  useEffect(() => onOpenAppLogViewer(() => setLogViewerOpen(true)), []);

  // 上次异常退出（后端启动时检测并缓存；稳定数据，查询一次即可）
  const lastCrash = useQuery({
    queryKey: ["lastCrash"],
    queryFn: api.getLastCrash,
    staleTime: Infinity,
    retry: false,
  });

  // 带可选子 Tab 的导航：Overview 的统计卡片跳到「存储和网络」对应 Tab；
  // 跳到容器页时可携带容器 id 直达详情，未携带则落在容器列表
  const navigate = (p: PageKey, tab?: string, id?: string) => {
    setPage(p);
    if (p === "storage" && (tab === "volumes" || tab === "networks" || tab === "usage")) {
      setStorageTab(tab);
    }
    if (p === "containers") {
      setSelectedId(id ?? null);
    }
  };

  useEffect(
    () =>
      api.subscribeEvents((ev) => {
        if (ev.kind === "container") {
          void qc.invalidateQueries({ queryKey: ["containers"] });
          void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
          void qc.invalidateQueries({ queryKey: ["composeProjects"] });
        }
        if (ev.kind === "image") {
          void qc.invalidateQueries({ queryKey: ["images"] });
          void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
        }
        if (ev.kind === "volume") {
          void qc.invalidateQueries({ queryKey: ["volumes"] });
        }
        if (ev.kind === "network") {
          void qc.invalidateQueries({ queryKey: ["networks"] });
        }
        if (ev.kind === "volume" || ev.kind === "image") {
          void qc.invalidateQueries({ queryKey: ["diskUsage"] });
          void qc.invalidateQueries({ queryKey: ["systemDf"] });
        }
      }),
    [qc],
  );

  const info = useQuery({
    queryKey: ["dockerInfo"],
    queryFn: api.dockerInfo,
    retry: false,
    refetchInterval: 15000,
  });

  return (
    <div className="relative flex h-full bg-canvas text-fg">
      <WindowControls />
      <Sidebar
        // 弹窗打开期间让侧栏「设置」项保持高亮
        page={settingsDlg.open ? "settings" : page}
        onChange={(p) => {
          // 设置不走页面：唤起弹窗，页面上下文保持不变
          if (p === "settings") {
            openSettings();
            return;
          }
          setPage(p);
          setSelectedId(null);
          setSelectedProject(null);
          if (p === "storage") setStorageTab("volumes");
        }}
        onOpenConnections={() => setConnDlgOpen(true)}
      />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedId && (page === "containers" || page === "compose") ? (
          <ContainerDetail id={selectedId} onBack={() => setSelectedId(null)} />
        ) : page === "overview" ? (
          <Overview onNavigate={navigate} />
        ) : page === "containers" ? (
          <Containers
            onOpen={setSelectedId}
            onOpenProject={(name) => {
              setPage("compose");
              setSelectedId(null);
              setSelectedProject(name);
            }}
            search={search}
            onSearch={setSearch}
          />
        ) : page === "images" ? (
          <Images search={search} onSearch={setSearch} />
        ) : page === "compose" && selectedProject ? (
          <ComposeDetail
            project={selectedProject}
            onBack={() => setSelectedProject(null)}
            onOpenContainer={setSelectedId}
          />
        ) : page === "compose" ? (
          <Compose onOpen={setSelectedProject} search={search} onSearch={setSearch} />
        ) : page === "storage" ? (
          <Storage
            tab={storageTab}
            onTab={setStorageTab}
            search={search}
            onSearch={setSearch}
            onOpenCleanup={() => setPage("cleanup")}
          />
        ) : page === "cleanup" ? (
          <Cleanup />
        ) : (
          // page 不会为 "settings"（设置已改为弹窗），此处兜底渲染概览
          <Overview onNavigate={navigate} />
        )}
        {lastCrash.data && !crashDismissed && (
          <CrashBanner
            info={lastCrash.data}
            onOpenLogs={() => setLogViewerOpen(true)}
            onDismiss={() => setCrashDismissed(true)}
          />
        )}
        {info.isError && (
          <DisconnectedOverlay
            message={String(info.error)}
            retrying={info.isFetching}
            windows={isWindows}
            onRetry={() => {
              // 对远程连接需要重建（重启隧道/替换句柄），本地连接幂等重试
              const active = activeConnection(settings);
              void api
                .switchConnection(active.id)
                .catch(() => {})
                .finally(() => void info.refetch());
            }}
            onManage={() => setConnDlgOpen(true)}
          />
        )}
        <SyncBanners onManage={() => openSettings("sync")} />
        <AppLogViewer open={logViewerOpen} onClose={() => setLogViewerOpen(false)} />
      </main>
      <ClosePromptDialog />
      <ConnectionDialog open={connDlgOpen} onClose={() => setConnDlgOpen(false)} />
      <SettingsDialog
        open={settingsDlg.open}
        initialCategory={settingsDlg.category}
        onClose={() => setSettingsDlg({ open: false })}
      />
    </div>
  );
}
