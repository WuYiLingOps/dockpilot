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
    onSuccess: (_d, vars) => {
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
