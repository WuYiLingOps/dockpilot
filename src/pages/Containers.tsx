import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import type { ContainerDto, PortDto } from "../types/docker";
import { useContainerActions } from "../hooks/useContainerActions";
import { timeAgo } from "../lib/format";
import {
  Button,
  EmptyState,
  ErrorNote,
  IconButton,
  Modal,
  PageHeader,
  Spinner,
  StatusDot,
  Badge,
  statusText,
} from "../components/ui";

/** 端口徽章：最多展示 2 个，多余合并为 +N */
function PortChips({ ports }: { ports: PortDto[] }) {
  if (ports.length === 0) return <span className="text-fg3">—</span>;
  const chips = ports.slice(0, 2).map((p, i) => (
    <Badge key={`${p.public_port}-${p.private_port}-${i}`}>
      <span className="font-mono">
        {p.public_port != null ? `${p.public_port}→${p.private_port}` : p.private_port}
      </span>
    </Badge>
  ));
  const more = ports.length > 2 ? <span className="text-[11px] text-fg3">+{ports.length - 2}</span> : null;
  return (
    <div className="flex items-center gap-1" title={ports.map((p) => (p.public_port != null ? `${p.public_port}→${p.private_port}` : `${p.private_port}`)).join("  ")}>
      {chips}
      {more}
    </div>
  );
}

const GRID =
  "grid grid-cols-[104px_minmax(170px,1.4fr)_minmax(130px,1fr)_minmax(140px,1fr)_104px_148px] items-center gap-x-3";

export function Containers({
  onOpen,
  search,
}: {
  onOpen: (id: string) => void;
  search: string;
}) {
  const qc = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<ContainerDto | null>(null);
  const { action } = useContainerActions();
  const { data: settings } = useSettings();

  const query = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
    refetchInterval: (settings?.containers_refresh_secs ?? 10) * 1000,
  });

  const deleteForce = useMutation({
    mutationFn: (c: ContainerDto) =>
      api.containerAction(c.id, "remove", c.state === "running"),
    onSuccess: () => {
      toast.success("容器已删除");
      setPendingDelete(null);
      void qc.invalidateQueries({ queryKey: ["containers"] });
      void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
    },
    onError: (e) => toast.error(`删除容器失败: ${e}`),
  });

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
                  <div className="truncate font-medium text-fg">{c.name}</div>
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
                  {c.state === "paused" && (
                    <IconButton
                      title="恢复"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: c.id, act: "unpause" })}
                    >
                      <Play size={14} />
                    </IconButton>
                  )}
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
        {pendingDelete?.state === "running" && (
          <p className="mt-2 text-[12px] text-warn">
            该容器正在运行，删除时会先强制停止，此操作不可恢复。
          </p>
        )}
      </Modal>
    </>
  );
}
