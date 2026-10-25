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
import { actionPendingText, useContainerActions } from "../hooks/useContainerActions";
import { useT } from "../lib/i18n";
import type { MsgKey } from "../lib/i18n/zh";
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

const TABS: { key: Tab; labelKey: MsgKey }[] = [
  { key: "overview", labelKey: "cd.tabOverview" },
  { key: "logs", labelKey: "cd.tabLogs" },
  { key: "terminal", labelKey: "cd.tabTerminal" },
  { key: "process", labelKey: "cd.tabProcess" },
  { key: "files", labelKey: "cd.tabFiles" },
  { key: "inspect", labelKey: "cd.tabInspect" },
];

export function ContainerDetail({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const t = useT();
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
  // 本容器生命周期操作进行中：按钮 icon/文案与状态徽标给即时反馈
  const actPending = (act: string) =>
    action.isPending &&
    action.variables?.id === c?.id &&
    action.variables?.act === act;

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
        <IconButton title={t("cd.back")} onClick={onBack} data-no-drag>
          <ChevronLeft size={17} />
        </IconButton>
        {c ? (
          <>
            <h1 className="truncate text-[15px] font-semibold text-fg" title={c.name}>
              {c.name}
            </h1>
            {actPending("start") ||
            actPending("stop") ||
            actPending("restart") ||
            actPending("pause") ||
            actPending("unpause") ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-warn">
                <Spinner className="h-3 w-3" color="border-warn/60" />
                {actionPendingText(action.variables?.act ?? "")}
              </span>
            ) : (
              <StateBadge state={c.state} />
            )}
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
              {actPending("start") ? <Spinner className="h-3.5 w-3.5" /> : <Play size={14} />}
              {actPending("start") ? actionPendingText("start") : t("containers.actStart")}
            </Button>
          )}
          {running && (
            <>
              <Button
                variant="tinted"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: c.id, act: "stop" })}
              >
                {actPending("stop") ? <Spinner className="h-3.5 w-3.5" /> : <Square size={14} />}
                {actPending("stop") ? actionPendingText("stop") : t("containers.actStop")}
              </Button>
              <Button
                variant="ghost"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: c.id, act: "restart" })}
              >
                {actPending("restart") ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  <RotateCw size={14} />
                )}
                {actPending("restart") ? actionPendingText("restart") : t("containers.actRestart")}
              </Button>
              <Button
                variant="ghost"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: c.id, act: "pause" })}
              >
                {actPending("pause") ? <Spinner className="h-3.5 w-3.5" /> : <Pause size={14} />}
                {actPending("pause") ? actionPendingText("pause") : t("containers.actPause")}
              </Button>
            </>
          )}
          {c?.state === "restarting" && (
            <Button
              variant="tinted"
              disabled={action.isPending}
              onClick={() => action.mutate({ id: c.id, act: "stop" })}
            >
              {actPending("stop") ? <Spinner className="h-3.5 w-3.5" /> : <Square size={14} />}
              {actPending("stop") ? actionPendingText("stop") : t("containers.actStop")}
            </Button>
          )}
          {c?.state === "paused" && (
            <Button
              variant="tinted"
              disabled={action.isPending}
              onClick={() => action.mutate({ id: c.id, act: "unpause" })}
            >
              {actPending("unpause") ? <Spinner className="h-3.5 w-3.5" /> : <Play size={14} />}
              {actPending("unpause") ? actionPendingText("unpause") : t("containers.actUnpause")}
            </Button>
          )}
          {c && (
            <IconButton
              title={t("cd.updateConfig")}
              disabled={action.isPending}
              onClick={() => setUpdateOpen(true)}
            >
              <Pencil size={15} />
            </IconButton>
          )}
          <IconButton
            title={t("containers.actRemove")}
            disabled={remove.isPending}
            className="hover:bg-err/10 hover:text-err"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>

      <div className="flex h-11 shrink-0 items-center border-b border-edge bg-panel px-4">
        <SegmentedControl
          options={TABS.map(({ key, labelKey }) => ({ key, label: t(labelKey) }))}
          value={tab}
          onChange={setTab}
        />
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
        title={t("containers.deleteConfirmTitle")}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
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
              {remove.isPending ? t("containers.deleting") : t("containers.confirmDelete")}
            </Button>
          </>
        }
      >
        <p>
          {t("containers.deleteConfirmBefore")}
          <span className="font-mono text-fg">{c?.name}</span>
          {t("containers.deleteConfirmAfter")}
        </p>
        {(running || c?.state === "restarting" || c?.state === "paused") && (
          <p className="mt-2 text-[12px] text-warn">
            {t("containers.deleteForceWarn", {
              state: c?.state === "restarting" ? t("containers.restartLoopState") : t("containers.notStopped"),
            })}
          </p>
        )}
      </Modal>
    </>
  );
}
