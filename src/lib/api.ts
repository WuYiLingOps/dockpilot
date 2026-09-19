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
};
