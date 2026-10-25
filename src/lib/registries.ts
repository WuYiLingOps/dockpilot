import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./api";
import { t } from "./i18n";
import type { RegistrySpec } from "../types/settings";

/** 镜像仓库凭据列表（后端脱敏，不含密码） */
export function useRegistries() {
  return useQuery({
    queryKey: ["registries"],
    queryFn: api.listRegistries,
    staleTime: Infinity,
  });
}

/** 新建或编辑凭据；成功后同时失效 registries 与 settings（档案存在 settings.json 内） */
export function useSaveRegistry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spec: RegistrySpec) => api.saveRegistry(spec),
    onSuccess: (saved, spec) => {
      void qc.invalidateQueries({ queryKey: ["registries"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success(
        spec.id
          ? t("registry.saved")
          : t("registry.added", { name: saved.name }),
      );
    },
    onError: (e) => toast.error(t("registry.saveFailed", { err: String(e) })),
  });
}

/** 删除凭据档案（后端同步清理钥匙串/加密文件中的密钥） */
export function useRemoveRegistry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.removeRegistry(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["registries"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success(t("registry.deleted"));
    },
    onError: (e) => toast.error(String(e)),
  });
}
