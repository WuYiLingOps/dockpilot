import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import type { MsgKey } from "../lib/i18n/zh";

/** 生命周期操作的文案组：按钮标签 / 进行中 / 已完成 / 失败（中英文构词不同，逐条登记） */
const ACTIONS: Record<
  string,
  { label: MsgKey; pending: MsgKey; done: MsgKey; fail: MsgKey }
> = {
  start: {
    label: "containers.actStart",
    pending: "containers.starting",
    done: "containers.started",
    fail: "containers.startFailed",
  },
  stop: {
    label: "containers.actStop",
    pending: "containers.stopping",
    done: "containers.stopped",
    fail: "containers.stopFailed",
  },
  restart: {
    label: "containers.actRestart",
    pending: "containers.restarting",
    done: "containers.restarted",
    fail: "containers.restartFailed",
  },
  pause: {
    label: "containers.actPause",
    pending: "containers.pausing",
    done: "containers.paused",
    fail: "containers.pauseFailed",
  },
  unpause: {
    label: "containers.actUnpause",
    pending: "containers.unpausing",
    done: "containers.unpaused",
    fail: "containers.unpauseFailed",
  },
};

function actionTexts(act: string) {
  return (
    ACTIONS[act] ?? {
      label: act as MsgKey,
      pending: act as MsgKey,
      done: act as MsgKey,
      fail: "containers.actionFailed" as MsgKey,
    }
  );
}

/** 操作进行中的行内中间态文案，如 stop → 「停止中…」 */
export function actionPendingText(act: string): string {
  return t(actionTexts(act).pending);
}

/** 容器生命周期操作，列表页与详情页共用 */
export function useContainerActions() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["containers"] });
    void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
  };

  const action = useMutation({
    mutationFn: (vars: { id: string; act: string }) =>
      api.containerAction(vars.id, vars.act),
    onSuccess: async (_d, vars) => {
      // docker start 是异步语义：调用成功只代表进程被拉起，不代表能存活。
      // 等一小会儿复查状态，立即退出 / 陷入重启循环时给出真实结论
      if (vars.act === "start") {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const h = await api.containerHealth(vars.id);
          if (h.state === "exited" || h.state === "dead") {
            invalidate();
            toast.warning(
              h.oom_killed
                ? t("containers.startedThenOOM")
                : t("containers.startedThenExited", { code: h.exit_code }),
              { duration: 10000 },
            );
            return;
          }
          if (h.state === "restarting") {
            invalidate();
            toast.warning(t("containers.restartLoop"), {
              duration: 10000,
            });
            return;
          }
        } catch {
          // 容器可能已被删除，忽略
        }
      }
      toast.success(t(actionTexts(vars.act).done));
      invalidate();
    },
    onError: (e, vars) =>
      toast.error(t(actionTexts(vars.act).fail, { err: String(e) })),
  });

  const remove = useMutation({
    mutationFn: (v: { id: string; force: boolean }) =>
      api.containerAction(v.id, "remove", v.force),
    onSuccess: () => {
      toast.success(t("containers.removed"));
      invalidate();
    },
    onError: (e) => toast.error(t("containers.removeFailed", { err: String(e) })),
  });

  return { action, remove };
}
