import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSettings, useUpdateSettings } from "../lib/settings";
import { useTheme, type ThemeMode } from "../lib/theme";
import { PageHeader, Select, Checkbox } from "../components/ui";
import { ConnectionSettings } from "../components/settings/ConnectionSettings";
import { MirrorSettings } from "../components/settings/MirrorSettings";
import type { AppSettings } from "../types/settings";

/** 设置分组卡片 */
function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
      <div className="border-b border-edge/60 bg-panel2/40 px-4 py-2.5 text-[13px] font-semibold text-fg">
        {title}
      </div>
      <div className="divide-y divide-edge/60">{children}</div>
    </section>
  );
}

function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-13 items-center justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] text-fg">{label}</div>
        {desc && <div className="mt-0.5 text-[11px] leading-4 text-fg3">{desc}</div>}
      </div>
      <div className="shrink-0" data-no-drag>
        {children}
      </div>
    </div>
  );
}

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function Settings() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const { setMode } = useTheme();
  const info = useQuery({
    queryKey: ["dockerInfo"],
    queryFn: api.dockerInfo,
    retry: false,
  });

  // 应用版本（mock 环境下返回占位值）
  const version = useQuery({
    queryKey: ["appVersion"],
    queryFn: async () => {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
    staleTime: Infinity,
    retry: false,
  });

  if (!settings) {
    return (
      <>
        <PageHeader title="设置" />
        <div className="flex flex-1 items-center justify-center p-8 text-[13px] text-fg3">
          正在加载设置…
        </div>
      </>
    );
  }

  /** 主题走 theme store（同步应用配色），其余设置整包提交 */
  const patch = (p: Partial<AppSettings>) => update.mutate({ ...settings, ...p });

  return (
    <>
      <PageHeader title="设置" desc="修改后自动保存" />
      <div className="flex-1 space-y-3 overflow-auto p-4 pt-3">
        <Card title="外观">
          <Row label="主题" desc="深浅色跟随或固定">
            <Select
              value={settings.theme}
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

        <ConnectionSettings />

        <Card title="轮询与刷新">
          <Row label="容器列表刷新间隔">
            <Select
              value={String(settings.containers_refresh_secs)}
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
              value={String(settings.images_refresh_secs)}
              className="w-36"
              onChange={(e) => patch({ images_refresh_secs: Number(e.target.value) })}
            >
              <option value="10">10 秒</option>
              <option value="20">20 秒</option>
              <option value="60">1 分钟</option>
              <option value="120">2 分钟</option>
            </Select>
          </Row>
        </Card>

        <Card title="日志与终端">
          <Row label="日志默认回看行数">
            <Select
              value={String(settings.logs_default_tail)}
              className="w-36"
              onChange={(e) => patch({ logs_default_tail: Number(e.target.value) })}
            >
              <option value="100">100 行</option>
              <option value="1000">1000 行</option>
              <option value="5000">5000 行</option>
              <option value="10000">10000 行</option>
            </Select>
          </Row>
          <Row label="日志默认显示时间戳">
            <Checkbox
              label="打开日志页时自动开启"
              checked={settings.logs_timestamps}
              onChange={(v) => patch({ logs_timestamps: v })}
            />
          </Row>
          <Row label="终端默认 Shell" desc="Alpine 镜像的容器建议使用 sh 或 ash">
            <Select
              value={settings.terminal_shell}
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

        <MirrorSettings />

        <Card title="关于">
          <Row label="DockPilot 版本">
            <span className="font-mono text-[13px] text-fg2">
              {version.data ?? "-"}
            </span>
          </Row>
          <Row label="Docker 引擎">
            <span className="font-mono text-[13px] text-fg2">
              {info.data
                ? `${info.data.version} (${info.data.os}/${info.data.arch})`
                : "未连接"}
            </span>
          </Row>
        </Card>
      </div>
    </>
  );
}
