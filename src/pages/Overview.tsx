import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ChartPie,
  ChevronRight,
  Cpu,
  FolderOpen,
  HardDrive,
  Layers,
  LayoutGrid,
  List,
  MemoryStick,
  Monitor,
  Network,
  RefreshCw,
  Server,
} from "lucide-react";
import { api } from "../lib/api";
import { formatBytes, imageShortRef } from "../lib/format";
import { useSettings } from "../lib/settings";
import type { HostStatsDto, NamedSizeDto } from "../types/docker";
import type { PageKey } from "../components/Sidebar";
import {
  Button,
  cn,
  IconButton,
  Modal,
  PageHeader,
  SegmentedControl,
  Spinner,
  StatusDot,
  statusText,
} from "../components/ui";
import {
  CHART_COLORS,
  CHART_COLORS_SWATCH,
  niceMax,
  Sparkline,
  stableChartColor,
  Treemap,
  type SparkSeries,
} from "../components/overview/Charts";

/** 泳道滚动窗口：2s 采样 × HISTORY_MAX 份 ≈ 2 分钟；x 轴按固定时间域渲染，不随缓冲填充进度伸缩 */
const HISTORY_MAX = 60;
const HISTORY_WINDOW_MS = HISTORY_MAX * 2000;

interface Sample {
  t: number;
  /** 0-100，占全部核心 */
  cpuPct: number;
  /** B（绝对值，渲染时按 mem_total 换算百分比） */
  memUsed: number;
  /** B/s */
  rxRate: number;
  txRate: number;
  rdRate: number;
  wrRate: number;
}

type UsageTab = "containers" | "images" | "volumes";

// 模块级采样缓冲：概览页卸载即停止采样（不空耗连接），缓冲跨挂载保留，
// 切回页面时已有数据立即上屏；离开期间的空档在固定时间轴上自然留白
let historyBuffer: Sample[] = [];

const USAGE_TABS: { key: UsageTab; label: string }[] = [
  { key: "containers", label: "容器" },
  { key: "images", label: "镜像" },
  { key: "volumes", label: "存储卷" },
];

/** 树图/列表中“非正常态”格子的着色（已停止容器、无标签镜像） */
const MUTED_COLOR = "var(--app-fg3)";

/** 无标签镜像：system_df 取不到 tag 时命名为短 id 或 <none> */
function isUntaggedImage(name: string): boolean {
  return name.includes("<none>") || /^[0-9a-f]{12}$/.test(name);
}

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
  icon: typeof Cpu;
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

/** 泳道左栏：名称 + 当前值大字 + 可选副文本 */
interface Lane {
  key: string;
  icon: typeof Cpu;
  name: string;
  value: ReactNode;
  sub?: string;
  /** 泳道右端展示的量程 */
  scale: string;
  fixedMax?: number;
  series: SparkSeries[];
}

function LaneRow({
  lane,
  first,
  times,
  domain,
}: {
  lane: Lane;
  first: boolean;
  times: number[];
  domain: [number, number];
}) {
  const Icon = lane.icon;
  return (
    <div
      className={cn(
        "flex items-center gap-4 py-2.5",
        !first && "border-t border-edge/60",
      )}
    >
      <div className="w-40 shrink-0 sm:w-52">
        <div className="flex items-center gap-1.5 text-[12px] text-fg3">
          <Icon size={13} />
          {lane.name}
        </div>
        <div className="mt-0.5 truncate text-[14px] font-semibold tabular-nums text-fg">
          {lane.value}
        </div>
        {lane.sub && (
          <div className="mt-0.5 truncate text-[11px] text-fg3">{lane.sub}</div>
        )}
      </div>
      <Sparkline
        series={lane.series}
        times={times}
        domain={domain}
        height={44}
        fixedMax={lane.fixedMax}
      />
      <div className="hidden w-16 shrink-0 text-right text-[10px] tabular-nums text-fg3 sm:block">
        {lane.scale}
      </div>
    </div>
  );
}

/** 用量统计标题行的计数胶囊：标签 + 数字，可点击跳转 */
function CountPill({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-edge px-2 text-[11px] text-fg2 transition-colors hover:border-accent/50 hover:text-accent"
    >
      <span>{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </button>
  );
}

/** 用量构成的一行：名称+数量 | 与行对齐的占比条 | 大小 | 跳转箭头 */
function UsageRow({
  color,
  label,
  count,
  value,
  share,
  title,
  onClick,
}: {
  color: string;
  label: string;
  count?: string;
  value: string;
  /** 0-1，占总占用的比例，条长即占比 */
  share: number;
  title?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="w-36 shrink-0 sm:w-44">
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: color }}
          />
          <span className="truncate">{label}</span>
        </div>
        {count && (
          <div className="mt-0.5 truncate pl-3.5 text-[11px] text-fg3">{count}</div>
        )}
      </div>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-panel2">
        {share > 0 && (
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${Math.max(share * 100, 1)}%`,
              minWidth: 3,
              background: color,
            }}
          />
        )}
      </div>
      <div className="w-24 shrink-0 text-right text-[13px] font-semibold tabular-nums text-fg">
        {value}
      </div>
      {onClick ? (
        <span className="flex w-4 shrink-0 justify-center text-fg3 transition-colors group-hover:text-accent">
          <ChevronRight size={14} />
        </span>
      ) : (
        <span className="w-4 shrink-0" />
      )}
    </>
  );
  if (!onClick) {
    return (
      <div title={title} className="flex items-center gap-4 py-1.5">
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="group flex w-full items-center gap-4 rounded-ctl py-1.5 text-left transition-colors hover:bg-hover"
    >
      {inner}
    </button>
  );
}

/** 视图切换的小图标段（与 SegmentedControl 同视觉语言） */
function ViewBtn({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "flex h-6 w-7 items-center justify-center rounded-[5px] transition-colors",
        active ? "bg-panel text-fg shadow-sm" : "text-fg2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** 占用明细的列表视图：按大小降序逐行列出，条长即占比，便于精确对比 */
function UsageList({
  items,
  colorFor,
  formatLabel,
  onRowClick,
}: {
  items: NamedSizeDto[];
  colorFor: (item: NamedSizeDto, index: number) => string;
  formatLabel?: (name: string) => string;
  /** 行点击回调（提供后整行可点、显示手型光标），如跳转容器详情 */
  onRowClick?: (item: NamedSizeDto) => void;
}) {
  const total = items.reduce((s, d) => s + d.size, 0);
  const sorted = [...items].sort((a, b) => b.size - a.size);
  if (sorted.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-ctl border border-dashed border-edge text-[12px] text-fg3"
        style={{ height: 240 }}
      >
        暂无可统计的占用数据
      </div>
    );
  }
  return (
    <div className="h-[240px] overflow-auto pr-1">
      {sorted.map((it, i) => {
        const pct = total > 0 ? (it.size / total) * 100 : 0;
        const inner = (
          <>
            <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-fg3">
              {i + 1}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg"
              title={it.name}
            >
              {formatLabel ? formatLabel(it.name) : it.name}
            </span>
            <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-panel2 sm:w-56">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(pct, 0.5)}%`,
                  background: colorFor(it, i),
                }}
              />
            </div>
            <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-fg3">
              {pct.toFixed(1)}%
            </span>
            <span className="w-20 shrink-0 text-right text-[12px] font-semibold tabular-nums text-fg">
              {formatBytes(it.size)}
            </span>
          </>
        );
        if (!onRowClick) {
          return (
            <div
              key={`${it.name}-${i}`}
              className="flex items-center gap-3 rounded-ctl px-2 py-[7px]"
            >
              {inner}
            </div>
          );
        }
        return (
          <button
            key={`${it.name}-${i}`}
            type="button"
            onClick={() => onRowClick(it)}
            className="flex w-full items-center gap-3 rounded-ctl px-2 py-[7px] text-left transition-colors hover:bg-hover"
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

export function Overview({
  onNavigate,
}: {
  /** tab 参数用于跳转「存储和网络」页的对应子 Tab；id 用于直达容器详情 */
  onNavigate: (p: PageKey, tab?: string, id?: string) => void;
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

  // 相邻两次 host_stats 采样差分出 CPU% 与网速/磁盘速率，滚动窗口供泳道图。
  // 采样时间取 dataUpdatedAt（数据真实抓取时刻）：切页回来时缓存里的旧样本
  // 与新样本间隔较大，靠 dt>10s 的保护跳过，避免假尖峰。
  const [history, setHistory] = useState<Sample[]>(historyBuffer);
  const prevRef = useRef<{ at: number; data: HostStatsDto } | null>(null);

  // 切换连接后计数器属于另一台机器，清空缓冲防止把旧数据画进图表
  const { data: settings } = useSettings();
  const connId = settings?.active_connection_id;
  const connRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (connRef.current === undefined) {
      connRef.current = connId;
      return;
    }
    if (connId !== connRef.current) {
      connRef.current = connId;
      historyBuffer = [];
      setHistory([]);
      prevRef.current = null;
    }
  }, [connId]);

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
    historyBuffer = [
      ...historyBuffer.slice(-(HISTORY_MAX - 1)),
      {
        t: at,
        cpuPct:
          dSys > 0
            ? Math.min(100, Math.max(0, (dCpu / dSys) * cur.online_cpus * 100))
            : 0,
        memUsed: cur.mem_used,
        rxRate: rate(cur.net_rx, prev.data.net_rx),
        txRate: rate(cur.net_tx, prev.data.net_tx),
        rdRate: rate(cur.block_read, prev.data.block_read),
        wrRate: rate(cur.block_write, prev.data.block_write),
      },
    ];
    setHistory(historyBuffer);
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
  const [usageView, setUsageView] = useState<"treemap" | "list">("treemap");
  const [refreshing, setRefreshing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  const last = history[history.length - 1];
  const curMemUsed = stats.data?.mem_used ?? 0;
  const memTotal = info.data?.mem_total ?? 0;
  const cpuPct = last?.cpuPct ?? 0;
  const memPct = memTotal > 0 ? (curMemUsed / memTotal) * 100 : 0;
  const rxRate = last?.rxRate ?? 0;
  const txRate = last?.txRate ?? 0;
  const rdRate = last?.rdRate ?? 0;
  const wrRate = last?.wrRate ?? 0;

  // 固定时间域（now-2min, now）：三个标签槽位（起点/中点/当前）的数量与位置恒定，
  // 随秒级时钟前进，进页面即刻显示，不再等缓冲填充
  const chartDomain = useMemo<[number, number]>(
    () => [now.getTime() - HISTORY_WINDOW_MS, now.getTime()],
    [now],
  );
  const timeLabels = useMemo(() => {
    const [start, end] = chartDomain;
    return [start, (start + end) / 2, end].map((t) => formatTime(t));
  }, [chartDomain]);
  const chartTimes = useMemo(() => history.map((s) => s.t), [history]);

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

  // 容器名 → { id, 运行状态 }：树图/列表的语义着色、悬停信息卡与点击跳详情用
  // （system_df 明细只带名称，状态与 id 从容器列表查询按名称关联）
  const containerMetaByName = useMemo(() => {
    const m = new Map<string, { id: string; state: string }>();
    for (const c of containers.data ?? []) {
      m.set(c.name.replace(/^\/+/, ""), { id: c.id, state: c.state });
    }
    return m;
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
  const d = info.data;

  // 引擎状态条的关键项（完整 11 行在“系统信息”弹窗里）
  const engineChips = d
    ? [
        {
          icon: Server,
          text: `Docker ${d.version} · API ${d.api_version}`,
          title: "Docker 引擎版本",
        },
        {
          icon: Monitor,
          text: [d.os_name, `${d.os} / ${d.arch}`].filter(Boolean).join(" · "),
          title: "操作系统 / 架构",
        },
        {
          icon: Cpu,
          text: d.ncpu ? `${d.ncpu} 核 / ${formatBytes(d.mem_total ?? 0)}` : "",
          title: "CPU 核数 / 内存总量",
        },
        { icon: FolderOpen, text: d.docker_root_dir ?? "", title: "Docker 根目录" },
        { icon: Layers, text: d.driver ?? "", title: "存储驱动" },
      ].filter((c) => c.text)
    : [];

  // 泳道量程：网络/磁盘按当前窗口内峰值自动取整，CPU/内存固定 0–100
  const netMax = niceMax(Math.max(0, ...history.map((s) => Math.max(s.rxRate, s.txRate))));
  const diskMax = niceMax(Math.max(0, ...history.map((s) => Math.max(s.rdRate, s.wrRate))));

  const lanes: Lane[] = [
    {
      key: "cpu",
      icon: Cpu,
      name: "CPU",
      value: stats.data ? `${cpuPct.toFixed(2)} %` : "—",
      sub: stats.data
        ? `${((cpuPct / 100) * (stats.data.online_cpus || 1)).toFixed(2)} / ${stats.data.online_cpus} 核`
        : "等待采样…",
      scale: "0–100 %",
      fixedMax: 100,
      series: [
        { name: "CPU", color: CHART_COLORS[0], values: history.map((s) => s.cpuPct) },
      ],
    },
    {
      key: "mem",
      icon: MemoryStick,
      name: "内存",
      value: memTotal > 0 ? `${memPct.toFixed(2)} %` : "—",
      sub:
        memTotal > 0
          ? `${formatBytes(curMemUsed)} / ${formatBytes(memTotal)}`
          : "等待采样…",
      scale: "0–100 %",
      fixedMax: 100,
      series: [
        {
          name: "内存",
          color: CHART_COLORS[1],
          values: history.map((s) => (memTotal > 0 ? (s.memUsed / memTotal) * 100 : 0)),
        },
      ],
    },
    {
      key: "net",
      icon: Network,
      name: "网络",
      value: (
        <span className="flex items-baseline gap-2" title="上行 / 下行速率">
          <span style={{ color: CHART_COLORS[1] }}>↓ {formatBytes(rxRate)}/s</span>
          <span style={{ color: CHART_COLORS[0] }}>↑ {formatBytes(txRate)}/s</span>
        </span>
      ),
      scale: `0–${formatBytes(netMax, 0)}/s`,
      series: [
        { name: "上行", color: CHART_COLORS[0], values: history.map((s) => s.txRate) },
        { name: "下行", color: CHART_COLORS[1], values: history.map((s) => s.rxRate) },
      ],
    },
    {
      key: "disk",
      icon: HardDrive,
      name: "磁盘",
      value: (
        <span className="flex items-baseline gap-2" title="读取 / 写入速率">
          <span style={{ color: CHART_COLORS[0] }}>读 {formatBytes(rdRate)}/s</span>
          <span style={{ color: CHART_COLORS[1] }}>写 {formatBytes(wrRate)}/s</span>
        </span>
      ),
      scale: `0–${formatBytes(diskMax, 0)}/s`,
      series: [
        { name: "读取", color: CHART_COLORS[0], values: history.map((s) => s.rdRate) },
        { name: "写入", color: CHART_COLORS[1], values: history.map((s) => s.wrRate) },
      ],
    },
  ];

  // 用量统计：四类占用各占一行，条长即占比；行可点击跳转对应页面
  const usageTotal =
    (dfd?.images_size ?? 0) +
    (dfd?.containers_size ?? 0) +
    (dfd?.volumes_size ?? 0) +
    (dfd?.build_cache_size ?? 0);
  const shareOf = (v?: number) => (usageTotal > 0 ? (v ?? 0) / usageTotal : 0);
  const usageRows: {
    key: string;
    color: string;
    label: string;
    count: string;
    value: string;
    share: number;
    onClick?: () => void;
  }[] = [
    {
      key: "images",
      color: CHART_COLORS[0],
      label: "镜像",
      count: `${dfd?.images_count ?? 0} 个 · 包含中间镜像`,
      value: formatBytes(dfd?.images_size ?? 0),
      share: shareOf(dfd?.images_size),
      onClick: () => onNavigate("images"),
    },
    {
      key: "containers",
      color: CHART_COLORS[1],
      label: "容器",
      count: `${dfd?.containers_count ?? 0} 个 · 根目录及写入数据`,
      value: formatBytes(dfd?.containers_size ?? 0),
      share: shareOf(dfd?.containers_size),
      onClick: () => onNavigate("containers"),
    },
    {
      key: "volumes",
      color: CHART_COLORS[2],
      label: "存储卷",
      count: `${dfd?.volumes_count ?? 0} 个 · 不含挂载目录`,
      value: formatBytes(dfd?.volumes_size ?? 0),
      share: shareOf(dfd?.volumes_size),
      onClick: () => onNavigate("storage", "volumes"),
    },
    {
      key: "build_cache",
      color: CHART_COLORS[4],
      label: "构建缓存",
      count: "docker build 层缓存",
      value: formatBytes(dfd?.build_cache_size ?? 0),
      share: shareOf(dfd?.build_cache_size),
    },
  ];

  // 树图/列表的语义着色：正常项按名称稳定散列取多彩色板（避免同屏一色单调），
  // 异常态灰调保留语义（容器已停止 / 镜像无标签）
  const usageColorFor = (item: NamedSizeDto): string => {
    if (usageTab === "containers") {
      return containerMetaByName.get(item.name)?.state === "running"
        ? stableChartColor(item.name)
        : MUTED_COLOR;
    }
    if (usageTab === "images") {
      return isUntaggedImage(item.name) ? MUTED_COLOR : stableChartColor(item.name);
    }
    return stableChartColor(item.name);
  };

  // 悬停信息卡的附加行：容器显示运行状态，无标签镜像给出解释
  const usageTooltipExtra = (item: NamedSizeDto): ReactNode => {
    if (usageTab === "containers") {
      const meta = containerMetaByName.get(item.name);
      if (!meta) return null;
      return (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg2">
          <StatusDot state={meta.state} />
          {statusText(meta.state)}
        </div>
      );
    }
    if (usageTab === "images" && isUntaggedImage(item.name)) {
      return <div className="mt-1 text-[11px] text-fg3">无标签镜像（悬空/中间层）</div>;
    }
    return null;
  };

  // 容器格子/列表行点击 → 跳转该容器详情；名称关联不到时回退到容器列表页
  const openContainerDetail = (item: NamedSizeDto) => {
    onNavigate("containers", undefined, containerMetaByName.get(item.name)?.id);
  };

  // 图例：仅在存在语义分类时显示（如全部运行中则不显示“已停止”）
  const usageLegend = useMemo(() => {
    const items = dfd?.[usageTab] ?? [];
    if (usageTab === "containers") {
      let running = 0;
      for (const it of items) {
        if (containerMetaByName.get(it.name)?.state === "running") running++;
      }
      const stopped = items.length - running;
      return [
        ...(running > 0
          ? [{ color: CHART_COLORS_SWATCH, label: `运行中 ${running}` }]
          : []),
        ...(stopped > 0
          ? [{ color: MUTED_COLOR, label: `已停止 ${stopped}` }]
          : []),
      ];
    }
    if (usageTab === "images") {
      const untagged = items.filter((it) => isUntaggedImage(it.name)).length;
      const normal = items.length - untagged;
      return [
        ...(normal > 0 ? [{ color: CHART_COLORS_SWATCH, label: `正常 ${normal}` }] : []),
        ...(untagged > 0
          ? [{ color: MUTED_COLOR, label: `无标签 ${untagged}` }]
          : []),
      ];
    }
    return [];
  }, [usageTab, dfd, containerMetaByName]);

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
        <div className="flex flex-1 flex-col gap-3 overflow-auto p-4 pt-2">
          {/* 引擎状态条：关键项一行速览，完整信息在弹窗 */}
          <section className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-card border border-edge bg-panel px-4 py-3 shadow-[var(--app-shadow)]">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg2">
              <StatusDot
                state={d ? "running" : info.isError ? "dead" : "created"}
              />
              {d ? "引擎运行中" : info.isError ? "连接失败" : "连接中…"}
            </span>
            {engineChips.map((c, i) => (
              <span key={i} className="inline-flex min-w-0 items-center gap-1.5" title={c.title}>
                <c.icon size={12} className="shrink-0 text-fg3" />
                <span className="truncate font-mono text-[12px] text-fg2">{c.text}</span>
              </span>
            ))}
            <Button
              variant="ghost"
              className="ml-auto px-2"
              onClick={() => setInfoOpen(true)}
            >
              详情
            </Button>
          </section>

          {/* 实时资源：四条泳道共享 2 分钟时间轴 */}
          <Card
            icon={Activity}
            title="实时资源"
            className="shrink-0"
            extra={
              <span className="text-[11px] text-fg3">最近 2 分钟 · 每 2 秒采样</span>
            }
          >
            <div className="flex flex-col">
              {lanes.map((lane, i) => (
                <LaneRow
                  key={lane.key}
                  lane={lane}
                  first={i === 0}
                  times={chartTimes}
                  domain={chartDomain}
                />
              ))}
              <div className="flex gap-4 pt-1 text-[10px] tabular-nums text-fg3">
                <div className="w-40 shrink-0 sm:w-52" />
                <div className="flex min-w-0 flex-1 justify-between">
                  {timeLabels.map((l, i) => (
                    <span key={i}>{l}</span>
                  ))}
                </div>
                <div className="hidden w-16 shrink-0 sm:block" />
              </div>
            </div>
          </Card>

          {/* 用量统计：占比行列表 + 树图 */}
          <Card
            icon={ChartPie}
            title="用量统计"
            className="shrink-0"
            extra={
              <>
                <CountPill
                  label="运行中容器"
                  value={stats.data?.containers_running ?? 0}
                  onClick={() => onNavigate("containers")}
                />
                <CountPill
                  label="网络"
                  value={networks.data?.length ?? 0}
                  onClick={() => onNavigate("storage", "networks")}
                />
                <CountPill
                  label="主机端口"
                  value={hostPorts}
                  onClick={() => onNavigate("containers")}
                />
                {df.dataUpdatedAt ? (
                  <span className="hidden text-[11px] text-fg3 xl:inline">
                    数据最后更新：{formatTime(df.dataUpdatedAt)}
                  </span>
                ) : null}
              </>
            }
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2 pb-1.5">
                  <span className="text-[12px] text-fg2">磁盘占用</span>
                  <span className="text-[15px] font-semibold tabular-nums text-fg">
                    {formatBytes(usageTotal)}
                  </span>
                </div>
                {usageRows.map((r) => (
                  <UsageRow
                    key={r.key}
                    color={r.color}
                    label={r.label}
                    count={r.count}
                    value={r.value}
                    share={r.share}
                    title={`${r.label}：${r.value}`}
                    onClick={r.onClick}
                  />
                ))}
              </div>

              <div className="flex flex-col gap-3 border-t border-edge/60 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <SegmentedControl
                      options={USAGE_TABS}
                      value={usageTab}
                      onChange={setUsageTab}
                    />
                    <div className="flex items-center gap-0.5 rounded-ctl bg-panel2 p-0.5">
                      <ViewBtn
                        active={usageView === "treemap"}
                        title="树图视图"
                        onClick={() => setUsageView("treemap")}
                      >
                        <LayoutGrid size={13} />
                      </ViewBtn>
                      <ViewBtn
                        active={usageView === "list"}
                        title="列表视图"
                        onClick={() => setUsageView("list")}
                      >
                        <List size={13} />
                      </ViewBtn>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {usageLegend.map((l) => (
                      <span
                        key={l.label}
                        className="inline-flex items-center gap-1.5 text-[11px] text-fg2"
                      >
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: l.color }}
                        />
                        {l.label}
                      </span>
                    ))}
                    {dfd && (
                      <span className="text-[11px] text-fg3">
                        共 {dfd[usageTab].length} 项
                      </span>
                    )}
                  </div>
                </div>
                {usageView === "treemap" ? (
                  <Treemap
                    items={dfd?.[usageTab] ?? []}
                    height={240}
                    formatLabel={usageTab === "images" ? imageShortRef : undefined}
                    colorFor={usageColorFor}
                    tooltipExtra={usageTooltipExtra}
                    onSelect={
                      usageTab === "containers" ? openContainerDetail : undefined
                    }
                  />
                ) : (
                  <UsageList
                    items={dfd?.[usageTab] ?? []}
                    colorFor={usageColorFor}
                    formatLabel={usageTab === "images" ? imageShortRef : undefined}
                    onRowClick={
                      usageTab === "containers" ? openContainerDetail : undefined
                    }
                  />
                )}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* 完整系统信息（原基础信息 11 行） */}
      <Modal open={infoOpen} title="系统信息" onClose={() => setInfoOpen(false)}>
        <div className="py-1">
          {infoRows.map(([label, value]) => (
            <InfoRow key={label} label={label} value={value} />
          ))}
        </div>
      </Modal>
    </>
  );
}
