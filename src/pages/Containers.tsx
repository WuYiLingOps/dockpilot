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
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import type { ContainerDto, ContainerSpec } from "../types/docker";
import { useContainerActions } from "../hooks/useContainerActions";
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
      toast.success("容器已删除");
      setPendingDelete(null);
      void qc.invalidateQueries({ queryKey: ["containers"] });
      void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
    },
    onError: (e) => toast.error(`删除容器失败: ${e}`),
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
          "已克隆配置；原容器正在运行，重启策略已改为不重启，端口与卷挂载很可能冲突，请确认后再启动",
          { duration: 8000 },
        );
      }
      setCloneSpec(spec);
      setCreateOpen(true);
    } catch (e) {
      toast.error(`读取容器配置失败: ${e}`);
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
      <PageHeader title="容器" desc={`${list.length} 个容器 · 点击行查看详情`}>
        <SearchInput value={search} onChange={onSearch} className="w-44" />
        <Button
          variant="primary"
          onClick={() => {
            setCloneSpec(null);
            setCreateOpen(true);
          }}
        >
          <Plus size={15} />
          创建容器
        </Button>
        <IconButton
          title="刷新"
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
          title={keyword ? "没有匹配的容器" : "还没有容器"}
          desc={
            keyword
              ? "换个关键字试试"
              : "运行 docker run 创建一个容器后这里会显示"
          }
        />
      ) : (
        <div className="flex-1 overflow-auto p-4 pt-2">
          <div className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
            <div
              className={`${GRID} h-8 border-b border-edge bg-panel2/60 px-4 text-[11px] font-medium text-fg3`}
            >
              <div>状态</div>
              <div>名称</div>
              <div>镜像</div>
              <div>端口</div>
              <div>创建时间</div>
              <div />
            </div>
            {filtered.map((c) => (
              <div
                key={c.id}
                onClick={() => onOpen(c.id)}
                className={`${GRID} group cursor-pointer border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-hover`}
              >
                <div title={c.status}>
                  <div className="flex items-center gap-1.5 text-[12px] text-fg2">
                    <StatusDot state={c.state} />
                    {statusText(c.state)}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-fg">{c.name}</span>
                    {c.health && <HealthBadge health={c.health} />}
                    {c.compose_project && (
                      <button
                        type="button"
                        title={`compose 项目：${c.compose_project}，点击查看编排详情`}
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
                  className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                  data-no-drag
                >
                  {(c.state === "exited" || c.state === "created" || c.state === "dead") && (
                    <IconButton
                      title="启动"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: c.id, act: "start" })}
                    >
                      <Play size={14} />
                    </IconButton>
                  )}
                  {c.state === "running" && (
                    <>
                      <IconButton
                        title="停止"
                        disabled={action.isPending}
                        onClick={() => action.mutate({ id: c.id, act: "stop" })}
                      >
                        <Square size={14} />
                      </IconButton>
                      <IconButton
                        title="重启"
                        disabled={action.isPending}
                        onClick={() => action.mutate({ id: c.id, act: "restart" })}
                      >
                        <RotateCw size={14} />
                      </IconButton>
                      <IconButton
                        title="暂停"
                        disabled={action.isPending}
                        onClick={() => action.mutate({ id: c.id, act: "pause" })}
                      >
                        <Pause size={14} />
                      </IconButton>
                    </>
                  )}
                  {c.state === "restarting" && (
                    <IconButton
                      title="停止（退出重启循环）"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: c.id, act: "stop" })}
                    >
                      <Square size={14} />
                    </IconButton>
                  )}
                  {c.state === "paused" && (
                    <IconButton
                      title="恢复"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: c.id, act: "unpause" })}
                    >
                      <Play size={14} />
                    </IconButton>
                  )}
                  <IconButton title="克隆（以此配置创建新容器）" onClick={() => void clone(c)}>
                    <Copy size={14} />
                  </IconButton>
                  <IconButton
                    title="删除"
                    disabled={deleteForce.isPending}
                    className="hover:bg-err/10 hover:text-err"
                    onClick={() => setPendingDelete(c)}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
            ))}
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
        title="删除容器"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={deleteForce.isPending}
              onClick={() => pendingDelete && deleteForce.mutate(pendingDelete)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p>
          确定删除容器 <span className="font-mono text-fg">{pendingDelete?.name}</span> 吗？
        </p>
        {(pendingDelete?.state === "running" ||
          pendingDelete?.state === "restarting" ||
          pendingDelete?.state === "paused") && (
          <p className="mt-2 text-[12px] text-warn">
            该容器{pendingDelete.state === "restarting" ? "正在重启循环中" : "尚未停止"}
            ，删除时会先强制停止，此操作不可恢复。
          </p>
        )}
      </Modal>
    </>
  );
}
