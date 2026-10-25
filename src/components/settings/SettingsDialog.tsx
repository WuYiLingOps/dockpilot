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
import { useT } from "../../lib/i18n";
import type { MsgKey } from "../../lib/i18n/zh";
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

/** 分类定义：label + keywords 供左侧搜索匹配（keywords 中英并收，两种界面语言均可命中） */
const CATEGORIES: {
  key: SettingsCategory;
  labelKey: MsgKey;
  descKey: MsgKey;
  icon: LucideIcon;
  keywords: string[];
}[] = [
  {
    key: "app",
    labelKey: "settings.catApp",
    descKey: "settings.catAppDesc",
    icon: AppWindow,
    keywords: ["刷新", "轮询", "间隔", "通知", "桌面通知", "关闭", "托盘", "后台", "最小化", "更新", "升级", "检查更新", "refresh", "interval", "notification", "close", "tray", "update"],
  },
  {
    key: "appearance",
    labelKey: "settings.catAppearance",
    descKey: "settings.catAppearanceDesc",
    icon: Palette,
    keywords: ["主题", "深色", "浅色", "暗色", "亮色", "跟随系统", "dark", "light", "theme"],
  },
  {
    key: "terminal",
    labelKey: "settings.catTerminal",
    descKey: "settings.catTerminalDesc",
    icon: Terminal,
    keywords: ["终端", "shell", "bash", "sh", "ash", "日志", "回看", "时间戳", "tail", "terminal", "log"],
  },
  {
    key: "sshkeys",
    labelKey: "settings.catSshKeys",
    descKey: "settings.catSshKeysDesc",
    icon: KeyRound,
    keywords: ["ssh", "凭证", "钥匙串", "密钥", "私钥", "指纹", "导入", "key", "identity", "fingerprint"],
  },
  {
    key: "registries",
    labelKey: "settings.catRegistries",
    descKey: "settings.catRegistriesDesc",
    icon: Package,
    keywords: ["仓库", "凭据", "registry", "harbor", "阿里云", "acr", "推送", "密码", "push", "credential"],
  },
  {
    key: "mirror",
    labelKey: "settings.catMirror",
    descKey: "settings.catMirrorDesc",
    icon: Gauge,
    keywords: ["加速", "镜像源", "镜像站", "daemon", "daemon.json", "mirror", "测速", "源", "registry mirror"],
  },
  {
    key: "sync",
    labelKey: "settings.catSync",
    descKey: "settings.catSyncDesc",
    icon: CloudUpload,
    keywords: ["同步", "云", "gist", "github", "多设备", "备份", "合并", "sync", "cloud", "backup", "merge"],
  },
  {
    key: "diagnostics",
    labelKey: "settings.catDiagnostics",
    descKey: "settings.catDiagnosticsDesc",
    icon: Activity,
    keywords: ["诊断", "日志", "崩溃", "闪退", "调试", "debug", "导出", "诊断包", "异常退出", "diagnostics", "crash", "log"],
  },
  {
    key: "about",
    labelKey: "settings.catAbout",
    descKey: "settings.catAboutDesc",
    icon: Info,
    keywords: ["关于", "版本", "更新", "github", "引擎", "反馈", "issue", "star", "about", "version", "update"],
  },
];

const THEME_OPTIONS: { value: ThemeMode; labelKey: MsgKey }[] = [
  { value: "system", labelKey: "theme.system" },
  { value: "light", labelKey: "theme.light" },
  { value: "dark", labelKey: "theme.dark" },
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
  const t = useT();
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
        return t("upd.checking");
      case "available":
        return st.latest
          ? t("upd.availableVersion", { version: st.latest.latest_version })
          : t("upd.available");
      case "downloading": {
        if (!progress) return t("upd.downloading");
        const done = `${formatBytes(progress.downloaded)}${
          progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ""
        }`;
        return pct !== null
          ? t("upd.downloadingPct", { pct, done })
          : t("upd.downloadingDone", { done });
      }
      case "downloaded":
        return t("upd.downloaded");
      case "installing":
        return t("upd.installing");
      case "up-to-date":
        return t("upd.upToDate");
      case "error":
        return st.error ?? t("upd.checkFailed");
      case "idle":
        return st.lastCheckAt
          ? t("upd.lastCheck", { time: timeAgo(Math.floor(st.lastCheckAt / 1000)) })
          : t("upd.lastCheckNever");
    }
  };

  return (
    <div className="px-1 pt-1">
      <div className="flex items-center gap-3 rounded-btn px-3 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw size={15} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">{t("upd.title")}</div>
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
            {t("upd.updating")}
          </Button>
        ) : st.status === "downloaded" ? (
          <>
            <Button variant="tinted" onClick={() => void installAppUpdate()}>
              <Download size={13} />
              {t("upd.installUpdate")}
            </Button>
            {/* 自动更新失败（如无 polkit 授权代理）时的兜底出口；便携版给出手动替换指引 */}
            <Button variant="outline" onClick={() => void openDownloadedInstaller()}>
              {t("upd.openPackage")}
            </Button>
          </>
        ) : st.status === "available" && st.latest ? (
          st.latest.download ? (
            <Button variant="tinted" onClick={() => void downloadAndOpen()}>
              <Download size={13} />
              {t("upd.downloadUpdate")}
            </Button>
          ) : (
            // 未匹配到当前平台附件：回落跳转 Releases 页
            <Button variant="tinted" onClick={openReleasePage}>
              {t("upd.goDownload")}
            </Button>
          )
        ) : (
          <Button variant="outline" disabled={busy} onClick={() => void checkNow(true)}>
            {checking ? t("upd.checking") : downloading ? t("upd.downloadingShort") : t("upd.checkNow")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** 关于分组（自带查询：应用版本 / Docker 引擎） */
function AboutCard() {
  const t = useT();
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
          title={t("about.feedback")}
          desc={t("about.feedbackDesc")}
          url="https://github.com/WuYiLingOps/dockpilot/issues"
        />
        <LinkRow icon={Code2} title="GitHub" desc={t("about.sourceDesc")} url={GITHUB_URL} />
        <LinkRow
          icon={FileText}
          title={t("about.releaseNotes")}
          desc={t("about.releaseNotesDesc")}
          url="https://github.com/WuYiLingOps/dockpilot/releases"
        />
        <div className="flex w-full items-center gap-3 rounded-btn px-3 py-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
            <Container size={15} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-fg">{t("about.dockerEngine")}</div>
            <div className="truncate text-[11px] text-fg3">
              {info.data
                ? `${info.data.version} (${info.data.os}/${info.data.arch})`
                : t("about.notConnected")}
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
  const t = useT();

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
      !q ||
      `${t(c.labelKey)} ${t(c.descKey)} ${c.keywords.join(" ")}`
        .toLowerCase()
        .includes(q),
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
          <Card title={t("settings.catApp")}>
            <Row label={t("settings.containersRefresh")}>
              <Select
                value={String(settings?.containers_refresh_secs ?? 10)}
                className="w-36"
                onChange={(e) => patch({ containers_refresh_secs: Number(e.target.value) })}
              >
                <option value="5">{t("settings.secs", { n: 5 })}</option>
                <option value="10">{t("settings.secs", { n: 10 })}</option>
                <option value="30">{t("settings.secs", { n: 30 })}</option>
                <option value="60">{t("settings.min", { n: 1 })}</option>
              </Select>
            </Row>
            <Row label={t("settings.imagesRefresh")}>
              <Select
                value={String(settings?.images_refresh_secs ?? 20)}
                className="w-36"
                onChange={(e) => patch({ images_refresh_secs: Number(e.target.value) })}
              >
                <option value="10">{t("settings.secs", { n: 10 })}</option>
                <option value="20">{t("settings.secs", { n: 20 })}</option>
                <option value="60">{t("settings.min", { n: 1 })}</option>
                <option value="120">{t("settings.min", { n: 2 })}</option>
              </Select>
            </Row>
            <Row
              label={t("settings.abnormalNotify")}
              desc={t("settings.abnormalNotifyDesc")}
            >
              <Switch
                checked={settings?.notifications_enabled ?? true}
                onChange={(v) => patch({ notifications_enabled: v })}
              />
            </Row>
            <Row
              label={t("settings.autoCheckUpdates")}
              desc={t("settings.autoCheckUpdatesDesc")}
            >
              <Switch
                checked={settings?.auto_check_updates ?? true}
                onChange={(v) => patch({ auto_check_updates: v })}
              />
            </Row>
            <Row
              label={t("settings.closeAction")}
              desc={t("settings.closeActionDesc")}
            >
              <Select
                value={settings?.close_action ?? "ask"}
                className="w-36"
                onChange={(e) =>
                  patch({ close_action: e.target.value as AppSettings["close_action"] })
                }
              >
                <option value="ask">{t("closePrompt.ask")}</option>
                <option value="minimize">{t("closePrompt.minimize")}</option>
                <option value="exit">{t("closePrompt.exit")}</option>
              </Select>
            </Row>
          </Card>
        );
      case "appearance":
        return (
          <Card title={t("settings.catAppearance")}>
            <Row label={t("theme.rowLabel")} desc={t("theme.rowDesc")}>
              <Select
                value={settings?.theme ?? "system"}
                className="w-36"
                onChange={(e) => setMode(e.target.value as ThemeMode)}
              >
                {THEME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.labelKey)}
                  </option>
                ))}
              </Select>
            </Row>
            <Row
              label={t("settings.appearance.language")}
              desc={t("settings.appearance.languageDesc")}
            >
              <Select
                value={settings?.language ?? "system"}
                className="w-36"
                onChange={(e) =>
                  patch({ language: e.target.value as AppSettings["language"] })
                }
              >
                <option value="system">{t("settings.appearance.languageSystem")}</option>
                {/* 语言名称按惯例以各自语言原文展示，不随界面语言翻译 */}
                <option value="zh">简体中文</option>
                <option value="en">English</option>
              </Select>
            </Row>
          </Card>
        );
      case "terminal":
        return (
          <Card title={t("settings.catTerminal")}>
            <Row label={t("settings.logTail")}>
              <Select
                value={String(settings?.logs_default_tail ?? 1000)}
                className="w-36"
                onChange={(e) => patch({ logs_default_tail: Number(e.target.value) })}
              >
                <option value="100">{t("logs.tail", { n: 100 })}</option>
                <option value="1000">{t("logs.tail", { n: 1000 })}</option>
                <option value="5000">{t("logs.tail", { n: 5000 })}</option>
                <option value="10000">{t("logs.tail", { n: 10000 })}</option>
              </Select>
            </Row>
            <Row label={t("settings.logTimestamps")} desc={t("settings.logTimestampsDesc")}>
              <Switch
                checked={settings?.logs_timestamps ?? false}
                onChange={(v) => patch({ logs_timestamps: v })}
              />
            </Row>
            <Row label={t("settings.terminalShell")} desc={t("settings.terminalShellDesc")}>
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
            <Row label={t("settings.terminalFont")} desc={t("settings.terminalFontDesc")}>
              <Select
                value={String(settings?.terminal_font_size ?? 12.5)}
                className="w-36"
                onChange={(e) => patch({ terminal_font_size: Number(e.target.value) })}
              >
                {[11, 12, 12.5, 14, 16, 18].map((n) => (
                  <option key={n} value={String(n)}>
                    {n} px
                  </option>
                ))}
              </Select>
            </Row>
            <Row label={t("settings.terminalScrollback")} desc={t("settings.terminalScrollbackDesc")}>
              <Select
                value={String(settings?.terminal_scrollback ?? 1000)}
                className="w-36"
                onChange={(e) => patch({ terminal_scrollback: Number(e.target.value) })}
              >
                {[500, 1000, 5000, 10000].map((n) => (
                  <option key={n} value={String(n)}>
                    {t("logs.tail", { n })}
                  </option>
                ))}
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
            <SearchInput value={search} onChange={setSearch} placeholder={t("settings.searchPlaceholder")} />
          </div>
          <nav className="flex-1 space-y-0.5 overflow-auto px-2 pb-3" data-no-drag>
            {visible.map(({ key, labelKey, icon: Icon }) => (
              <button
                key={key}
                type="button"
                title={t(labelKey)}
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
                <span className="min-w-0 flex-1 truncate text-left">{t(labelKey)}</span>
              </button>
            ))}
            {visible.length === 0 && (
              <div className="px-2 py-6 text-center text-[12px] text-fg3">
                {t("settings.noMatch", { query: search.trim() })}
              </div>
            )}
          </nav>
        </div>

        {/* 右侧：分类标题 + 内容 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-4">
            <div className="min-w-0">
              <h2 className="text-[14px] font-semibold text-fg">{t(activeDef.labelKey)}</h2>
              <p className="truncate text-[11px] text-fg3">{t(activeDef.descKey)}</p>
            </div>
            <IconButton title={t("appLog.closeHint")} onClick={onClose}>
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
