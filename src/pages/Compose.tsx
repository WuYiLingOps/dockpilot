import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Layers,
  Plus,
  RefreshCw,
  Square,
  Play,
  ScanSearch,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { activeConnection, useSettings, useUpdateSettings } from "../lib/settings";
import { copyText } from "../lib/clipboard";
import { useComposeRun } from "../hooks/useComposeRun";
import type { ComposeProjectDto } from "../types/compose";
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

/** 项目来源徽标文案：容器标签识别的项目不显示徽标 */
export function sourceLabel(source: string): string | null {
  switch (source) {
    case "remembered":
      return "已记录";
    case "registered":
      return "手动添加";
    case "scanned":
      return "扫描";
    default:
      return null;
  }
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
  const qc = useQueryClient();
  const quickRun = useComposeRun();
  const [addOpen, setAddOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

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
  // SSH 连接的 compose 操作经 ssh 在远程服务器执行，CLI 缺失指的是远端未安装
  const isSsh = activeConnection(settings).kind === "ssh";
  const cliMissingHint = isSsh ? "远程服务器未检测到 Docker Compose CLI" : "需要安装 Docker Compose CLI";

  const quickAction = (p: ComposeProjectDto, action: string, label: string) => {
    if (!cliReady) return;
    quickRun.start(
      (o, e) => api.composeAction(p.name, action, {}, o, e),
      {
        label: `${label}项目 ${p.name}`,
        target: p.name,
        action,
        pendingText: `${label}中…`,
      },
    );
  };

  const removeTracked = useMutation({
    mutationFn: (name: string) => api.removeTrackedComposeProject(name),
    onSuccess: () => {
      toast.success("已移除跟踪记录（项目文件不受影响）");
      void qc.invalidateQueries({ queryKey: ["composeProjects"] });
    },
    onError: (e) => toast.error(`移除失败: ${e}`),
  });

  return (
    <>
      <PageHeader title="编排" desc={`${projects.length} 个 compose 项目 · 点击行查看服务`}>
        <SearchInput value={search} onChange={onSearch} className="w-44" />
        <IconButton title="扫描目录发现编排" onClick={() => setScanOpen(true)} className="h-8 w-8">
          <ScanSearch size={15} />
        </IconButton>
        <Button variant="tinted" className="h-8 shrink-0" onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          添加编排
        </Button>
        <IconButton title="刷新" onClick={() => void query.refetch()} className="h-8 w-8">
          <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""} />
        </IconButton>
      </PageHeader>

      {cli.data && !cli.data.available && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-card border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          <TriangleAlert size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            {isSsh
              ? "远程服务器未检测到 Docker Compose CLI：项目识别与查看不受影响，但无法执行启动/停止等编排操作（请在服务器上安装）。"
              : "未检测到 Docker Compose CLI：项目识别与查看不受影响，但无法执行启动/停止等编排操作。"}
          </span>
          <Button
            variant="outline"
            className="h-7 shrink-0"
            title={isSsh ? "复制到远程服务器上执行" : undefined}
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
              : isSsh
                ? "通过「添加编排」注册远端 compose 文件，或在服务器上 docker compose up 启动项目"
                : "通过「添加编排」注册 compose 文件或「扫描目录」自动发现，在终端 docker compose up 启动的项目也会自动出现"
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
            {projects.map((p) => {
              const pending = quickRun.running && quickRun.target === p.name;
              return (
              <div
                key={p.name}
                onClick={() => onOpen(p.name)}
                className={`${GRID} group cursor-pointer border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-hover`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusDot state={projectState(p)} />
                    <span className="truncate font-medium text-fg">{p.name}</span>
                    {pending ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warn/10 px-2 py-0.5 text-[10.5px] font-medium leading-4 text-warn">
                        <Spinner className="h-2.5 w-2.5" />
                        {quickRun.pendingText}
                      </span>
                    ) : (
                      sourceLabel(p.source) && <Badge>{sourceLabel(p.source)}</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-fg3">
                    {p.total_count === 0
                      ? "未运行 · 本地跟踪"
                      : `${p.running_count}/${p.total_count} 容器运行${p.config_files.length > 1 ? ` · ${p.config_files.length} 个配置文件` : ""}`}
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
                  className={`flex items-center justify-end gap-0.5 transition-opacity duration-150 ${pending ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                  onClick={(e) => e.stopPropagation()}
                  data-no-drag
                >
                  {(p.total_count === 0 || p.running_count < p.total_count) && (
                    <IconButton
                      title={cliReady ? "启动全部服务" : cliMissingHint}
                      disabled={!cliReady || quickRun.running}
                      onClick={() => quickAction(p, "up", "启动")}
                    >
                      {pending && quickRun.action === "up" ? (
                        <Spinner className="h-3.5 w-3.5" />
                      ) : (
                        <Play size={14} />
                      )}
                    </IconButton>
                  )}
                  {p.running_count > 0 && (
                    <IconButton
                      title={cliReady ? "停止全部服务" : cliMissingHint}
                      disabled={!cliReady || quickRun.running}
                      onClick={() => quickAction(p, "stop", "停止")}
                    >
                      {pending && quickRun.action === "stop" ? (
                        <Spinner className="h-3.5 w-3.5" />
                      ) : (
                        <Square size={14} />
                      )}
                    </IconButton>
                  )}
                  {p.total_count === 0 && (
                    <IconButton
                      title="移除跟踪记录（不影响项目文件）"
                      disabled={removeTracked.isPending}
                      onClick={() => removeTracked.mutate(p.name)}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}

      <AddComposeModal
        open={addOpen}
        isSsh={isSsh}
        onClose={() => setAddOpen(false)}
      />
      <ScanDirsModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
      />
    </>
  );
}

/** 添加编排：本地连接用文件选择器，SSH 连接输入远端绝对路径 */
function AddComposeModal({
  open,
  isSsh,
  onClose,
}: {
  open: boolean;
  isSsh: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");

  const submit = useMutation({
    mutationFn: () => api.addTrackedComposeProject(path.trim(), name.trim() || undefined),
    onSuccess: () => {
      toast.success("编排已添加");
      setPath("");
      setName("");
      onClose();
      void qc.invalidateQueries({ queryKey: ["composeProjects"] });
    },
    onError: (e) => toast.error(`添加失败: ${e}`),
  });

  const pickFile = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "Compose 文件", extensions: ["yaml", "yml"] }],
      });
      if (typeof picked === "string") setPath(picked);
    } catch {
      // 用户取消选择
    }
  };

  return (
    <Modal
      open={open}
      title="添加编排"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!path.trim() || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "添加中…" : "添加"}
          </Button>
        </>
      }
    >
      <p className="text-[12px] leading-5 text-fg2">
        注册 compose 文件到本地跟踪列表，项目未运行时也可从这里启动。
        {isSsh && " 当前为 SSH 连接，请填写远端服务器上的文件路径。"}
      </p>
      <div className="mt-3 space-y-3">
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">
            compose 文件{isSsh ? "（远端绝对路径）" : "路径"}
          </div>
          <div className="flex gap-1.5">
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={isSsh ? "/srv/myapp/compose.yaml" : "~/apps/myapp/compose.yaml"}
              className="min-w-0 flex-1 font-mono"
              spellCheck={false}
            />
            {!isSsh && (
              <Button variant="outline" className="h-8 shrink-0" onClick={() => void pickFile()}>
                选择文件
              </Button>
            )}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">
            项目名<span className="font-normal text-fg3">（可选，留空自动从文件 name: 字段或目录名推导）</span>
          </div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="myapp"
            spellCheck={false}
          />
        </div>
      </div>
    </Modal>
  );
}

/** 扫描目录管理：按连接保存目录列表，可立即扫描发现 compose 文件 */
function ScanDirsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const updateSettings = useUpdateSettings();
  const isSsh = activeConnection(settings).kind === "ssh";
  const connId = settings?.active_connection_id ?? "local";
  const dirs =
    settings?.compose_scan_dirs?.filter((d) => d.connection_id === connId) ?? [];
  const [path, setPath] = useState("");

  const scan = useMutation({
    mutationFn: () => api.scanComposeDirs(),
    onSuccess: (r) => {
      if (r.found === 0) toast.info("扫描完成：未发现 compose 文件");
      else
        toast.success(
          `扫描完成：发现 ${r.found} 个文件，新增/更新 ${r.discovered} 个编排`,
        );
      void qc.invalidateQueries({ queryKey: ["composeProjects"] });
    },
    onError: (e) => toast.error(`扫描失败: ${e}`),
  });

  const addDir = (p: string) => {
    const trimmed = p.trim().replace(/\/+$/, "");
    if (!trimmed || !settings) return;
    if (dirs.some((d) => d.path === trimmed)) {
      toast.info("目录已在扫描列表中");
      return;
    }
    updateSettings.mutate(
      {
        ...settings,
        compose_scan_dirs: [
          ...settings.compose_scan_dirs,
          { id: "", connection_id: connId, path: trimmed },
        ],
      },
      { onSuccess: () => setPath("") },
    );
  };

  const removeDir = (id: string) => {
    if (!settings) return;
    updateSettings.mutate({
      ...settings,
      compose_scan_dirs: settings.compose_scan_dirs.filter((d) => d.id !== id),
    });
  };

  const pickDir = async () => {
    try {
      const picked = await openFileDialog({ directory: true, multiple: false });
      if (typeof picked === "string") addDir(picked);
    } catch {
      // 用户取消选择
    }
  };

  return (
    <Modal
      open={open}
      title="扫描目录"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto self-center text-[11px] text-fg3">
            扫描深度 3 层，发现的编排未运行时也会保留在列表
          </span>
          <Button
            variant="outline"
            disabled={dirs.length === 0 || scan.isPending}
            onClick={() => scan.mutate()}
          >
            {scan.isPending ? "扫描中…" : "立即扫描"}
          </Button>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      <p className="text-[12px] leading-5 text-fg2">
        配置若干目录，扫描其中的 compose 文件并纳入编排列表。
        {isSsh && " 当前为 SSH 连接，目录位于远端服务器，扫描经 ssh 执行。"}
      </p>
      <div className="mt-3 space-y-1.5">
        {dirs.map((d) => (
          <div
            key={d.id}
            className="flex items-center gap-2 rounded-ctl border border-edge bg-canvas px-2.5 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg2" title={d.path}>
              {d.path}
            </span>
            <IconButton title="删除此目录" onClick={() => removeDir(d.id)}>
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
        {dirs.length === 0 && (
          <div className="rounded-ctl border border-dashed border-edge px-2.5 py-3 text-center text-[12px] text-fg3">
            还没有配置扫描目录
          </div>
        )}
        <div className="flex gap-1.5 pt-1">
          {isSsh ? (
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && path.trim()) addDir(path);
              }}
              placeholder="/srv/stacks（远端绝对路径）"
              className="min-w-0 flex-1 font-mono"
              spellCheck={false}
            />
          ) : (
            <Button variant="outline" className="h-8 flex-1" onClick={() => void pickDir()}>
              选择目录
            </Button>
          )}
          {isSsh && (
            <Button
              variant="outline"
              className="h-8 shrink-0"
              disabled={!path.trim()}
              onClick={() => addDir(path)}
            >
              添加
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
