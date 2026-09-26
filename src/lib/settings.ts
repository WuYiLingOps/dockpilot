import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./api";
import { setThemeMode, syncThemeFromSettings } from "./theme";
import type { AppSettings, ConnectionProfile } from "../types/settings";

/** 与后端 AppSettings::default() 对应，仅作 query 初始化占位（真实值以后端为准） */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  docker_socket: "",
  connections: [
    {
      id: "local",
      name: "本地",
      kind: "local",
      socket_path: "",
      host: "",
      cert_path: "",
      key_path: "",
      remote_socket: "",
      jump_host: "",
    },
  ],
  active_connection_id: "local",
  containers_refresh_secs: 10,
  images_refresh_secs: 20,
  logs_default_tail: 1000,
  logs_timestamps: false,
  terminal_shell: "bash",
  mirror_custom: [],
  notifications_enabled: true,
  registries: [],
};

/** 当前活跃连接配置（列表异常时回落默认本地连接） */
export function activeConnection(settings: AppSettings | undefined): ConnectionProfile {
  const fallback = DEFAULT_SETTINGS.connections[0];
  if (!settings) return fallback;
  return (
    settings.connections.find((c) => c.id === settings.active_connection_id) ??
    settings.connections.find((c) => c.kind === "local") ??
    fallback
  );
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    staleTime: Infinity,
  });
}

/** 整包提交保存（乐观更新，失败回滚） */
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (next: AppSettings) => api.setSettings(next),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: ["settings"] });
      const prev = qc.getQueryData<AppSettings>(["settings"]);
      qc.setQueryData<AppSettings>(["settings"], next);
      return { prev };
    },
    onError: (e, _next, ctx) => {
      toast.error(`保存设置失败: ${e}`);
      if (ctx?.prev) qc.setQueryData(["settings"], ctx.prev);
    },
    onSuccess: (saved) => qc.setQueryData(["settings"], saved),
  });
}

/** 切换活跃连接：成功后全量失效缓存（新连接的数据域完全不同） */
export function useSwitchConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.switchConnection(id),
    onSuccess: (p) => {
      void qc.invalidateQueries();
      toast.success(`已切换到「${p.name}」`);
    },
    onError: (e) => toast.error(String(e)),
  });
}

/** 设置加载后同步主题 + 一次性迁移旧版 localStorage 偏好 */
export function useSettingsThemeSync() {
  const { data } = useSettings();
  useEffect(() => {
    if (!data) return;
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem("dockpilot.theme");
    } catch {
      // localStorage 不可用时直接跟随设置
    }
    // 旧版本把主题存在 localStorage 且值是明确主题时，迁移进设置文件（仅一次）
    if ((legacy === "light" || legacy === "dark") && data.theme === "system") {
      setThemeMode(legacy);
      return;
    }
    syncThemeFromSettings(data.theme);
  }, [data]);
}
