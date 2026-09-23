import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Container, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import { Sidebar, type PageKey } from "./components/Sidebar";
import { Button } from "./components/ui";
import { Overview } from "./pages/Overview";
import { Containers } from "./pages/Containers";
import { ContainerDetail } from "./pages/ContainerDetail";
import { Images } from "./pages/Images";
import { Compose } from "./pages/Compose";
import { ComposeDetail } from "./pages/ComposeDetail";
import { Storage, type StorageTab } from "./pages/Storage";
import { Cleanup } from "./pages/Cleanup";
import { Settings } from "./pages/Settings";
import { api } from "./lib/api";
import { activeConnection, useSettings, useSettingsThemeSync } from "./lib/settings";

/** Docker 引擎不可达时的引导页（覆盖内容区，侧栏保持可见） */
function DisconnectedOverlay({
  message,
  onRetry,
  retrying,
  onManage,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
  onManage: () => void;
}) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-canvas p-8 text-center">
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-panel text-fg3 shadow-[var(--app-shadow)]">
        <Container size={30} strokeWidth={1.5} />
      </div>
      <div className="text-[15px] font-semibold text-fg">无法连接 Docker 引擎</div>
      <p className="max-w-md break-all text-[12px] text-fg3">{message}</p>
      <p className="max-w-md text-[12px] text-fg3">
        本地连接请确认 Docker 服务已启动且当前用户已加入 docker 组
        （<span className="mx-1 font-mono text-fg2">sudo usermod -aG docker $USER</span>）；
        远程连接请在侧栏切换连接，或到「设置 → Docker 连接」测试并修改配置。
      </p>
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

export default function App() {
  const [page, setPage] = useState<PageKey>("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [storageTab, setStorageTab] = useState<StorageTab>("volumes");
  const [search, setSearch] = useState("");
  const qc = useQueryClient();

  useSettingsThemeSync();
  const { data: settings } = useSettings();

  // 带可选子 Tab 的导航：Overview 的统计卡片跳到「存储和网络」对应 Tab
  const navigate = (p: PageKey, tab?: string) => {
    setPage(p);
    if (p === "storage" && (tab === "volumes" || tab === "networks" || tab === "usage")) {
      setStorageTab(tab);
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
    <div className="flex h-full bg-canvas text-fg">
      <Sidebar
        page={page}
        onChange={(p) => {
          setPage(p);
          setSelectedId(null);
          setSelectedProject(null);
          if (p === "storage") setStorageTab("volumes");
        }}
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
          <Settings />
        )}
        {info.isError && (
          <DisconnectedOverlay
            message={String(info.error)}
            retrying={info.isFetching}
            onRetry={() => {
              // 对远程连接需要重建（重启隧道/替换句柄），本地连接幂等重试
              const active = activeConnection(settings);
              void api
                .switchConnection(active.id)
                .catch(() => {})
                .finally(() => void info.refetch());
            }}
            onManage={() => setPage("settings")}
          />
        )}
      </main>
    </div>
  );
}
