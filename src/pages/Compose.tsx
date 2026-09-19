import { useQuery } from "@tanstack/react-query";
import { Layers, PackagePlus, RefreshCw, Square, Play, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import { copyText } from "../lib/clipboard";
import { useComposeRun } from "../hooks/useComposeRun";
import type { ComposeProjectDto } from "../types/compose";
import { OutputPanel } from "../components/compose/OutputPanel";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  IconButton,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  Spinner,
  StatusDot,
} from "../components/ui";

/** 项目整体状态：全部运行 → running，全部停止 → exited，部分 → paused（仅用圆点着色） */
export function projectState(p: ComposeProjectDto): string {
  if (p.total_count === 0 || p.running_count === 0) return "exited";
  if (p.running_count === p.total_count) return "running";
  return "paused";
}

/** 从 compose 文件路径取默认项目名：父目录名做 compose 命名规范化 */
function defaultProjectName(file: string): string {
  const dir = file.slice(0, Math.max(file.lastIndexOf("/"), 0));
  const base = dir.slice(dir.lastIndexOf("/") + 1);
  const name = base.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return name || "myapp";
}

const GRID =
  "grid grid-cols-[minmax(150px,1.1fr)_minmax(180px,1.4fr)_minmax(140px,1fr)_96px] items-center gap-x-3";

export function Compose({
  onOpen,
  search,
  onSearch,
}: {
  onOpen: (project: string) => void;
  search: string;
  onSearch: (v: string) => void;
}) {
  const { data: settings } = useSettings();
  const deployRun = useComposeRun();
  const quickRun = useComposeRun();

  const [deployFiles, setDeployFiles] = useState<string[] | null>(null);
  const [deployName, setDeployName] = useState("");

  const cli = useQuery({
    queryKey: ["composeCli"],
    queryFn: api.composeCliInfo,
    staleTime: 30_000,
  });
  const query = useQuery({
    queryKey: ["composeProjects"],
    queryFn: api.listComposeProjects,
    refetchInterval: (settings?.containers_refresh_secs ?? 10) * 1000,
  });

  const keyword = search.trim().toLowerCase();
  const projects = (query.data ?? []).filter(
    (p) =>
      !keyword ||
      p.name.toLowerCase().includes(keyword) ||
      p.working_dir.toLowerCase().includes(keyword) ||
      p.services.some((s) => s.name.toLowerCase().includes(keyword)),
  );
  const cliReady = cli.data?.available === true;

  const quickAction = (p: ComposeProjectDto, action: string, label: string) => {
    if (!cliReady) return;
    quickRun.start(
      (o) => api.composeAction(p.name, action, {}, o),
      { label: `${label}项目 ${p.name}` },
    );
  };

  const pickFiles = async () => {
    try {
      const picked = await open({
        multiple: true,
        filters: [{ name: "Compose 文件", extensions: ["yml", "yaml"] }],
      });
      if (!picked) return;
      const files = Array.isArray(picked) ? picked : [picked];
      if (files.length === 0) return;
      setDeployFiles(files);
      setDeployName(defaultProjectName(files[0]));
    } catch (e) {
      toast.error(`选择文件失败: ${e}`);
    }
  };

  const startDeploy = () => {
    if (!deployFiles) return;
    const files = deployFiles;
    const name = deployName.trim();
    deployRun.start(
      (o) =>
        api.composeDeploy(
          files,
          "",
          name,
          o,
        ),
      {
        label: `部署项目 ${name}`,
        // 部署成功后关闭弹窗；失败保持打开以便查看输出
        onDone: (r) => {
          if (r.error === null && r.code === 0) setDeployFiles(null);
        },
      },
    );
  };

  const deploying = deployRun.running;

  return (
    <>
      <PageHeader title="编排" desc={`${projects.length} 个 compose 项目 · 点击行查看服务`}>
        <SearchInput value={search} onChange={onSearch} className="w-44" />
        <Button
          variant="tinted"
          disabled={!cliReady}
          title={cliReady ? "选择 compose 文件部署新项目" : "需要安装 Docker Compose CLI"}
          onClick={() => void pickFiles()}
        >
          <PackagePlus size={14} />
          部署新项目
        </Button>
        <IconButton title="刷新" onClick={() => void query.refetch()} className="h-8 w-8">
          <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""} />
        </IconButton>
      </PageHeader>

      {cli.data && !cli.data.available && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-card border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          <TriangleAlert size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            未检测到 Docker Compose CLI：项目识别与查看不受影响，但无法执行启动/停止等编排操作。
          </span>
          <Button
            variant="outline"
            className="h-7 shrink-0"
            onClick={() => void copyText("sudo apt install docker-compose-plugin")}
          >
            复制安装命令
          </Button>
        </div>
      )}

      {query.isLoading || cli.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : query.isError ? (
        <ErrorNote message={String(query.error)} onRetry={() => void query.refetch()} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Layers size={40} strokeWidth={1.5} />}
          title={keyword ? "没有匹配的项目" : "还没有 Compose 项目"}
          desc={
            keyword
              ? "换个关键字试试"
              : "通过「部署新项目」选择 compose 文件，或在终端用 docker compose up 启动一个项目"
          }
        />
      ) : (
        <div className="flex-1 overflow-auto p-4 pt-2">
          <div className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
            <div
              className={`${GRID} h-8 border-b border-edge bg-panel2/60 px-4 text-[11px] font-medium text-fg3`}
            >
              <div>项目</div>
              <div>目录</div>
              <div>服务</div>
              <div />
            </div>
            {projects.map((p) => (
              <div
                key={p.name}
                onClick={() => onOpen(p.name)}
                className={`${GRID} group cursor-pointer border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-hover`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusDot state={projectState(p)} />
                    <span className="truncate font-medium text-fg">{p.name}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-fg3">
                    {p.running_count}/{p.total_count} 容器运行
                    {p.config_files.length > 1 && ` · ${p.config_files.length} 个配置文件`}
                  </div>
                </div>
                <div className="min-w-0">
                  <div
                    className="truncate font-mono text-[12px] text-fg2"
                    title={`${p.working_dir}\n${p.config_files.join("\n")}`}
                  >
                    {p.working_dir || "—"}
                  </div>
                </div>
                <div className="min-w-0">
                  <div
                    className="truncate text-[12px] text-fg2"
                    title={[...new Set(p.services.map((s) => s.name))].join(" · ")}
                  >
                    {[...new Set(p.services.map((s) => s.name))].join(" · ") || "—"}
                  </div>
                </div>
                <div
                  className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                  data-no-drag
                >
                  {p.running_count < p.total_count && (
                    <IconButton
                      title={cliReady ? "启动全部服务" : "需要 Compose CLI"}
                      disabled={!cliReady || quickRun.running}
                      onClick={() => quickAction(p, "up", "启动")}
                    >
                      <Play size={14} />
                    </IconButton>
                  )}
                  {p.running_count > 0 && (
                    <IconButton
                      title={cliReady ? "停止全部服务" : "需要 Compose CLI"}
                      disabled={!cliReady || quickRun.running}
                      onClick={() => quickAction(p, "stop", "停止")}
                    >
                      <Square size={14} />
                    </IconButton>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 部署新项目 */}
      <Modal
        open={deployFiles !== null}
        title="部署新项目"
        onClose={() => {
          if (!deploying) setDeployFiles(null);
        }}
      >
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[12px] font-medium text-fg2">compose 文件</div>
            <div className="flex flex-wrap gap-1">
              {(deployFiles ?? []).map((f) => (
                <Badge key={f} tone="accent">
                  <span className="max-w-64 truncate font-mono" title={f}>
                    {f}
                  </span>
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-fg2">项目名</div>
            <Input
              value={deployName}
              onChange={(e) => setDeployName(e.target.value)}
              placeholder="myapp"
              disabled={deploying}
              autoFocus
            />
          </div>
          {deployRun.lines.length > 0 && (
            <OutputPanel
              label={`部署 ${deployName}`}
              lines={deployRun.lines}
              running={deployRun.running}
              result={deployRun.result}
              onCancel={deployRun.stop}
              className="max-h-48"
            />
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" disabled={deploying} onClick={() => setDeployFiles(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={deploying || deployName.trim() === ""}
              onClick={startDeploy}
            >
              {deploying ? "部署中…" : "开始部署"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
