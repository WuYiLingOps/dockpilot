import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Container, RefreshCw } from "lucide-react";
import { Sidebar, type PageKey } from "./components/Sidebar";
import { Button } from "./components/ui";
import { Overview } from "./pages/Overview";
import { Containers } from "./pages/Containers";
import { ContainerDetail } from "./pages/ContainerDetail";
import { Images } from "./pages/Images";
import { Compose } from "./pages/Compose";
import { ComposeDetail } from "./pages/ComposeDetail";
import { Cleanup } from "./pages/Cleanup";
import { Settings } from "./pages/Settings";
import { api } from "./lib/api";
import { useSettingsThemeSync } from "./lib/settings";

/** Docker 引擎不可达时的引导页（覆盖内容区，侧栏保持可见） */
function DisconnectedOverlay({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-canvas p-8 text-center">
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-panel text-fg3 shadow-[var(--app-shadow)]">
        <Container size={30} strokeWidth={1.5} />
      </div>
      <div className="text-[15px] font-semibold text-fg">无法连接 Docker 引擎</div>
      <p className="max-w-md break-all text-[12px] text-fg3">{message}</p>
      <p className="max-w-md text-[12px] text-fg3">
        请确认 Docker 服务已启动，且当前用户已加入 docker 组：
        <span className="mx-1 font-mono text-fg2">sudo usermod -aG docker $USER</span>
      </p>
      <Button variant="primary" className="mt-3" onClick={onRetry} disabled={retrying}>
        <RefreshCw size={14} className={retrying ? "animate-spin" : ""} />
        重新连接
      </Button>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<PageKey>("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const qc = useQueryClient();

  useSettingsThemeSync();

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
        }}
      />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedId && (page === "containers" || page === "compose") ? (
          <ContainerDetail id={selectedId} onBack={() => setSelectedId(null)} />
        ) : page === "overview" ? (
          <Overview onNavigate={setPage} />
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
        ) : page === "cleanup" ? (
          <Cleanup />
        ) : (
          <Settings />
        )}
        {info.isError && (
          <DisconnectedOverlay
            message={String(info.error)}
            retrying={info.isFetching}
            onRetry={() => void info.refetch()}
          />
        )}
      </main>
    </div>
  );
}
