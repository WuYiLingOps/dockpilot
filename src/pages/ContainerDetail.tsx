import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  Pause,
  Pencil,
  Play,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useContainerActions } from "../hooks/useContainerActions";
import { withDragRegion } from "../lib/drag";
import { InspectView } from "../components/detail/InspectView";
import { FileBrowserView } from "../components/detail/FileBrowserView";
import { LogsView } from "../components/detail/LogsView";
import { OverviewView } from "../components/detail/OverviewView";
import { ProcessView } from "../components/detail/ProcessView";
import { TerminalView } from "../components/detail/TerminalView";
import { UpdateContainerModal } from "../components/containers/UpdateContainerModal";
import {
  Button,
  HealthBadge,
  IconButton,
  Modal,
  SegmentedControl,
  Spinner,
  StateBadge,
} from "../components/ui";

type Tab = "overview" | "logs" | "terminal" | "process" | "files" | "inspect";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "概览" },
  { key: "logs", label: "日志" },
  { key: "terminal", label: "终端" },
  { key: "process", label: "进程" },
  { key: "files", label: "文件" },
  { key: "inspect", label: "详情" },
];

export function ContainerDetail({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const query = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
    refetchInterval: 10000,
  });
  const c = query.data?.find((x) => x.id === id);
  const { action, remove } = useContainerActions();
  const [tab, setTab] = useState<Tab>("overview");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);

  const running = c?.state === "running";

  // 容器被删除后自动返回列表
  useEffect(() => {
    if (!query.isLoading && !c) onBack();
  }, [query.isLoading, c, onBack]);

  return (
    <>
      <div
        {...withDragRegion()}
        className="flex h-12 shrink-0 items-center gap-2.5 border-b border-edge bg-panel px-3"
      >
        <IconButton title="返回列表" onClick={onBack} data-no-drag>
          <ChevronLeft size={17} />
        </IconButton>
        {c ? (
          <>
            <h1 className="truncate text-[15px] font-semibold text-fg" title={c.name}>
              {c.name}
            </h1>
            <StateBadge state={c.state} />
            {c.health && <HealthBadge health={c.health} />}
            <span
              className="hidden min-w-0 max-w-[24rem] shrink-[4] truncate font-mono text-[11px] text-fg3 lg:inline"
              title={c.image}
            >
              {c.image}
            </span>
          </>
        ) : (
          <Spinner className="h-4 w-4" />
        )}

        <div className="ml-auto mr-[8.25rem] flex shrink-0 items-center gap-1" data-no-drag>
          {c && (c.state === "exited" || c.state === "created" || c.state === "dead") && (
            <Button
              variant="tinted"
              disabled={action.isPending}
              onClick={() => action.mutate({ id: c.id, act: "start" })}
            >
              <Play size={14} />
              启动
            </Button>
          )}
          {running && (
            <>
              <Button
                variant="tinted"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: c.id, act: "stop" })}
              >
                <Square size={14} />
                停止
              </Button>
              <Button
                variant="ghost"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: c.id, act: "restart" })}
              >
                <RotateCw size={14} />
                重启
              </Button>
              <Button
                variant="ghost"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: c.id, act: "pause" })}
              >
                <Pause size={14} />
                暂停
              </Button>
            </>
          )}
          {c?.state === "restarting" && (
            <Button
              variant="tinted"
              disabled={action.isPending}
              onClick={() => action.mutate({ id: c.id, act: "stop" })}
            >
              <Square size={14} />
              停止
            </Button>
          )}
          {c?.state === "paused" && (
            <Button
              variant="tinted"
              disabled={action.isPending}
              onClick={() => action.mutate({ id: c.id, act: "unpause" })}
            >
              <Play size={14} />
              恢复
            </Button>
          )}
          {c && (
            <IconButton
              title="更新配置（重启策略 / 资源限制）"
              disabled={action.isPending}
              onClick={() => setUpdateOpen(true)}
            >
              <Pencil size={15} />
            </IconButton>
          )}
          <IconButton
            title="删除"
            disabled={remove.isPending}
            className="hover:bg-err/10 hover:text-err"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>

      <div className="flex h-11 shrink-0 items-center border-b border-edge bg-panel px-4">
        <SegmentedControl options={TABS} value={tab} onChange={setTab} />
      </div>

      <div className="min-h-0 flex-1">
        {tab === "overview" && c && (
          <OverviewView id={c.id} running={running === true} />
        )}
        {tab === "logs" && c && <LogsView id={c.id} />}
        {tab === "terminal" && c && (
          <TerminalView id={c.id} running={running === true} />
        )}
        {tab === "process" && c && (
          <ProcessView id={c.id} running={running === true} />
        )}
        {tab === "files" && c && (
          <FileBrowserView id={c.id} running={running === true} />
        )}
        {tab === "inspect" && c && <InspectView kind="container" id={c.id} />}
      </div>

      {c && (
        <UpdateContainerModal
          open={updateOpen}
          containerId={c.id}
          containerName={c.name}
          onClose={() => setUpdateOpen(false)}
        />
      )}

      <Modal
        open={confirmDelete}
        title="删除容器"
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() =>
                c &&
                remove.mutate({
                  id: c.id,
                  // 运行中/重启中/暂停中 daemon 都要求先停止才能删除
                  force:
                    c.state === "running" ||
                    c.state === "restarting" ||
                    c.state === "paused",
                })
              }
            >
              确认删除
            </Button>
          </>
        }
      >
        <p>
          确定删除容器 <span className="font-mono text-fg">{c?.name}</span> 吗？
        </p>
        {(running || c?.state === "restarting" || c?.state === "paused") && (
          <p className="mt-2 text-[12px] text-warn">
            该容器{c?.state === "restarting" ? "正在重启循环中" : "尚未停止"}
            ，删除时会先强制停止，此操作不可恢复。
          </p>
        )}
      </Modal>
    </>
  );
}
