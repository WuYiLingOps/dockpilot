import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ContainerDto,
  DockerEventDto,
  DockerInfoDto,
  ImageDto,
  LogChunk,
  PullProgress,
  StatsTick,
} from "../types/docker";
import type { AppSettings } from "../types/settings";
import type { CleanupResultDto, DaemonConfigDto, DiskUsageDto } from "../types/daemon";

type Unsubscribe = () => void;

/** 将 Channel 回调注册封装成 Promise<取消函数> 的模式 */
function withCancel(sidPromise: Promise<string>): Unsubscribe {
  return () => {
    void sidPromise
      .then((sid) => invoke("cancel_stream", { streamId: sid }))
      .catch(() => {});
  };
}

export const api = {
  dockerInfo: () => invoke<DockerInfoDto>("docker_info"),

  listContainers: (all = true) => invoke<ContainerDto[]>("list_containers", { all }),

  containerAction: (id: string, action: string, force = false) =>
    invoke<void>("container_action", { id, action, force }),

  listImages: () => invoke<ImageDto[]>("list_images"),

  removeImage: (id: string, force = false) =>
    invoke<void>("remove_image", { id, force }),

  pullImage: (image: string, onProgress: (p: PullProgress) => void): Unsubscribe => {
    const ch = new Channel<PullProgress>();
    ch.onmessage = onProgress;
    return withCancel(invoke<string>("pull_image", { image, onProgress: ch }));
  },

  streamLogs: (
    id: string,
    follow: boolean,
    tail: string,
    timestamps: boolean,
    onChunk: (c: LogChunk) => void,
  ): Unsubscribe => {
    const ch = new Channel<LogChunk>();
    ch.onmessage = onChunk;
    return withCancel(
      invoke<string>("stream_logs", { id, follow, tail, timestamps, onChunk: ch }),
    );
  },

  streamStats: (id: string, onTick: (t: StatsTick) => void): Unsubscribe => {
    const ch = new Channel<StatsTick>();
    ch.onmessage = onTick;
    return withCancel(invoke<string>("stream_stats", { id, onTick: ch }));
  },

  subscribeEvents: (onEvent: (e: DockerEventDto) => void): Unsubscribe => {
    const ch = new Channel<DockerEventDto>();
    ch.onmessage = onEvent;
    void invoke("subscribe_events", { onEvent: ch }).catch(() => {});
    return () => {};
  },

  execCreate: (id: string, shell: string) =>
    invoke<string>("exec_create", { id, shell }),

  execAttach: (execId: string, onData: (s: string) => void): Unsubscribe => {
    const ch = new Channel<string>();
    ch.onmessage = onData;
    return withCancel(invoke<string>("exec_attach", { execId, onChunk: ch }));
  },

  execInput: (execId: string, data: string) =>
    invoke<void>("exec_input", { execId, data }).catch(() => {}),

  execResize: (execId: string, width: number, height: number) =>
    invoke<void>("exec_resize", { execId, width, height }).catch(() => {}),

  // ---- 设置 / 镜像加速 / 空间清理 ----

  getSettings: () => invoke<AppSettings>("get_settings"),

  setSettings: (settings: AppSettings) =>
    invoke<AppSettings>("set_settings", { settings }),

  readDaemonConfig: () => invoke<DaemonConfigDto>("read_daemon_config"),

  applyMirrors: (mirrors: string[]) => invoke<void>("apply_mirrors", { mirrors }),

  restartDocker: () => invoke<void>("restart_docker"),

  /** pkexec 不可用时的回退：生成手动执行的终端命令（JSON 已在合并现有配置后生成） */
  generateMirrorsCommand: (mirrors: string[]) =>
    invoke<string>("generate_mirrors_command", { mirrors }),

  /** 测速：GET {url}/v2/，返回毫秒；不可达时抛错 */
  testMirror: (url: string) => invoke<number>("test_mirror", { url }),

  diskUsage: () => invoke<DiskUsageDto>("disk_usage"),

  cleanup: (kinds: string[]) => invoke<CleanupResultDto>("cleanup", { kinds }),
};
