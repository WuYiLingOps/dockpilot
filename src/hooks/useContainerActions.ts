import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../lib/api";

const ACT_LABEL: Record<string, string> = {
  start: "启动",
  stop: "停止",
  restart: "重启",
  pause: "暂停",
  unpause: "恢复",
};

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
                ? "容器已启动但随即因内存不足（OOM）退出，请到容器详情查看日志"
                : `容器已启动但随即退出（退出码 ${h.exit_code}），请到容器详情查看日志排查`,
              { duration: 10000 },
            );
            return;
          }
          if (h.state === "restarting") {
            invalidate();
            toast.warning("容器已启动但陷入重启循环（启动即失败），建议停止后排查配置", {
              duration: 10000,
            });
            return;
          }
        } catch {
          // 容器可能已被删除，忽略
        }
      }
      toast.success(`容器已${ACT_LABEL[vars.act] ?? vars.act}`);
      invalidate();
    },
    onError: (e, vars) =>
      toast.error(`容器${ACT_LABEL[vars.act] ?? vars.act}失败: ${e}`),
  });

  const remove = useMutation({
    mutationFn: (v: { id: string; force: boolean }) =>
      api.containerAction(v.id, "remove", v.force),
    onSuccess: () => {
      toast.success("容器已删除");
      invalidate();
    },
    onError: (e) => toast.error(`删除容器失败: ${e}`),
  });

  return { action, remove };
}
