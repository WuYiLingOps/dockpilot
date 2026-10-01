import { invoke, Channel } from "@tauri-apps/api/core";
import { applog } from "./applog";
import type {
  ContainerDto,
  ContainerHealthDto,
  ContainerSpec,
  ContainerTop,
  ContainerUpdateSpec,
  DockerEventDto,
  DockerInfoDto,
  ExportProgress,
  FileEntry,
  HostStatsDto,
  ImageDto,
  LogChunk,
  NetworkDto,
  NetworkSpec,
  PullProgress,
  PushProgress,
  StatsTick,
  SystemDfDto,
  VolumeDto,
  VolumeSpec,
} from "../types/docker";
import type {
  AppSettings,
  CloseAction,
  ConnectionProfile,
  ConnectionTestResult,
  RegistryProfile,
  RegistrySpec,
  RegistryTestResult,
} from "../types/settings";
import type {
  CleanupResultDto,
  DaemonConfigDto,
  DaemonValidationDto,
  DiskUsageDto,
} from "../types/daemon";
import type {
  ComposeCliInfoDto,
  ComposeOutput,
  ComposeProjectDto,
} from "../types/compose";
import type {
  AppLogCleanupResult,
  AppLogPage,
  LastCrashInfo,
  LogFileMeta,
} from "../types/diagnostics";

type Unsubscribe = () => void;

/** 将 Channel 回调注册封装成 Promise<取消函数> 的模式 */
function withCancel(sidPromise: Promise<string>): Unsubscribe {
  return () => {
    void sidPromise
      .then((sid) => invoke("cancel_stream", { streamId: sid }))
      .catch((e) => applog.errorOf("取消流任务失败", e));
  };
}

export const api = {
  dockerInfo: () => invoke<DockerInfoDto>("docker_info"),

  /** 全部运行中容器的一次性资源采样聚合（累计值，速率由调用方差分） */
  hostStats: () => invoke<HostStatsDto>("host_stats"),

  /** docker system df：总量 + 树图明细 */
  systemDf: () => invoke<SystemDfDto>("system_df"),

  listContainers: (all = true) => invoke<ContainerDto[]>("list_containers", { all }),

  containerAction: (id: string, action: string, force = false) =>
    invoke<void>("container_action", { id, action, force }),

  /** 创建并启动容器；镜像不存在时返回明确错误（可先 pullImage） */
  createContainer: (spec: ContainerSpec) =>
    invoke<string>("create_container", { spec }),

  /** 容器内进程列表（docker top，默认 ps -ef） */
  containerTop: (id: string, psArgs?: string) =>
    invoke<ContainerTop>("container_top", { id, psArgs: psArgs ?? null }),

  /** 原始 inspect JSON：kind ∈ container | image | network | volume */
  inspectDocker: (kind: string, id: string) =>
    invoke<Record<string, unknown>>("inspect_docker", { kind, id }),

  /** 在线更新运行中容器配置（docker update）；null 字段保持不变 */
  updateContainerConfig: (id: string, spec: ContainerUpdateSpec) =>
    invoke<void>("update_container_config", { id, spec }),

  /** inspect 现有容器反解析为创建规格（克隆容器用） */
  containerSpec: (id: string) => invoke<ContainerSpec>("container_spec", { id }),

  /** 解析 docker run 命令为创建规格（允许带 "docker run" 前缀整条粘贴） */
  parseDockerRun: (cmd: string) =>
    invoke<ContainerSpec>("parse_docker_run", { cmd }),

  // ---- 容器文件管理（列表/删除需容器运行中；上传下载走 archive API） ----

  /** 列出容器内目录（ls -la 解析） */
  containerListFiles: (id: string, path: string) =>
    invoke<FileEntry[]>("container_list_files", { id, path }),

  /**
   * 下载容器内文件/目录到宿主 dest（目录为 docker cp 语义：dest 下生成同名子目录）。
   * 进度经 Channel 推送，返回取消函数。
   */
  containerDownloadFile: (
    id: string,
    src: string,
    dest: string,
    onProgress: (p: ExportProgress) => void,
  ): Unsubscribe => {
    const ch = new Channel<ExportProgress>();
    ch.onmessage = onProgress;
    return withCancel(
      invoke<string>("container_download_file", { id, src, dest, onProgress: ch }),
    );
  },

  /** 上传宿主文件/目录到容器 container_dir（每项以其 basename 落盘）；返回取消函数 */
  containerUploadFile: (
    id: string,
    containerDir: string,
    localPaths: string[],
    onProgress: (p: ExportProgress) => void,
  ): Unsubscribe => {
    const ch = new Channel<ExportProgress>();
    ch.onmessage = onProgress;
    return withCancel(
      invoke<string>("container_upload_file", {
        id,
        containerDir,
        localPaths,
        onProgress: ch,
      }),
    );
  },

  /** 删除容器内文件/目录（exec rm） */
  containerDeleteFile: (id: string, path: string, recursive: boolean) =>
    invoke<void>("container_delete_file", { id, path, recursive }),

  listNetworks: () => invoke<NetworkDto[]>("list_networks"),

  createNetwork: (spec: NetworkSpec) => invoke<string>("create_network", { spec }),

  removeNetwork: (name: string) => invoke<void>("remove_network", { name }),

  connectNetwork: (network: string, container: string) =>
    invoke<void>("connect_network", { network, container }),

  disconnectNetwork: (network: string, container: string, force = false) =>
    invoke<void>("disconnect_network", { network, container, force }),

  listVolumes: () => invoke<VolumeDto[]>("list_volumes"),

  createVolume: (spec: VolumeSpec) => invoke<void>("create_volume", { spec }),

  removeVolume: (name: string, force = false) =>
    invoke<void>("remove_volume", { name, force }),

  listImages: () => invoke<ImageDto[]>("list_images"),

  removeImage: (id: string, force = false) =>
    invoke<void>("remove_image", { id, force }),

  pullImage: (image: string, onProgress: (p: PullProgress) => void): Unsubscribe => {
    const ch = new Channel<PullProgress>();
    ch.onmessage = onProgress;
    return withCancel(invoke<string>("pull_image", { image, onProgress: ch }));
  },

  /** 导出镜像为 tar（docker save；单/批量共用，共享层去重），written 为已写入字节数 */
  exportImages: (refs: string[], path: string, onProgress: (p: ExportProgress) => void): Unsubscribe => {
    const ch = new Channel<ExportProgress>();
    ch.onmessage = onProgress;
    return withCancel(invoke<string>("export_images", { refs, path, onProgress: ch }));
  },

  /** 导入镜像 tar（docker load；归档内可含多个镜像），进度复用拉取的消息结构 */
  importImage: (path: string, onProgress: (p: PullProgress) => void): Unsubscribe => {
    const ch = new Channel<PullProgress>();
    ch.onmessage = onProgress;
    return withCancel(invoke<string>("import_image", { path, onProgress: ch }));
  },

  /** 为镜像打新标签（docker tag），引用缺 tag 时后端补 latest */
  tagImage: (id: string, reference: string) =>
    invoke<void>("tag_image", { id, reference }),

  /** 移除镜像的某一个标签；返回是否连带删除了镜像（该标签是最后一个引用） */
  untagImage: (reference: string) => invoke<boolean>("untag_image", { reference }),

  /** 推送镜像到 registry（凭据经请求头传给 daemon，不落远端盘）；返回取消函数 */
  pushImage: (
    imageRef: string,
    registryId: string,
    repository: string,
    tag: string,
    onProgress: (p: PushProgress) => void,
  ): Unsubscribe => {
    const ch = new Channel<PushProgress>();
    ch.onmessage = onProgress;
    return withCancel(
      invoke<string>("push_image", {
        imageRef,
        registryId,
        repository,
        tag,
        onProgress: ch,
      }),
    );
  },

  // ---- 镜像仓库凭据 ----

  listRegistries: () => invoke<RegistryProfile[]>("list_registries"),

  /** 新建或编辑凭据；password 为空串表示保留原密码 */
  saveRegistry: (spec: RegistrySpec) =>
    invoke<RegistryProfile>("save_registry", { spec }),

  removeRegistry: (id: string) => invoke<void>("remove_registry", { id }),

  /** 测试仓库连通性与凭据有效性（skipTlsVerify 仅作用于应用侧探测） */
  testRegistry: (id: string, skipTlsVerify?: boolean) =>
    invoke<RegistryTestResult>("test_registry", { id, skipTlsVerify }),

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

  /** 健康检查详情（inspect 的 State.Health；未配置 healthcheck 时 status 为 "none"） */
  containerHealth: (id: string) =>
    invoke<ContainerHealthDto>("container_health", { id }),

  /** 导出容器日志到指定文件（系统保存对话框取得路径），返回写入字节数 */
  exportLogs: (id: string, tail: string, timestamps: boolean, path: string) =>
    invoke<number>("export_container_logs", { id, tail, timestamps, path }),

  streamStats: (id: string, onTick: (t: StatsTick) => void): Unsubscribe => {
    const ch = new Channel<StatsTick>();
    ch.onmessage = onTick;
    return withCancel(invoke<string>("stream_stats", { id, onTick: ch }));
  },

  subscribeEvents: (onEvent: (e: DockerEventDto) => void): Unsubscribe => {
    const ch = new Channel<DockerEventDto>();
    ch.onmessage = onEvent;
    void invoke("subscribe_events", { onEvent: ch }).catch((e) =>
      applog.errorOf("订阅 Docker 事件失败，列表将退化为手动刷新", e),
    );
    return () => {};
  },

  execCreate: (id: string, shell: string) =>
    invoke<string>("exec_create", { id, shell }),

  execAttach: (execId: string, onData: (s: string) => void): Unsubscribe => {
    const ch = new Channel<string>();
    ch.onmessage = onData;
    return withCancel(invoke<string>("exec_attach", { execId, onChunk: ch }));
  },

  // 终端会话已结束时写入/resize 会失败，属正常竞态，仅记日志不向 UI 报错
  execInput: (execId: string, data: string) =>
    invoke<void>("exec_input", { execId, data }).catch((e) =>
      applog.warn(`终端输入写入失败（会话可能已关闭）: ${String(e)}`),
    ),

  execResize: (execId: string, width: number, height: number) =>
    invoke<void>("exec_resize", { execId, width, height }).catch((e) =>
      applog.warn(`终端尺寸调整失败（会话可能已关闭）: ${String(e)}`),
    ),

  // ---- 设置 / 镜像加速 / 空间清理 ----

  getSettings: () => invoke<AppSettings>("get_settings"),

  setSettings: (settings: AppSettings) =>
    invoke<AppSettings>("set_settings", { settings }),

  /** 关闭询问弹窗的回传：action 决定本次行为，remember 时持久化到设置 */
  applyCloseAction: (action: CloseAction, remember: boolean) =>
    invoke<void>("apply_close_action", { action, remember }),

  /** 切换活跃连接：后端验证可达后替换连接并重启事件监听（不可达时抛错并保持原连接） */
  switchConnection: (id: string) => invoke<ConnectionProfile>("switch_connection", { id }),

  /**
   * 测试连接配置（不落盘、不影响当前连接）；ssh 类型会临时建立隧道再回收。
   * sshPassword/keyPassphrase 为瞬态参数（仅内存），支持测试尚未保存的密码连接；
   * 空值回落已保存的密钥。
   */
  testConnection: (profile: ConnectionProfile, sshPassword?: string, keyPassphrase?: string) =>
    invoke<ConnectionTestResult>("test_connection", {
      profile,
      sshPassword: sshPassword || null,
      keyPassphrase: keyPassphrase || null,
    }),

  /** 保存/清除 SSH 密钥（kind: "password" = 登录密码，"key_passphrase" = 私钥口令）；secret 空 = 清除 */
  setSshSecret: (profileId: string, kind: "password" | "key_passphrase", secret: string) =>
    invoke<void>("set_ssh_secret", { profileId, kind, secret }),

  /** 用户确认后接受主机的新指纹（覆盖 TOFU 记录） */
  acceptHostKey: (dest: string, fingerprint: string, algo: string) =>
    invoke<void>("accept_host_key", { dest, fingerprint, algo }),

  readDaemonConfig: () => invoke<DaemonConfigDto>("read_daemon_config"),

  /** 编辑器实时校验：语法 + 语义 + 尽力 dockerd 深度校验 */
  validateDaemonJson: (content: string) =>
    invoke<DaemonValidationDto>("validate_daemon_json", { content }),

  /** 整体写入 daemon.json（后端写入前会再次校验并自动备份） */
  writeDaemonJson: (content: string) => invoke<void>("write_daemon_json", { content }),

  restartDocker: () => invoke<void>("restart_docker"),

  /** pkexec 不可用时的回退：生成手动执行的终端命令（先写临时文件，经 dockerd 校验后替换） */
  generateDaemonCommand: (content: string) =>
    invoke<string>("generate_daemon_command", { content }),

  /** 测速：GET {url}/v2/，返回毫秒；不可达时抛错 */
  testMirror: (url: string) => invoke<number>("test_mirror", { url }),

  diskUsage: () => invoke<DiskUsageDto>("disk_usage"),

  cleanup: (kinds: string[]) => invoke<CleanupResultDto>("cleanup", { kinds }),

  // ---- 诊断 / 应用使用日志 ----

  /** 上次异常退出信息（后端启动时检测并缓存；正常退出/首次运行为 null） */
  getLastCrash: () => invoke<LastCrashInfo | null>("get_last_crash"),

  getLogDir: () => invoke<string>("get_log_dir"),

  listLogFiles: () => invoke<LogFileMeta[]>("list_log_files"),

  /** 读取应用日志：offset 为空读整个文件尾部（首屏），否则从该字节增量读取 */
  readAppLog: (file: string | null, offset: number | null, limit?: number) =>
    invoke<AppLogPage>("read_app_log", { file, offset, limit }),

  /** 调试日志开关：后端即时切换级别并持久化 */
  setDebugLogging: (enabled: boolean) =>
    invoke<void>("set_debug_logging", { enabled }),

  /** 导出诊断包（tar：日志 + panic 报告 + 系统信息），path 为保存对话框返回的完整路径 */
  exportDiagnostics: (path: string) => invoke<string>("export_diagnostics", { path }),

  /** 把某个日志文件复制到用户选择的路径，返回字节数 */
  exportAppLogFile: (file: string, dest: string) =>
    invoke<number>("copy_log_file", { file, dest }),

  /** 按当前设置的保留天数立即清理过期日志 */
  cleanupAppLogs: () => invoke<AppLogCleanupResult>("cleanup_app_logs"),

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

  /** 只读查看 compose 文件内容 */
  readComposeFile: (path: string) =>
    invoke<string>("read_compose_file", { path }),

  /** 保存 compose 文件（保存前做语法预检并自动备份原文件为 .bak） */
  writeComposeFile: (path: string, content: string) =>
    invoke<void>("write_compose_file", { path, content }),
};
