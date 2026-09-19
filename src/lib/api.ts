import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ContainerDto,
  ContainerSpec,
  DockerEventDto,
  DockerInfoDto,
  ImageDto,
  LogChunk,
  NetworkDto,
  PullProgress,
  StatsTick,
} from "../types/docker";
import type { AppSettings } from "../types/settings";
import type { CleanupResultDto, DaemonConfigDto, DiskUsageDto } from "../types/daemon";
import type {
  ComposeCliInfoDto,
  ComposeOutput,
  ComposeProjectDto,
} from "../types/compose";

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

  /** 创建并启动容器；镜像不存在时返回明确错误（可先 pullImage） */
  createContainer: (spec: ContainerSpec) =>
    invoke<string>("create_container", { spec }),

  listNetworks: () => invoke<NetworkDto[]>("list_networks"),

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

  // ---- 编排（docker compose）----

  listComposeProjects: () => invoke<ComposeProjectDto[]>("list_compose_projects"),

  composeCliInfo: () => invoke<ComposeCliInfoDto>("compose_cli_info"),

  /** 对项目执行操作，输出经 Channel 流式推送；返回取消函数（会 kill 子进程） */
  composeAction: (
    project: string,
    action: string,
    opts: { removeVolumes?: boolean; removeImages?: boolean; services?: string[] },
    onOutput: (o: ComposeOutput) => void,
  ): Unsubscribe => {
    const ch = new Channel<ComposeOutput>();
    ch.onmessage = onOutput;
    return withCancel(
      invoke<string>("compose_action", {
        project,
        action,
        removeVolumes: opts.removeVolumes ?? false,
        removeImages: opts.removeImages ?? false,
        services: opts.services ?? [],
        onOutput: ch,
      }),
    );
  },

  /** 部署新项目：选择 compose 文件后执行 up -d */
  composeDeploy: (
    files: string[],
    projectDir: string,
    projectName: string,
    onOutput: (o: ComposeOutput) => void,
  ): Unsubscribe => {
    const ch = new Channel<ComposeOutput>();
    ch.onmessage = onOutput;
    return withCancel(
      invoke<string>("compose_deploy", {
        files,
        projectDir,
        projectName,
        onOutput: ch,
      }),
    );
  },

  /** 只读查看 compose 文件内容 */
  readComposeFile: (path: string) =>
    invoke<string>("read_compose_file", { path }),

  /** 保存 compose 文件（保存前做语法预检并自动备份原文件为 .bak） */
  writeComposeFile: (path: string, content: string) =>
    invoke<void>("write_compose_file", { path, content }),
};
