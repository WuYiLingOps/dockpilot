import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import type { StatsTick } from "../types/docker";
import { EmptyState, PageHeader, Select } from "../components/ui";

const MAX_POINTS = 60;

interface ChartLine {
  name: string;
  color: string;
  series: number[];
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

  const all = lines.flatMap((l) => l.series);
  const top = max ?? Math.max(1, ...all) * 1.15;

  const pathOf = (series: number[]) => {
    if (series.length === 0) return { line: "", area: "" };
    const pts = series.map((v, i) => {
      const x = series.length === 1 ? 0 : (i / (series.length - 1)) * w;
      const y = h - Math.min(Math.max(v, 0) / top, 1) * (h - 4) - 2;
      return [x, y] as const;
    });
    const line = pts
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
    const area = `${line} L${w},${h} L0,${h} Z`;
    return { line, area };
  };

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-xs text-zinc-500">{label}</span>
        <div className="flex items-baseline gap-3">
          {lines.map((l) => (
            <span key={l.name} className="font-mono text-sm" style={{ color: l.color }}>
              {format(l.series[l.series.length - 1] ?? 0)}
            </span>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="h-28 w-full overflow-visible"
      >
        <defs>
          {lines.map((l) => (
            <linearGradient
              key={l.name}
              id={`${gid}-${l.name}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={l.color} stopOpacity="0.3" />
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
                <path d={line} fill="none" stroke={l.color} strokeWidth="1.5" />
              )}
            </g>
          );
        })}
      </svg>
      {legend && (
        <div className="mt-1 flex gap-4 text-[10px] text-zinc-500">
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
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-lg text-zinc-100">{value}</div>
      {sub && <div className="text-[10px] text-zinc-500">{sub}</div>}
    </div>
  );
}

/** 由累计值序列求每秒速率（Docker stats 约每秒一个 tick） */
function rates(cumulative: number[]): number[] {
  return cumulative.map((v, i) =>
    i === 0 ? 0 : Math.max(0, v - cumulative[i - 1]),
  );
}

export function Monitor() {
  const containers = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
  });
  const running = (containers.data ?? []).filter((c) => c.state === "running");

  const [id, setId] = useState("");
  const [ticks, setTicks] = useState<StatsTick[]>([]);

  useEffect(() => {
    if (!id && running.length > 0) setId(running[0].id);
    if (id && running.length > 0 && !running.some((c) => c.id === id)) {
      setId(running[0].id);
    }
  }, [running, id]);

  useEffect(() => {
    if (!id) return;
    setTicks([]);
    const unsub = api.streamStats(id, (t) => {
      setTicks((prev) => {
        const next = [...prev, t];
        return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
      });
    });
    return () => unsub();
  }, [id]);

  const latest = ticks[ticks.length - 1] ?? null;
  const cpu = useMemo(() => ticks.map((t) => t.cpu_percent), [ticks]);
  const mem = useMemo(() => ticks.map((t) => t.mem_percent), [ticks]);
  const rxRate = useMemo(() => rates(ticks.map((t) => t.net_rx)), [ticks]);
  const txRate = useMemo(() => rates(ticks.map((t) => t.net_tx)), [ticks]);

  return (
    <>
      <PageHeader title="监控" desc="容器实时资源占用（约 1 秒刷新）">
        <Select value={id} onChange={(e) => setId(e.target.value)}>
          {running.length === 0 && <option value="">（无运行中的容器）</option>}
          {running.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </PageHeader>

      {running.length === 0 ? (
        <EmptyState
          icon={<Activity size={40} />}
          title="没有运行中的容器"
          desc="启动一个容器后即可查看实时资源监控"
        />
      ) : (
        <div className="flex-1 space-y-4 overflow-auto p-6">
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatCard
              label="CPU"
              value={`${(latest?.cpu_percent ?? 0).toFixed(1)}%`}
            />
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
              lines={[{ name: "CPU", color: "#34d399", series: cpu }]}
            />
            <Chart
              label="内存使用率"
              max={100}
              format={(n) => `${n.toFixed(1)}%`}
              lines={[{ name: "MEM", color: "#38bdf8", series: mem }]}
            />
          </div>

          <Chart
            label="网络速率（由累计值推算）"
            format={(n) => `${formatBytes(n)}/s`}
            legend
            lines={[
              { name: "下载", color: "#34d399", series: rxRate },
              { name: "上传", color: "#38bdf8", series: txRate },
            ]}
          />
        </div>
      )}
    </>
  );
}
