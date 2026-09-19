import { useEffect, useId, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { api } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import type { StatsTick } from "../../types/docker";
import { EmptyState } from "../ui";

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
        <span className="text-[11px] text-fg3">近 60 秒</span>
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

export function OverviewView({ id, running }: { id: string; running: boolean }) {
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

  if (!running) {
    return (
      <EmptyState
        icon={<Activity size={40} strokeWidth={1.5} />}
        title="容器未运行"
        desc="启动容器后即可查看实时资源占用"
      />
    );
  }

  return (
    <div className="h-full space-y-4 overflow-auto p-4">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="CPU" value={`${(latest?.cpu_percent ?? 0).toFixed(1)}%`} />
        <StatCard
          label="内存"
          value={formatBytes(latest?.mem_usage ?? 0)}
          sub={
            latest
              ? `限额 ${formatBytes(latest.mem_limit)} · 占 ${(latest.mem_percent ?? 0).toFixed(1)}%`
              : undefined
          }
        />
        <StatCard
          label="网络累计"
          value={`↓ ${formatBytes(latest?.net_rx ?? 0)}`}
          sub={`↑ ${formatBytes(latest?.net_tx ?? 0)}`}
        />
        <StatCard
          label="磁盘 I/O 累计"
          value={`读 ${formatBytes(latest?.block_read ?? 0)}`}
          sub={`写 ${formatBytes(latest?.block_write ?? 0)}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Chart
          label="CPU 使用率"
          max={100}
          format={(n) => `${n.toFixed(1)}%`}
          lines={[{ name: "CPU", color: "var(--app-accent)", series: cpu }]}
        />
        <Chart
          label="内存使用率"
          max={100}
          format={(n) => `${n.toFixed(1)}%`}
          lines={[{ name: "MEM", color: "var(--app-ok)", series: mem }]}
        />
      </div>

      <Chart
        label="网络速率"
        format={(n) => `${formatBytes(n)}/s`}
        legend
        lines={[
          { name: "下载", color: "var(--app-accent)", series: rxRate },
          { name: "上传", color: "var(--app-ok)", series: txRate },
        ]}
      />
    </div>
  );
}
