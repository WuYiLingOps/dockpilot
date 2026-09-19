import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { formatPorts, timeAgo } from "../lib/format";
import type { ContainerDto } from "../types/docker";
import {
  Button,
  EmptyState,
  ErrorNote,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Spinner,
  StateBadge,
} from "../components/ui";

const ACT_LABEL: Record<string, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  pause: "暂停",
  unpause: "恢复",
};

export function Containers() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ContainerDto | null>(null);

  const query = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
    refetchInterval: 10000,
  });

  const action = useMutation({
    mutationFn: (vars: { id: string; act: string }) =>
      api.containerAction(vars.id, vars.act),
    onSuccess: (_data, vars) => {
      toast.success(`容器已${ACT_LABEL[vars.act] ?? vars.act}`);
      void qc.invalidateQueries({ queryKey: ["containers"] });
    },
    onError: (e, vars) =>
      toast.error(`容器${ACT_LABEL[vars.act] ?? vars.act}失败: ${e}`),
  });

  const remove = useMutation({
    mutationFn: (c: ContainerDto) =>
      api.containerAction(c.id, "remove", c.state === "running"),
    onSuccess: () => {
      toast.success("容器已删除");
      setPendingDelete(null);
      void qc.invalidateQueries({ queryKey: ["containers"] });
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
      <PageHeader title="容器" desc="本机全部容器的生命周期管理">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称 / 镜像 / ID"
            className="w-64 pl-8"
          />
        </div>
        <IconButton
          title="刷新"
          onClick={() => void query.refetch()}
          className="h-9 w-9 border border-edge"
        >
          <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""} />
        </IconButton>
      </PageHeader>

      {query.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : query.isError ? (
        <ErrorNote
          message={String(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Boxes size={40} />}
          title={keyword ? "没有匹配的容器" : "还没有容器"}
          desc={keyword ? "换个关键字试试" : "运行 docker run 创建一个容器后这里会显示"}
        />
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-panel text-left text-xs text-zinc-500">
              <tr className="border-b border-edge">
                <th className="px-6 py-2.5 font-medium">状态</th>
                <th className="py-2.5 font-medium">名称</th>
                <th className="py-2.5 font-medium">镜像</th>
                <th className="py-2.5 font-medium">端口</th>
                <th className="py-2.5 font-medium">创建时间</th>
                <th className="py-2.5 pr-6 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-edge/60 transition-colors last:border-0 hover:bg-panel2/50"
                >
                  <td className="px-6 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      <StateBadge state={c.state} />
                      <span className="text-[10px] text-zinc-500">{c.status}</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="font-medium text-zinc-200">{c.name}</div>
                    <div className="font-mono text-[10px] text-zinc-500">
                      {c.id.slice(0, 12)}
                    </div>
                  </td>
                  <td className="max-w-56 py-2.5 pr-4">
                    <div className="truncate font-mono text-xs text-zinc-400" title={c.image}>
                      {c.image}
                    </div>
                  </td>
                  <td className="max-w-52 py-2.5 pr-4">
                    <div
                      className="truncate font-mono text-xs text-zinc-400"
                      title={formatPorts(c.ports)}
                    >
                      {formatPorts(c.ports)}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-zinc-500">
                    {timeAgo(c.created)}
                  </td>
                  <td className="py-2.5 pr-6">
                    <div className="flex items-center justify-end gap-0.5">
                      {(c.state === "exited" ||
                        c.state === "created" ||
                        c.state === "dead") && (
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
                        disabled={remove.isPending}
                        className="hover:bg-rose-500/10 hover:text-rose-400"
                        onClick={() => setPendingDelete(c)}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
              disabled={remove.isPending}
              onClick={() => pendingDelete && remove.mutate(pendingDelete)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p>
          确定删除容器{" "}
          <span className="font-mono text-zinc-100">{pendingDelete?.name}</span> 吗？
        </p>
        {pendingDelete?.state === "running" && (
          <p className="mt-2 text-xs text-amber-400">
            该容器正在运行，删除时会先强制停止，此操作不可恢复。
          </p>
        )}
      </Modal>
    </>
  );
}
