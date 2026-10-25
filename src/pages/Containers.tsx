import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Copy,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import type { ContainerDto, ContainerSpec } from "../types/docker";
import { actionPendingText, useContainerActions } from "../hooks/useContainerActions";
import { useT } from "../lib/i18n";
import { timeAgo } from "../lib/format";
import { CreateContainerModal } from "../components/containers/CreateContainerModal";
import {
  Button,
  EmptyState,
  ErrorNote,
  HealthBadge,
  IconButton,
  Modal,
  PageHeader,
  PortChips,
  SearchInput,
  Spinner,
  StatusDot,
  statusText,
} from "../components/ui";

const GRID =
  "grid grid-cols-[104px_minmax(170px,1.4fr)_minmax(130px,1fr)_minmax(140px,1fr)_104px_148px] items-center gap-x-3";

export function Containers({
  onOpen,
  onOpenProject,
  search,
  onSearch,
}: {
  onOpen: (id: string) => void;
  onOpenProject: (project: string) => void;
  search: string;
  onSearch: (v: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<ContainerDto | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneSpec, setCloneSpec] = useState<ContainerSpec | null>(null);
  const { action } = useContainerActions();
  const { data: settings } = useSettings();

  const query = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
    refetchInterval: (settings?.containers_refresh_secs ?? 10) * 1000,
  });

  // 运行中/重启中/暂停中的容器 daemon 要求先停止才能删除，需带 force
  const needsForce = (c: ContainerDto) =>
    c.state === "running" || c.state === "restarting" || c.state === "paused";

  const deleteForce = useMutation({
    mutationFn: (c: ContainerDto) => api.containerAction(c.id, "remove", needsForce(c)),
    onSuccess: () => {
      toast.success(t("containers.removed"));
      setPendingDelete(null);
      void qc.invalidateQueries({ queryKey: ["containers"] });
      void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
    },
    onError: (e) => toast.error(t("containers.removeFailed", { err: String(e) })),
  });

  /** 克隆容器：inspect 反解析为创建规格回填表单（compose 标签已被后端剔除） */
  const clone = async (c: ContainerDto) => {
    try {
      const spec = await api.containerSpec(c.id);
      // 换名避免与原容器冲突；原名为空（daemon 自动生成）时也留空
      spec.name = c.name ? `${c.name}-clone` : null;
      if (c.state === "running" || c.state === "restarting") {
        // 原容器在跑：克隆体的同名端口 / 数据卷几乎必然冲突（如数据库的
        // 数据目录锁），继承 always/unless-stopped 策略会陷入无限重启循环，
        // 因此重置为不重启，由用户确认配置后再手动启动
        spec.restart_policy = "no";
        toast.info(
          t("containers.cloneWarn"),
          { duration: 8000 },
        );
      }
      setCloneSpec(spec);
      setCreateOpen(true);
    } catch (e) {
      toast.error(t("containers.readSpecFailed", { err: String(e) }));
    }
  };

  const list = query.data ?? [];
  const keyword = search.trim().toLowerCase();
  const filtered = keyword
    ? list.filter(
        (c) =>
          c.name.toLowerCase().includes(keyword) ||
          c.image.toLowerCase().includes(keyword) ||
          c.id.toLowerCase().includes(keyword),
      )
    : list;

  return (
    <>
      <PageHeader title={t("nav.containers")} desc={t("containers.pageDesc", { n: list.length })}>
        <SearchInput value={search} onChange={onSearch} className="w-44" />
        <Button
          variant="primary"
          onClick={() => {
            setCloneSpec(null);
            setCreateOpen(true);
          }}
        >
          <Plus size={15} />
          {t("containers.create")}
        </Button>
        <IconButton
          title={t("common.refresh")}
          onClick={() => void query.refetch()}
          className="h-8 w-8"
        >
          <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""} />
        </IconButton>
      </PageHeader>

      {query.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : query.isError ? (
        <ErrorNote message={String(query.error)} onRetry={() => void query.refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Boxes size={40} strokeWidth={1.5} />}
          title={keyword ? t("containers.emptySearch") : t("containers.empty")}
          desc={
            keyword
              ? t("inspect.noMatchHint")
              : t("containers.emptyHint")
          }
        />
      ) : (
        <div className="flex-1 overflow-auto p-4 pt-2">
          <div className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
            <div
              className={`${GRID} h-8 border-b border-edge bg-panel2/60 px-4 text-[11px] font-medium text-fg3`}
            >
              <div>{t("containers.thState")}</div>
              <div>{t("containers.thName")}</div>
              <div>{t("nav.images")}</div>
              <div>{t("containers.thPorts")}</div>
              <div>{t("containers.thCreated")}</div>
              <div />
            </div>
            {filtered.map((c) => {
              // 该行的生命周期操作进行中：状态列与对应按钮给即时反馈
              const isRowPending =
                action.isPending && action.variables?.id === c.id;
              const spinIcon = (act: string, icon: ReactNode) =>
                isRowPending && action.variables?.act === act ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  icon
                );
              return (
              <div
                key={c.id}
                onClick={() => onOpen(c.id)}
                className={`${GRID} group cursor-pointer border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-hover`}
              >
                <div title={c.status}>
                  <div className="flex items-center gap-1.5 text-[12px] text-fg2">
                    {isRowPending ? (
                      <>
                        <Spinner
                          className="h-3 w-3"
                          color="border-warn/60"
                        />
                        <span className="text-warn">
                          {actionPendingText(action.variables?.act ?? "")}
                        </span>
                      </>
                    ) : (
                      <>
                        <StatusDot state={c.state} />
                        {statusText(c.state)}
                      </>
                    )}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-fg">{c.name}</span>
                    {c.health && <HealthBadge health={c.health} />}
                    {c.compose_project && (
                      <button
                        type="button"
                        title={t("containers.composeTitle", { name: c.compose_project })}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenProject(c.compose_project!);
                        }}
                        className="shrink-0 cursor-pointer rounded-full bg-accent/10 px-2 py-0.5 text-[10.5px] font-medium leading-4 text-accent transition-colors hover:bg-accent/20"
                      >
                        {c.compose_project}
                      </button>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11px] text-fg3">
                    {c.id.slice(0, 12)}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="truncate font-mono text-[12px] text-fg2" title={c.image}>
                    {c.image}
                  </div>
                </div>
                <PortChips ports={c.ports} />
                <div className="text-[12px] text-fg3">{timeAgo(c.created)}</div>
                <div
                  className={`flex items-center justify-end gap-0.5 transition-opacity duration-150 ${isRowPending ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                  onClick={(e) => e.stopPropagation()}
                  data-no-drag
                >
                  {(c.state === "exited" || c.state === "created" || c.state === "dead") && (
                    <IconButton
                      title={t("containers.actStart")}
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: c.id, act: "start" })}
                    >
                      {spinIcon("start", <Play size={14} />)}
                    </IconButton>
                  )}
                  {c.state === "running" && (
                    <>
                      <IconButton
                        title={t("containers.actStop")}
                        disabled={action.isPending}
                        onClick={() => action.mutate({ id: c.id, act: "stop" })}
                      >
                        {spinIcon("stop", <Square size={14} />)}
                      </IconButton>
                      <IconButton
                        title={t("containers.actRestart")}
                        disabled={action.isPending}
                        onClick={() => action.mutate({ id: c.id, act: "restart" })}
                      >
                        {spinIcon("restart", <RotateCw size={14} />)}
                      </IconButton>
                      <IconButton
                        title={t("containers.actPause")}
                        disabled={action.isPending}
                        onClick={() => action.mutate({ id: c.id, act: "pause" })}
                      >
                        {spinIcon("pause", <Pause size={14} />)}
                      </IconButton>
                    </>
                  )}
                  {c.state === "restarting" && (
                    <IconButton
                      title={t("containers.stopFromRestartLoop")}
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: c.id, act: "stop" })}
                    >
                      {spinIcon("stop", <Square size={14} />)}
                    </IconButton>
                  )}
                  {c.state === "paused" && (
                    <IconButton
                      title={t("containers.actUnpause")}
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: c.id, act: "unpause" })}
                    >
                      {spinIcon("unpause", <Play size={14} />)}
                    </IconButton>
                  )}
                  <IconButton title={t("containers.cloneTitle")} onClick={() => void clone(c)}>
                    <Copy size={14} />
                  </IconButton>
                  <IconButton
                    title={t("containers.actRemove")}
                    disabled={deleteForce.isPending}
                    className="hover:bg-err/10 hover:text-err"
                    onClick={() => setPendingDelete(c)}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}

      <CreateContainerModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        initialSpec={cloneSpec}
      />

      <Modal
        open={pendingDelete !== null}
        title={t("containers.deleteConfirmTitle")}
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={deleteForce.isPending}
              onClick={() => pendingDelete && deleteForce.mutate(pendingDelete)}
            >
              {deleteForce.isPending ? t("containers.deleting") : t("containers.confirmDelete")}
            </Button>
          </>
        }
      >
        <p>
          {t("containers.deleteConfirmBefore")}
          <span className="font-mono text-fg">{pendingDelete?.name}</span>
          {t("containers.deleteConfirmAfter")}
        </p>
        {(pendingDelete?.state === "running" ||
          pendingDelete?.state === "restarting" ||
          pendingDelete?.state === "paused") && (
          <p className="mt-2 text-[12px] text-warn">
            {t("containers.deleteForceWarn", {
              state: pendingDelete.state === "restarting" ? t("containers.restartLoopState") : t("containers.notStopped"),
            })}
          </p>
        )}
      </Modal>
    </>
  );
}
