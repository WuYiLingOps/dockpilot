import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChartPie,
  Gauge,
  HardDrive,
  Info,
  Network,
  RefreshCw,
} from "lucide-react";
import { api } from "../lib/api";
import { formatBytes, imageShortRef } from "../lib/format";
import type { HostStatsDto } from "../types/docker";
import type { PageKey } from "../components/Sidebar";
import { cn, IconButton, PageHeader, SegmentedControl, Spinner } from "../components/ui";
import {
  AreaLineChart,
  CHART_COLORS,
  Donut,
  Treemap,
} from "../components/overview/Charts";

/** 折线图滚动窗口长度（采样间隔 2s，约 2 分钟） */
const HISTORY_MAX = 60;

interface Sample {
  t: number;
  /** 0-100，占全部核心 */
  cpuPct: number;
  /** B/s */
  rxRate: number;
  txRate: number;
  rdRate: number;
  wrRate: number;
}

type UsageTab = "containers" | "images" | "volumes";

const USAGE_TABS: { key: UsageTab; label: string }[] = [
  { key: "containers", label: "容器" },
  { key: "images", label: "镜像" },
  { key: "volumes", label: "存储卷" },
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatClock(d: Date): string {
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function Card({
  icon: Icon,
  title,
  extra,
  className,
  children,
}: {
  icon: typeof Info;
  title: string;
  extra?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge/60 px-4 py-2.5 text-[12px] font-medium text-fg2">
        <Icon size={13} className="text-fg3" />
        {title}
        {extra && <div className="ml-auto flex items-center gap-2">{extra}</div>}
      </div>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 py-[3px]">
      <span className="w-20 shrink-0 text-right text-[12px] text-fg3">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-[12px] text-fg">{value}</span>
    </div>
  );
}

function StatCell({
  label,
  value,
  sub,
  onDetail,
}: {
  label: string;
  value: string;
  sub?: string;
  onDetail?: () => void;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-fg3">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="truncate text-[16px] font-semibold tabular-nums text-fg">{value}</span>
        {onDetail && (
          <button
            type="button"
            onClick={onDetail}
            className="shrink-0 text-[11px] text-accent hover:underline"
          >
            详情
          </button>
        )}
      </div>
      {sub && <div className="truncate text-[11px] text-fg3">{sub}</div>}
    </div>
  );
}

export function Overview({
  onNavigate,
}: {
  /** tab 参数用于跳转「存储和网络」页的对应子 Tab */
  onNavigate: (p: PageKey, tab?: string) => void;
}) {
  const info = useQuery({
    queryKey: ["dockerInfo"],
    queryFn: api.dockerInfo,
    retry: false,
    refetchInterval: 15000,
  });
  const stats = useQuery({
    queryKey: ["hostStats"],
    queryFn: api.hostStats,
    refetchInterval: 2000,
  });
  const df = useQuery({
    queryKey: ["systemDf"],
    queryFn: api.systemDf,
    refetchInterval: 30000,
  });
  const networks = useQuery({
    queryKey: ["networks"],
    queryFn: api.listNetworks,
    refetchInterval: 60000,
  });
  const containers = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
    refetchInterval: 15000,
  });

  // 相邻两次 host_stats 采样差分出 CPU% 与网速/磁盘速率，滚动窗口供折线图。
  // 采样时间取 dataUpdatedAt（数据真实抓取时刻）：切页回来时缓存里的旧样本
  // 与新样本间隔较大，靠 dt>10s 的保护跳过，避免假尖峰。
  const [history, setHistory] = useState<Sample[]>([]);
  const prevRef = useRef<{ at: number; data: HostStatsDto } | null>(null);

  useEffect(() => {
    const cur = stats.data;
    if (!cur) return;
    const at = stats.dataUpdatedAt || Date.now();
    const prev = prevRef.current;
    prevRef.current = { at, data: cur };
    // 首份样本作差分基准；容器集合变化（启停）或间隔异常时计数器不可比，跳过该区间
    if (!prev || cur.containers_running !== prev.data.containers_running) return;
    const dt = (at - prev.at) / 1000;
    if (dt <= 0 || dt > 10) return;
    const dCpu = cur.cpu_total - prev.data.cpu_total;
    const dSys = cur.system_cpu - prev.data.system_cpu;
    const rate = (a: number, b: number) => Math.max(0, (a - b) / dt);
    setHistory((h) => [
      ...h.slice(-(HISTORY_MAX - 1)),
      {
        t: at,
        cpuPct:
          dSys > 0
            ? Math.min(100, Math.max(0, (dCpu / dSys) * cur.online_cpus * 100))
            : 0,
        rxRate: rate(cur.net_rx, prev.data.net_rx),
        txRate: rate(cur.net_tx, prev.data.net_tx),
        rdRate: rate(cur.block_read, prev.data.block_read),
        wrRate: rate(cur.block_write, prev.data.block_write),
      },
    ]);
  }, [stats.data]);

  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    // 动态导入以维持 Settings 页同样的懒加载方式（浏览器预览下 mock 会兜底）
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => setAppVersion(v ?? ""))
      .catch(() => {});
  }, []);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const [usageTab, setUsageTab] = useState<UsageTab>("containers");
  const [refreshing, setRefreshing] = useState(false);

  const last = history[history.length - 1];
  const memUsed = stats.data?.mem_used ?? 0;
  const memTotal = info.data?.mem_total ?? 0;
  const cpuPct = last?.cpuPct ?? 0;
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

  const timeLabels = useMemo(() => {
    if (history.length === 0) return [];
    const picks = [0, Math.floor((history.length - 1) / 2), history.length - 1];
    return [...new Set(picks)].map((i) => formatTime(history[i].t));
  }, [history]);

  const hostPorts = useMemo(() => {
    const set = new Set<string>();
    for (const c of containers.data ?? []) {
      if (c.state !== "running") continue;
      for (const p of c.ports) {
        if (p.public_port != null) set.add(`${p.public_port}/${p.proto ?? "tcp"}`);
      }
    }
    return set.size;
  }, [containers.data]);

  const infoRows = useMemo(() => {
    const d = info.data;
    const rows: [string, string][] = [
      ["面板信息", appVersion ? `DockPilot v${appVersion}` : ""],
      ["Docker Host", d?.host ?? ""],
      [
        "Docker 版本",
        d ? `Server: ${d.version} / API: ${d.api_version}` : "",
      ],
      [
        "系统架构",
        [d?.os_name, d?.kernel_version, d ? `${d.os} / ${d.arch}` : ""]
          .filter(Boolean)
          .join(" · "),
      ],
      [
        "Cpu / Mem",
        d?.ncpu ? `${d.ncpu} 核 / ${formatBytes(d.mem_total ?? 0)}` : "",
      ],
      ["根目录", d?.docker_root_dir ?? ""],
      ["存储驱动", d?.driver ?? ""],
      ["日志驱动", d?.logging_driver ?? ""],
      ["存储插件", d?.plugins_volume?.join(" ") ?? ""],
      ["网络插件", d?.plugins_network?.join(" ") ?? ""],
      ["系统时间", formatClock(now)],
    ];
    return rows.filter(([, v]) => v);
  }, [info.data, appVersion, now]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.allSettled([
      info.refetch(),
      stats.refetch(),
      df.refetch(),
      networks.refetch(),
      containers.refetch(),
    ]);
    setRefreshing(false);
  };

  const dfd = df.data;

  return (
    <>
      <PageHeader title="系统概览" desc="Docker 引擎与宿主资源总览">
        <IconButton
          title="刷新"
          onClick={() => void refresh()}
          className={refreshing ? "text-accent" : ""}
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
        </IconButton>
      </PageHeader>

      {info.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4 pt-2">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Card icon={Info} title="基础信息" className="md:row-span-2">
              <div className="py-1">
                {infoRows.map(([label, value]) => (
                  <InfoRow key={label} label={label} value={value} />
                ))}
              </div>
            </Card>

            <Card icon={Gauge} title="容器占用统计" className="md:col-span-2">
              <div className="flex h-full min-h-[176px] flex-wrap items-center justify-around gap-6">
                <Donut
                  percent={cpuPct}
                  color={CHART_COLORS[0]}
                  label={`${cpuPct.toFixed(2)}%`}
                  sub={
                    stats.data
                      ? `Cpu: ${((cpuPct / 100) * (stats.data.online_cpus || 1)).toFixed(2)} / ${stats.data.online_cpus} 核`
                      : "等待采样…"
                  }
                />
                <Donut
                  percent={memPct}
                  color={CHART_COLORS[1]}
                  label={`${memPct.toFixed(2)}%`}
                  sub={`Memory: ${formatBytes(memUsed)} / ${formatBytes(memTotal)}`}
                />
              </div>
            </Card>

            <Card icon={Network} title="网络">
              <AreaLineChart
                height={156}
                series={[
                  { name: "上行", color: CHART_COLORS[0], values: history.map((s) => s.txRate) },
                  { name: "下行", color: CHART_COLORS[1], values: history.map((s) => s.rxRate) },
                ]}
                xLabels={timeLabels}
              />
            </Card>

            <Card icon={HardDrive} title="磁盘">
              <AreaLineChart
                height={156}
                series={[
                  { name: "读取", color: CHART_COLORS[0], values: history.map((s) => s.rdRate) },
                  { name: "写入", color: CHART_COLORS[1], values: history.map((s) => s.wrRate) },
                ]}
                xLabels={timeLabels}
              />
            </Card>

            <Card
              icon={ChartPie}
              title="用量统计"
              className="md:col-span-3"
              extra={
                df.dataUpdatedAt ? (
                  <span className="text-[11px] text-fg3">
                    数据最后更新：{formatTime(df.dataUpdatedAt)}
                  </span>
                ) : null
              }
            >
              <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <SegmentedControl options={USAGE_TABS} value={usageTab} onChange={setUsageTab} />
                    {dfd && (
                      <span className="text-[11px] text-fg3">
                        共 {dfd[usageTab].length} 项
                      </span>
                    )}
                  </div>
                  <Treemap
                    items={dfd?.[usageTab] ?? []}
                    height={250}
                    formatLabel={usageTab === "images" ? imageShortRef : undefined}
                  />
                </div>

                <div className="grid shrink-0 grid-cols-2 content-start gap-x-8 gap-y-5 sm:grid-cols-3 xl:w-[420px] xl:grid-cols-2">
                  <StatCell
                    label="容器"
                    value={formatBytes(dfd?.containers_size ?? 0)}
                    sub={`${dfd?.containers_count ?? 0} 个 · 根目录及写入数据`}
                    onDetail={() => onNavigate("containers")}
                  />
                  <StatCell
                    label="镜像"
                    value={formatBytes(dfd?.images_size ?? 0)}
                    sub={`${dfd?.images_count ?? 0} 个 · 包含中间镜像`}
                    onDetail={() => onNavigate("images")}
                  />
                  <StatCell
                    label="存储卷"
                    value={formatBytes(dfd?.volumes_size ?? 0)}
                    sub={`${dfd?.volumes_count ?? 0} 个 · 不含挂载目录`}
                    onDetail={() => onNavigate("storage", "volumes")}
                  />
                  <StatCell
                    label="网络"
                    value={String(networks.data?.length ?? 0)}
                    sub="自定义与内置网络"
                    onDetail={() => onNavigate("storage", "networks")}
                  />
                  <StatCell
                    label="主机端口"
                    value={String(hostPorts)}
                    sub="运行中容器的映射端口"
                    onDetail={() => onNavigate("containers")}
                  />
                  <StatCell
                    label="构建缓存"
                    value={formatBytes(dfd?.build_cache_size ?? 0)}
                    sub="docker build 层缓存"
                  />
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
