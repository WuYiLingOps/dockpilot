import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Layers,
  Plus,
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
import { t, useT } from "../lib/i18n";
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
  RefreshIcon,
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
      return t("compose.sourceRemembered");
    case "registered":
      return t("compose.sourceRegistered");
    case "scanned":
      return t("compose.sourceScanned");
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
  const t = useT();
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
  const cliMissingHint = isSsh
    ? t("compose.cliMissingSsh")
    : t("compose.cliMissingLocal");

  const quickAction = (p: ComposeProjectDto, action: "up" | "stop") => {
    if (!cliReady) return;
    const label = action === "up" ? t("containers.actStart") : t("containers.actStop");
    const pending = action === "up" ? t("containers.starting") : t("containers.stopping");
    quickRun.start(
      (o, e) => api.composeAction(p.name, action, {}, o, e),
      {
        label: t("compose.projectActionLabel", { label, name: p.name }),
        target: p.name,
        action,
        pendingText: pending,
      },
    );
  };

  const removeTracked = useMutation({
    mutationFn: (name: string) => api.removeTrackedComposeProject(name),
    onSuccess: () => {
      toast.success(t("compose.trackedRemoved"));
      void qc.invalidateQueries({ queryKey: ["composeProjects"] });
    },
    onError: (e) => toast.error(t("compose.removeFailed", { err: String(e) })),
  });

  return (
    <>
      <PageHeader title={t("nav.compose")} desc={t("compose.pageDesc", { n: projects.length })}>
        <SearchInput value={search} onChange={onSearch} className="w-44" />
        <IconButton
          title={t("compose.scanButtonTitle")}
          onClick={() => setScanOpen(true)}
          className="h-8 w-8"
        >
          <ScanSearch size={15} />
        </IconButton>
        <Button variant="tinted" className="h-8 shrink-0" onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          {t("compose.addProject")}
        </Button>
        <IconButton title={t("common.refresh")} onClick={() => void query.refetch()} className="h-8 w-8">
          <RefreshIcon spinning={query.isFetching} size={15} />
        </IconButton>
      </PageHeader>

      {cli.data && !cli.data.available && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-card border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          <TriangleAlert size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            {isSsh ? t("compose.cliBannerSsh") : t("compose.cliBannerLocal")}
          </span>
          <Button
            variant="outline"
            className="h-7 shrink-0"
            title={isSsh ? t("compose.copyInstallTitle") : undefined}
            onClick={() => void copyText("sudo apt install docker-compose-plugin")}
          >
            {t("compose.copyInstallCmd")}
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
          title={keyword ? t("compose.emptySearch") : t("compose.empty")}
          desc={
            keyword
              ? t("inspect.noMatchHint")
              : isSsh
                ? t("compose.emptyHintSsh")
                : t("compose.emptyHintLocal")
          }
        />
      ) : (
        <div className="flex-1 overflow-auto p-4 pt-2">
          <div className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
            <div
              className={`${GRID} h-8 border-b border-edge bg-panel2/60 px-4 text-[11px] font-medium text-fg3`}
            >
              <div>{t("compose.thProject")}</div>
              <div>{t("compose.thDir")}</div>
              <div>{t("compose.thServices")}</div>
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
                      ? t("compose.notRunningLocal")
                      : t("compose.runningSummary", {
                          running: p.running_count,
                          total: p.total_count,
                          files:
                            p.config_files.length > 1
                              ? t("compose.configFiles", { n: p.config_files.length })
                              : "",
                        })}
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
                      title={cliReady ? t("compose.upTitle") : cliMissingHint}
                      disabled={!cliReady || quickRun.running}
                      onClick={() => quickAction(p, "up")}
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
                      title={cliReady ? t("compose.stopTitle") : cliMissingHint}
                      disabled={!cliReady || quickRun.running}
                      onClick={() => quickAction(p, "stop")}
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
                      title={t("compose.removeTrackedTitle")}
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
  const t = useT();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");

  const submit = useMutation({
    mutationFn: () => api.addTrackedComposeProject(path.trim(), name.trim() || undefined),
    onSuccess: () => {
      toast.success(t("compose.added"));
      setPath("");
      setName("");
      onClose();
      void qc.invalidateQueries({ queryKey: ["composeProjects"] });
    },
    onError: (e) => toast.error(t("compose.addFailed", { err: String(e) })),
  });

  const pickFile = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: t("compose.composeFileFilter"), extensions: ["yaml", "yml"] }],
      });
      if (typeof picked === "string") setPath(picked);
    } catch {
      // 用户取消选择
    }
  };

  return (
    <Modal
      open={open}
      title={t("compose.addProject")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!path.trim() || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? t("compose.adding") : t("img.add")}
          </Button>
        </>
      }
    >
      <p className="text-[12px] leading-5 text-fg2">
        {t("compose.addDesc")}
        {isSsh && t("compose.addDescSsh")}
      </p>
      <div className="mt-3 space-y-3">
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">
            {t("compose.filePathLabel")}
            {isSsh ? t("compose.filePathRemote") : t("compose.filePathLocal")}
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
                {t("compose.chooseFile")}
              </Button>
            )}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">
            {t("compose.nameLabel")}
            <span className="font-normal text-fg3">{t("compose.nameHint")}</span>
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
  const t = useT();
  const updateSettings = useUpdateSettings();
  const isSsh = activeConnection(settings).kind === "ssh";
  const connId = settings?.active_connection_id ?? "local";
  const dirs =
    settings?.compose_scan_dirs?.filter((d) => d.connection_id === connId) ?? [];
  const [path, setPath] = useState("");

  const scan = useMutation({
    mutationFn: () => api.scanComposeDirs(),
    onSuccess: (r) => {
      if (r.found === 0) toast.info(t("compose.scanDoneNone"));
      else
        toast.success(
          t("compose.scanDone", { found: r.found, discovered: r.discovered }),
        );
      void qc.invalidateQueries({ queryKey: ["composeProjects"] });
    },
    onError: (e) => toast.error(t("compose.scanFailed", { err: String(e) })),
  });

  const addDir = (p: string) => {
    const trimmed = p.trim().replace(/\/+$/, "");
    if (!trimmed || !settings) return;
    if (dirs.some((d) => d.path === trimmed)) {
      toast.info(t("compose.dirAlreadyTracked"));
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
      title={t("compose.scanTitle")}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto self-center text-[11px] text-fg3">
            {t("compose.scanHint")}
          </span>
          <Button
            variant="outline"
            disabled={dirs.length === 0 || scan.isPending}
            onClick={() => scan.mutate()}
          >
            {scan.isPending ? t("compose.scanning") : t("compose.scanNow")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("compose.finish")}
          </Button>
        </>
      }
    >
      <p className="text-[12px] leading-5 text-fg2">
        {t("compose.scanDesc")}
        {isSsh && t("compose.scanDescSsh")}
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
            <IconButton title={t("compose.deleteDir")} onClick={() => removeDir(d.id)}>
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
        {dirs.length === 0 && (
          <div className="rounded-ctl border border-dashed border-edge px-2.5 py-3 text-center text-[12px] text-fg3">
            {t("compose.noScanDirs")}
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
              placeholder={t("compose.scanDirPlaceholder")}
              className="min-w-0 flex-1 font-mono"
              spellCheck={false}
            />
          ) : (
            <Button variant="outline" className="h-8 flex-1" onClick={() => void pickDir()}>
              {t("compose.chooseDir")}
            </Button>
          )}
          {isSsh && (
            <Button
              variant="outline"
              className="h-8 shrink-0"
              disabled={!path.trim()}
              onClick={() => addDir(path)}
            >
              {t("img.add")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
