import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  AppWindow,
  KeyRound,
  Bug,
  CloudUpload,
  Code2,
  Container,
  Download,
  ExternalLink,
  FileText,
  Gauge,
  Info,
  Package,
  Palette,
  RefreshCw,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import appIcon from "../../../design/app-icon.png";
import { api } from "../../lib/api";
import {
  checkNow,
  downloadAndOpen,
  installAppUpdate,
  openDownloadedInstaller,
  openReleasePage,
  useAppUpdateStore,
} from "../../lib/appUpdate";
import { formatBytes, timeAgo } from "../../lib/format";
import { useSettings, useUpdateSettings } from "../../lib/settings";
import { useIsWindows } from "../../lib/platform";
import { useTheme, type ThemeMode } from "../../lib/theme";
import type { AppSettings } from "../../types/settings";
import { Button, IconButton, SearchInput, Select, Spinner, Switch } from "../ui";
import { Card, Row } from "./SettingsCard";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { SshKeySettings } from "./SshKeySettings";
import { MirrorSettings } from "./MirrorSettings";
import { RegistrySettings } from "./RegistrySettings";
import { SyncSettings } from "./SyncSettings";
import { cn } from "../ui";

export type SettingsCategory =
  | "app"
  | "appearance"
  | "terminal"
  | "sshkeys"
  | "registries"
  | "mirror"
  | "sync"
  | "diagnostics"
  | "about";

/** 分类定义：label + keywords 供左侧搜索匹配 */
const CATEGORIES: {
  key: SettingsCategory;
  label: string;
  desc: string;
  icon: LucideIcon;
  keywords: string[];
}[] = [
  {
    key: "app",
    label: "应用",
    desc: "刷新间隔、通知与关闭行为",
    icon: AppWindow,
    keywords: ["刷新", "轮询", "间隔", "通知", "桌面通知", "关闭", "托盘", "后台", "最小化", "更新", "升级", "检查更新"],
  },
  {
    key: "appearance",
    label: "外观",
    desc: "深浅色主题",
    icon: Palette,
    keywords: ["主题", "深色", "浅色", "暗色", "亮色", "跟随系统", "dark", "light"],
  },
  {
    key: "terminal",
    label: "终端与日志",
    desc: "终端 Shell 与容器日志默认值",
    icon: Terminal,
    keywords: ["终端", "shell", "bash", "sh", "ash", "日志", "回看", "时间戳", "tail"],
  },
  {
    key: "sshkeys",
    label: "SSH 凭证",
    desc: "钥匙串私钥管理与跨设备同步",
    icon: KeyRound,
    keywords: ["ssh", "凭证", "钥匙串", "密钥", "私钥", "指纹", "导入"],
  },
  {
    key: "registries",
    label: "镜像仓库",
    desc: "推送用的仓库凭据管理",
    icon: Package,
    keywords: ["仓库", "凭据", "registry", "harbor", "阿里云", "acr", "推送", "密码"],
  },
  {
    key: "mirror",
    label: "镜像加速",
    desc: "daemon.json 编辑与镜像源测速（Linux）",
    icon: Gauge,
    keywords: ["加速", "镜像源", "镜像站", "daemon", "daemon.json", "mirror", "测速", "源"],
  },
  {
    key: "sync",
    label: "同步与云",
    desc: "多设备配置云同步",
    icon: CloudUpload,
    keywords: ["同步", "云", "gist", "github", "多设备", "备份", "合并"],
  },
  {
    key: "diagnostics",
    label: "故障诊断",
    desc: "使用日志、崩溃详情与诊断包",
    icon: Activity,
    keywords: ["诊断", "日志", "崩溃", "闪退", "调试", "debug", "导出", "诊断包", "异常退出"],
  },
  {
    key: "about",
    label: "关于",
    desc: "版本与项目信息",
    icon: Info,
    keywords: ["关于", "版本", "更新", "github", "引擎", "反馈", "issue", "star"],
  },
];

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const GITHUB_URL = "https://github.com/WuYiLingOps/dockpilot";

/** 关于页的链接行：图标 + 标题 + 说明，点击经系统浏览器打开 */
function LinkRow({
  icon: Icon,
  title,
  desc,
  url,
}: {
  icon: LucideIcon;
  title: string;
  desc: string;
  url: string;
}) {
  return (
    <button
      type="button"
      onClick={() => openUrl(url).catch(() => {})}
      title={url}
      className="flex w-full items-center gap-3 rounded-btn px-3 py-2.5 text-left transition-colors hover:bg-hover"
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
        <Icon size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">{title}</div>
        <div className="truncate text-[11px] text-fg3">{desc}</div>
      </div>
      <ExternalLink size={12} className="shrink-0 text-fg3/60" />
    </button>
  );
}

/** 软件更新区块（关于分组）：手动检查入口、状态展示与应用内下载/自动更新（进度条 + 重启生效） */
function UpdateCheckSection() {
  const st = useAppUpdateStore();
  const checking = st.status === "checking";
  const downloading = st.status === "downloading";
  const installing = st.status === "installing";
  const busy = checking || downloading || installing;
  const progress = st.downloadProgress;
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.floor((progress.downloaded / progress.total) * 100))
      : null;

  const statusText = () => {
    switch (st.status) {
      case "checking":
        return "正在检查…";
      case "available":
        return st.latest ? `发现新版本 v${st.latest.latest_version}` : "发现新版本";
      case "downloading": {
        if (!progress) return "正在下载更新包…";
        const done = `${formatBytes(progress.downloaded)}${
          progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ""
        }`;
        return pct !== null
          ? `正在下载更新包 ${pct}%（${done}）`
          : `正在下载更新包（${done}）`;
      }
      case "downloaded":
        return "更新包已就绪";
      case "installing":
        return "正在应用更新，完成后将自动重启…";
      case "up-to-date":
        return "已是最新版本";
      case "error":
        return st.error ?? "检查失败";
      case "idle":
        return st.lastCheckAt
          ? `上次检查：${timeAgo(Math.floor(st.lastCheckAt / 1000))}`
          : "检查 GitHub 最新版本";
    }
  };

  return (
    <div className="px-1 pt-1">
      <div className="flex items-center gap-3 rounded-btn px-3 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw size={15} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">软件更新</div>
          <div
            className={cn(
              "truncate text-[11px]",
              st.status === "error" ? "text-err" : "text-fg3",
            )}
            title={st.status === "error" ? (st.error ?? undefined) : undefined}
          >
            {statusText()}
          </div>
        </div>
        {installing ? (
          <Button variant="outline" disabled>
            <Spinner className="h-3 w-3" />
            更新中…
          </Button>
        ) : st.status === "downloaded" ? (
          <>
            <Button variant="tinted" onClick={() => void installAppUpdate()}>
              <Download size={13} />
              应用更新
            </Button>
            {/* 自动更新失败（如无 polkit 授权代理）时的兜底出口；便携版给出手动替换指引 */}
            <Button variant="outline" onClick={() => void openDownloadedInstaller()}>
              打开更新包
            </Button>
          </>
        ) : st.status === "available" && st.latest ? (
          st.latest.download ? (
            <Button variant="tinted" onClick={() => void downloadAndOpen()}>
              <Download size={13} />
              下载更新
            </Button>
          ) : (
            // 未匹配到当前平台附件：回落跳转 Releases 页
            <Button variant="tinted" onClick={openReleasePage}>
              前往下载
            </Button>
          )
        ) : (
          <Button variant="outline" disabled={busy} onClick={() => void checkNow(true)}>
            {checking ? "检查中…" : downloading ? "下载中…" : "检查更新"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** 关于分组（自带查询：应用版本 / Docker 引擎） */
function AboutCard() {
  const version = useQuery({
    queryKey: ["appVersion"],
    queryFn: async () => {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
    staleTime: Infinity,
    retry: false,
  });
  const info = useQuery({
    queryKey: ["dockerInfo"],
    queryFn: api.dockerInfo,
    retry: false,
  });

  return (
    <div className="space-y-2 p-1">
      {/* 应用标识头部：图标 + 名称 + 版本 */}
      <div className="flex items-center gap-4 px-3 py-2">
        <img
          src={appIcon}
          alt="DockPilot 图标"
          draggable={false}
          className="h-14 w-14 rounded-xl shadow-[var(--app-shadow)]"
        />
        <div className="min-w-0">
          <div className="text-[22px] font-bold leading-6 text-fg">DockPilot</div>
          <div className="mt-0.5 text-[13px] text-fg3">{version.data ?? "-"}</div>
        </div>
      </div>

      {/* 检查更新：与启动提醒消费同一模块 store（lib/appUpdate） */}
      <UpdateCheckSection />

      {/* 项目链接 */}
      <div className="px-1 pt-2">
        <LinkRow
          icon={Bug}
          title="反馈问题"
          desc="报告 Bug 或提出建议"
          url="https://github.com/WuYiLingOps/dockpilot/issues"
        />
        <LinkRow icon={Code2} title="GitHub" desc="源代码，欢迎 Star" url={GITHUB_URL} />
        <LinkRow
          icon={FileText}
          title="更新内容"
          desc="查看发布说明"
          url="https://github.com/WuYiLingOps/dockpilot/releases"
        />
        <div className="flex w-full items-center gap-3 rounded-btn px-3 py-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
            <Container size={15} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-fg">Docker 引擎</div>
            <div className="truncate text-[11px] text-fg3">
              {info.data ? `${info.data.version} (${info.data.os}/${info.data.arch})` : "未连接"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 设置弹窗：左侧分类导航 + 搜索、右侧内容区（参考桌面应用的设置弹窗形态）。
 * 由侧栏「设置」、连接下拉「管理连接…」、断连引导与同步横幅唤起，
 * 可携带 initialCategory 直达分组。
 */
export function SettingsDialog({
  open,
  onClose,
  initialCategory,
}: {
  open: boolean;
  onClose: () => void;
  initialCategory?: SettingsCategory;
}) {
  const [active, setActive] = useState<SettingsCategory>("app");
  const [search, setSearch] = useState("");
  const isWindows = useIsWindows();

  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const { setMode } = useTheme();

  useEffect(() => {
    if (open && initialCategory) setActive(initialCategory);
  }, [open, initialCategory]);

  // Esc 关闭；关闭时清空搜索，避免下次打开残留过滤态。
  // 使用日志查看器盖在本弹窗之上时让位：Esc 只关查看器
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector("[data-app-log-viewer]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  // 镜像加速面向 Linux 本机 daemon（/etc/docker/daemon.json），Windows 版隐藏
  const available = CATEGORIES.filter((c) => !(isWindows && c.key === "mirror"));
  const q = search.trim().toLowerCase();
  const visible = available.filter(
    (c) =>
      !q || `${c.label} ${c.desc} ${c.keywords.join(" ")}`.toLowerCase().includes(q),
  );
  // 搜索把当前分类过滤掉时自动跳到第一个匹配项
  useEffect(() => {
    if (q && visible.length > 0 && !visible.some((c) => c.key === active)) {
      setActive(visible[0].key);
    }
  }, [q, visible, active]);

  if (!open) return null;

  /** 主题走 theme store（同步应用配色），其余设置整包提交 */
  const patch = (p: Partial<AppSettings>) => {
    if (settings) update.mutate({ ...settings, ...p });
  };

  const activeDef = available.find((c) => c.key === active) ?? available[0];

  const content = () => {
    switch (active) {
      case "app":
        return (
          <Card title="应用">
            <Row label="容器列表刷新间隔">
              <Select
                value={String(settings?.containers_refresh_secs ?? 10)}
                className="w-36"
                onChange={(e) => patch({ containers_refresh_secs: Number(e.target.value) })}
              >
                <option value="5">5 秒</option>
                <option value="10">10 秒</option>
                <option value="30">30 秒</option>
                <option value="60">1 分钟</option>
              </Select>
            </Row>
            <Row label="镜像列表刷新间隔">
              <Select
                value={String(settings?.images_refresh_secs ?? 20)}
                className="w-36"
                onChange={(e) => patch({ images_refresh_secs: Number(e.target.value) })}
              >
                <option value="10">10 秒</option>
                <option value="20">20 秒</option>
                <option value="60">1 分钟</option>
                <option value="120">2 分钟</option>
              </Select>
            </Row>
            <Row
              label="容器异常桌面通知"
              desc="容器非零退出、内存不足（OOM）或健康检查失败时发送系统通知"
            >
              <Switch
                checked={settings?.notifications_enabled ?? true}
                onChange={(v) => patch({ notifications_enabled: v })}
              />
            </Row>
            <Row
              label="自动检查更新"
              desc="启动时联网检查新版本，仅提醒不自动下载；手动「检查更新」不受此开关限制"
            >
              <Switch
                checked={settings?.auto_check_updates ?? true}
                onChange={(v) => patch({ auto_check_updates: v })}
              />
            </Row>
            <Row
              label="关闭窗口时"
              desc="每次询问为首次关闭时弹窗；最小化后应用在后台运行，容器异常通知不受影响，可从系统托盘恢复窗口或退出"
            >
              <Select
                value={settings?.close_action ?? "ask"}
                className="w-36"
                onChange={(e) =>
                  patch({ close_action: e.target.value as AppSettings["close_action"] })
                }
              >
                <option value="ask">每次询问</option>
                <option value="minimize">最小化到托盘</option>
                <option value="exit">退出应用</option>
              </Select>
            </Row>
          </Card>
        );
      case "appearance":
        return (
          <Card title="外观">
            <Row label="主题" desc="深浅色跟随或固定">
              <Select
                value={settings?.theme ?? "system"}
                className="w-36"
                onChange={(e) => setMode(e.target.value as ThemeMode)}
              >
                {THEME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Row>
          </Card>
        );
      case "terminal":
        return (
          <Card title="终端与日志">
            <Row label="日志默认回看行数">
              <Select
                value={String(settings?.logs_default_tail ?? 1000)}
                className="w-36"
                onChange={(e) => patch({ logs_default_tail: Number(e.target.value) })}
              >
                <option value="100">100 行</option>
                <option value="1000">1000 行</option>
                <option value="5000">5000 行</option>
                <option value="10000">10000 行</option>
              </Select>
            </Row>
            <Row label="日志默认显示时间戳" desc="打开日志页时自动开启">
              <Switch
                checked={settings?.logs_timestamps ?? false}
                onChange={(v) => patch({ logs_timestamps: v })}
              />
            </Row>
            <Row label="终端默认 Shell" desc="Alpine 镜像的容器建议使用 sh 或 ash">
              <Select
                value={settings?.terminal_shell ?? "bash"}
                className="w-36"
                onChange={(e) =>
                  patch({ terminal_shell: e.target.value as AppSettings["terminal_shell"] })
                }
              >
                <option value="bash">bash</option>
                <option value="sh">sh</option>
                <option value="ash">ash</option>
              </Select>
            </Row>
          </Card>
        );
      case "sshkeys":
        return <SshKeySettings />;
      case "registries":
        return <RegistrySettings />;
      case "mirror":
        return <MirrorSettings />;
      case "sync":
        return <SyncSettings />;
      case "diagnostics":
        return <DiagnosticsSettings />;
      case "about":
        return <AboutCard />;
    }
  };

  return (
    <div
      className="animate-fade fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="animate-pop flex h-[min(640px,100%)] w-full max-w-[880px] overflow-hidden rounded-xl border border-edge bg-panel shadow-[var(--app-shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧：搜索 + 分类导航 */}
        <div className="flex w-52 shrink-0 flex-col border-r border-edge bg-panel2/40">
          <div className="p-3 pb-2">
            <SearchInput value={search} onChange={setSearch} placeholder="搜索设置" />
          </div>
          <nav className="flex-1 space-y-0.5 overflow-auto px-2 pb-3" data-no-drag>
            {visible.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                title={label}
                onClick={() => setActive(key)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-btn px-2.5 py-2 text-[13px] font-medium transition-colors duration-150",
                  active === key
                    ? "bg-accent/12 text-accent"
                    : "text-fg2 hover:bg-hover hover:text-fg",
                )}
              >
                <Icon
                  size={15}
                  className={cn("shrink-0", active === key ? "" : "text-fg3")}
                />
                <span className="min-w-0 flex-1 truncate text-left">{label}</span>
              </button>
            ))}
            {visible.length === 0 && (
              <div className="px-2 py-6 text-center text-[12px] text-fg3">
                没有匹配「{search.trim()}」的设置项
              </div>
            )}
          </nav>
        </div>

        {/* 右侧：分类标题 + 内容 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-4">
            <div className="min-w-0">
              <h2 className="text-[14px] font-semibold text-fg">{activeDef.label}</h2>
              <p className="truncate text-[11px] text-fg3">{activeDef.desc}</p>
            </div>
            <IconButton title="关闭（Esc）" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4" data-no-drag>
            <div className="space-y-3">{content()}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
