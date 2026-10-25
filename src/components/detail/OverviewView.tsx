import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { api } from "../../lib/api";
import { formatBytes, formatCores } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ContainerHealthDto, StatsTick } from "../../types/docker";
import { Badge, EmptyState, healthMeta } from "../ui";

const MAX_POINTS = 60;

interface ChartLine {
  name: string;
  color: string;
  series: number[];
}

/** 平滑曲线（Catmull-Rom → 三次贝塞尔），点太少时退化为折线 */
function smoothPath(pts: readonly (readonly [number, number])[]): string {
  if (pts.length < 3) {
    return pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function Chart({
  label,
  lines,
  max,
  format,
  legend,
}: {
  label: string;
  lines: ChartLine[];
  max?: number;
  format: (n: number) => string;
  legend?: boolean;
}) {
  const t = useT();
  const gid = useId();
  const w = 600;
  const h = 140;
  const gridYs = [0.25, 0.5, 0.75];

  const all = lines.flatMap((l) => l.series);
  const top = max ?? Math.max(1, ...all) * 1.15;

  const pathOf = (series: number[]) => {
    if (series.length === 0) return { line: "", area: "" };
    const pts = series.map((v, i) => {
      const x = series.length === 1 ? 0 : (i / (series.length - 1)) * w;
      const y = h - Math.min(Math.max(v, 0) / top, 1) * (h - 6) - 3;
      return [x, y] as const;
    });
    const line = smoothPath(pts);
    const area = `${line} L${w},${h} L0,${h} Z`;
    return { line, area };
  };

  return (
    <div className="rounded-card border border-edge bg-panel p-4 shadow-[var(--app-shadow)]">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-fg2">{label}</span>
        <div className="flex items-baseline gap-3">
          {lines.map((l) => (
            <span
              key={l.name}
              className="font-mono text-[13px] tabular-nums"
              style={{ color: l.color }}
            >
              {format(l.series[l.series.length - 1] ?? 0)}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-28 w-full">
        {/* 水平网格线 */}
        {gridYs.map((r) => (
          <line
            key={r}
            x1="0"
            x2={w}
            y1={h * r}
            y2={h * r}
            className="stroke-edge"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* 底线 */}
        <line
          x1="0"
          x2={w}
          y1={h - 0.5}
          y2={h - 0.5}
          className="stroke-edge"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <defs>
          {lines.map((l) => (
            <linearGradient key={l.name} id={`${gid}-${l.name}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={l.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={l.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {lines.map((l) => {
          const { line, area } = pathOf(l.series);
          return (
            <g key={l.name}>
              {area && <path d={area} fill={`url(#${gid}-${l.name})`} />}
              {line && (
                <path
                  d={line}
                  fill="none"
                  stroke={l.color}
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center justify-between">
        {legend ? (
          <div className="flex gap-4 text-[11px] text-fg3">
            {lines.map((l) => (
              <span key={l.name} className="flex items-center gap-1">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: l.color }}
                />
                {l.name}
              </span>
            ))}
          </div>
        ) : (
          <span />
        )}
        <span className="text-[11px] text-fg3">{t("res.last60s")}</span>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border border-edge bg-panel p-4 shadow-[var(--app-shadow)]">
      <div className="text-[11px] font-medium text-fg3">{label}</div>
      <div className="mt-1 font-mono text-[17px] tabular-nums text-fg">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-fg3">{sub}</div>}
    </div>
  );
}

/** 由累计值序列求每秒速率（Docker stats 约每秒一个 tick） */
function rates(cumulative: number[]): number[] {
  return cumulative.map((v, i) => (i === 0 ? 0 : Math.max(0, v - cumulative[i - 1])));
}

/** 健康检查状态卡片（未配置 healthcheck 时不渲染；不健康时展示最近一次检查输出） */
function HealthCard({ id }: { id: string }) {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["containerHealth", id],
    queryFn: () => api.containerHealth(id),
    refetchInterval: 10000,
    retry: false,
  });
  const h: ContainerHealthDto | undefined = data;
  if (!h || h.status === "none") return null;

  const meta = healthMeta(h.status);
  const last = h.log[0];
  return (
    <div className="rounded-card border border-edge bg-panel p-4 shadow-[var(--app-shadow)]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-fg2">{t("res.healthCheck")}</span>
        <Badge tone={meta.tone}>
          {meta.label}
          {h.failing_streak > 0 ? t("res.failingStreak", { n: h.failing_streak }) : ""}
        </Badge>
      </div>
      {h.status === "unhealthy" && last && (
        <div className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-ctl bg-panel2 p-2.5 font-mono text-[11px] leading-4 text-fg2">
          {last.output || t("res.noCheckOutput")}
        </div>
      )}
    </div>
  );
}

/** 退出/未运行原因面板：把 inspect 的 State 信息翻译成可操作的提示 */
function ExitInfo({ id }: { id: string }) {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["containerHealth", id],
    queryFn: () => api.containerHealth(id),
    refetchInterval: 5000,
  });
  if (!data) return null;
  const desc = data.oom_killed
    ? t("res.oomDesc")
    : data.state === "restarting"
      ? t("res.restartLoopDesc", { code: data.exit_code })
      : data.state === "created"
        ? t("res.createdDesc")
        : data.exit_code !== 0
          ? t("res.exitedWithError", {
              code: data.exit_code,
              detail: data.error ? t("res.errorDetail", { err: data.error }) : "",
            })
          : t("res.exitedClean");
  const bad = data.oom_killed || data.state === "restarting" || data.exit_code !== 0;
  return (
    <div
      className={`rounded-card border p-4 text-[13px] leading-5 ${
        bad ? "border-err/25 bg-err/5 text-err" : "border-edge bg-panel text-fg2"
      }`}
    >
      <div className="font-medium">{desc}</div>
      <div className="mt-1 text-[12px] text-fg3">{t("res.exitHint")}</div>
    </div>
  );
}

export function OverviewView({ id, running }: { id: string; running: boolean }) {
  const t = useT();
  const [ticks, setTicks] = useState<StatsTick[]>([]);

  useEffect(() => {
    if (!running) return;
    setTicks([]);
    const unsub = api.streamStats(id, (t) => {
      setTicks((prev) => {
        const next = [...prev, t];
        return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
      });
    });
    return () => unsub();
  }, [id, running]);

  const latest = ticks[ticks.length - 1] ?? null;
  const cpu = useMemo(() => ticks.map((t) => t.cpu_percent), [ticks]);
  const mem = useMemo(() => ticks.map((t) => t.mem_percent), [ticks]);
  const rxRate = useMemo(() => rates(ticks.map((t) => t.net_rx)), [ticks]);
  const txRate = useMemo(() => rates(ticks.map((t) => t.net_tx)), [ticks]);
  const cpuLimit = latest?.cpu_limit_cores ?? null;

  if (!running) {
    return (
      <div className="h-full space-y-4 overflow-auto p-4">
        <ExitInfo id={id} />
        <EmptyState
          icon={<Activity size={40} strokeWidth={1.5} />}
          title={t("process.notRunning")}
          desc={t("res.startToSeeUsage")}
        />
      </div>
    );
  }

  return (
    <div className="h-full space-y-4 overflow-auto p-4">
      <HealthCard id={id} />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          label="CPU"
          value={`${(latest?.cpu_percent ?? 0).toFixed(1)}%`}
          sub={
            latest && cpuLimit
              ? t("res.limitShare", {
                  v: formatCores(cpuLimit),
                  pct: ((latest.cpu_percent / (cpuLimit * 100)) * 100).toFixed(1),
                })
              : undefined
          }
        />
        <StatCard
          label={t("overview.mem")}
          value={formatBytes(latest?.mem_usage ?? 0)}
          sub={
            latest
              ? t("res.limitShare", {
                  v: formatBytes(latest.mem_limit),
                  pct: (latest.mem_percent ?? 0).toFixed(1),
                })
              : undefined
          }
        />
        <StatCard
          label={t("res.netTotal")}
          value={`↓ ${formatBytes(latest?.net_rx ?? 0)}`}
          sub={`↑ ${formatBytes(latest?.net_tx ?? 0)}`}
        />
        <StatCard
          label={t("res.diskTotal")}
          value={`${t("overview.read")} ${formatBytes(latest?.block_read ?? 0)}`}
          sub={`${t("overview.write")} ${formatBytes(latest?.block_write ?? 0)}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Chart
          label={t("res.cpuUsage")}
          // 有限额时纵轴对齐限额口径（100% = 1 核），无限额时自适应峰值，避免多核用量被裁剪
          max={cpuLimit ? cpuLimit * 100 : undefined}
          format={(n) => `${n.toFixed(1)}%`}
          lines={[{ name: "CPU", color: "var(--app-accent)", series: cpu }]}
        />
        <Chart
          label={t("res.memUsage")}
          max={100}
          format={(n) => `${n.toFixed(1)}%`}
          lines={[{ name: "MEM", color: "var(--app-ok)", series: mem }]}
        />
      </div>

      <Chart
        label={t("res.netRate")}
        format={(n) => `${formatBytes(n)}/s`}
        legend
        lines={[
          { name: t("overview.down"), color: "var(--app-accent)", series: rxRate },
          { name: t("overview.up"), color: "var(--app-ok)", series: txRate },
        ]}
      />
    </div>
  );
}
