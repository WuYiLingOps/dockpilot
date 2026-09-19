import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { formatBytes } from "../../lib/format";
import type { NamedSizeDto } from "../../types/docker";

/* ---------------------------------------------------------------- */
/* 尺寸观测 — SVG 按容器实际像素渲染，避免文字/描边被拉伸变形            */
/* ---------------------------------------------------------------- */

function useMeasure<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) =>
        Math.abs(s.width - width) > 0.5 || Math.abs(s.height - height) > 0.5
          ? { width, height }
          : s,
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size];
}

/* ---------------------------------------------------------------- */
/* 环形百分比 — 容器占用统计（CPU / 内存）                             */
/* ---------------------------------------------------------------- */

export function Donut({
  percent,
  color,
  label,
  sub,
  size = 132,
  stroke = 12,
}: {
  /** 0-100，负数按 0、>100 按 100 截断 */
  percent: number;
  /** CSS 颜色（传 var(--app-chart-x)） */
  color: string;
  /** 环中心的百分比文字 */
  label: string;
  /** 环下方说明 */
  sub: ReactNode;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.min(100, Math.max(0, percent));
  const arc = (c * p) / 100;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--app-edge)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arc} ${c - arc}`}
            className="transition-[stroke-dasharray] duration-500"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-[20px] font-semibold text-fg">
          {label}
        </div>
      </div>
      <div className="text-[12px] text-fg2">{sub}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 双序列面积折线 — 网络（上行/下行）、磁盘（读取/写入）                 */
/* ---------------------------------------------------------------- */

export interface AreaSeries {
  name: string;
  /** CSS 颜色（传 var(--app-chart-x)） */
  color: string;
  values: number[];
}

/** y 轴最大值取整：向上取到 1/2/5×10^n，全 0 时兜底 10KB */
function niceMax(v: number): number {
  if (v <= 0) return 10 * 1024;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    if (v <= m * base) return m * base;
  }
  return 10 * base;
}

export function AreaLineChart({
  series,
  xLabels,
  height = 170,
}: {
  series: AreaSeries[];
  /** x 轴时间标签（与采样点对应，一般只给首/中/尾几个） */
  xLabels: string[];
  height?: number;
}) {
  const [ref, { width }] = useMeasure<HTMLDivElement>();
  const hasData = series.some((s) => s.values.length > 0);
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  // 行内布局：y 轴刻度列 40px + 间距 6px + svg（svg 内右侧再留 6px）
  const PAD_R = 6;
  const PAD_Y = 4;
  const svgW = Math.max(0, width - 46);
  const plotW = Math.max(0, svgW - PAD_R);
  const n = Math.max(...series.map((s) => s.values.length), 0);

  const x = (i: number) => (n <= 1 ? plotW : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD_Y + (1 - v / max) * (height - PAD_Y * 2);
  const line = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = (values: number[]) =>
    values.length > 0
      ? `${line(values)} L${x(values.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`
      : "";

  const yTicks = [1, 0.75, 0.5, 0.25, 0];

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center justify-center gap-4">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5 text-[11px] text-fg2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: s.color }}
            />
            {s.name}
          </span>
        ))}
      </div>
      <div ref={ref} className="flex min-w-0 flex-1 gap-1.5" style={{ minHeight: height }}>
        {/* y 轴刻度 */}
        <div className="relative w-10 shrink-0 text-right text-[10px] tabular-nums text-fg3">
          {yTicks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 leading-none"
              style={{ top: y(max * t) }}
            >
              {formatBytes(max * t, 0)}
            </span>
          ))}
        </div>
        <svg width={svgW} height={height} className="overflow-visible">
          {yTicks.slice(1).map((t) => (
            <line
              key={t}
              x1={0}
              x2={svgW}
              y1={y(max * t)}
              y2={y(max * t)}
              stroke="var(--app-edge)"
              strokeDasharray="3 4"
            />
          ))}
          {hasData ? (
            series.map((s) => (
              <g key={s.name}>
                <path d={area(s.values)} fill={s.color} fillOpacity={0.22} stroke="none" />
                <path
                  d={line(s.values)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            ))
          ) : (
            <line
              x1={0}
              x2={svgW}
              y1={y(0)}
              y2={y(0)}
              stroke="var(--app-edge-strong)"
              strokeDasharray="3 4"
            />
          )}
        </svg>
      </div>
      <div className="flex justify-between pl-[46px] pr-2 text-[10px] tabular-nums text-fg3">
        {xLabels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 树图 — 用量统计（容器/镜像/存储卷 占用分布）                          */
/* ---------------------------------------------------------------- */

interface TreemapRect {
  item: NamedSizeDto;
  x: number;
  y: number;
  w: number;
  h: number;
}

/* SVG 文本不会自动换行/截断，用 canvas measureText 按真实像素宽度做省略号 */
const LABEL_FONT = '500 11px "Inter Variable", sans-serif';
const SIZE_FONT = '10px "Inter Variable", sans-serif';

let textMeasureCtx: CanvasRenderingContext2D | null = null;

function measureText(text: string, font: string): number {
  if (!textMeasureCtx) {
    textMeasureCtx = document.createElement("canvas").getContext("2d");
  }
  // canvas 不可用时按每字符 7px 粗估，仍比固定字符数截断可靠
  if (!textMeasureCtx) return text.length * 7;
  textMeasureCtx.font = font;
  return textMeasureCtx.measureText(text).width;
}

function ellipsize(text: string, maxWidth: number, font: string): string {
  if (!text || measureText(text, font) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureText(`${text.slice(0, mid)}…`, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** squarified treemap（Bruls et al. 算法的迭代版），返回实际像素布局 */
function squarify(items: NamedSizeDto[], width: number, height: number): TreemapRect[] {
  const total = items.reduce((s, d) => s + d.size, 0);
  if (total <= 0 || width <= 10 || height <= 10) return [];
  const scale = (width * height) / total;
  const sorted = items
    .filter((d) => d.size > 0)
    .sort((a, b) => b.size - a.size)
    .map((d) => ({ item: d, area: d.size * scale }));

  const out: TreemapRect[] = [];
  let idx = 0;
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;

  while (idx < sorted.length) {
    const side = Math.min(w, h);
    // 贪心填充一行：加入下一个矩形后最差长宽比变差则停止
    const row: { item: NamedSizeDto; area: number }[] = [];
    let rowArea = 0;
    let worst = Infinity;
    while (idx < sorted.length) {
      const area = sorted[idx].area;
      const thick = (rowArea + area) / side;
      if (thick <= 0) break;
      const ratio = (a: number) => Math.max(a / (thick * thick), (thick * thick) / a);
      const next = Math.max(ratio(area), ...row.map((r) => ratio(r.area)));
      if (row.length === 0 || next <= worst) {
        row.push(sorted[idx]);
        rowArea += area;
        worst = next;
        idx++;
      } else {
        break;
      }
    }
    if (row.length === 0) break;

    // 沿剩余矩形较短的边铺一行
    const thick = rowArea / side;
    if (w >= h) {
      let cy = y;
      for (const r of row) {
        const ch = r.area / thick;
        out.push({ item: r.item, x, y: cy, w: thick, h: ch });
        cy += ch;
      }
      x += thick;
      w -= thick;
    } else {
      let cx = x;
      for (const r of row) {
        const cw = r.area / thick;
        out.push({ item: r.item, x: cx, y, w: cw, h: thick });
        cx += cw;
      }
      y += thick;
      h -= thick;
    }
  }
  return out;
}

export const CHART_COLORS = [
  "var(--app-chart-1)",
  "var(--app-chart-2)",
  "var(--app-chart-3)",
  "var(--app-chart-4)",
  "var(--app-chart-5)",
  "var(--app-chart-6)",
];

export function Treemap({
  items,
  height = 240,
  formatLabel,
}: {
  items: NamedSizeDto[];
  height?: number;
  /** 展示名的压缩函数（完整名始终保留在悬停提示里） */
  formatLabel?: (name: string) => string;
}) {
  const [ref, { width }] = useMeasure<HTMLDivElement>();
  const rects = squarify(items, width, height);

  return (
    <div ref={ref} className="min-w-0 flex-1" style={{ height }}>
      {rects.length === 0 ? (
        <div
          className="flex items-center justify-center rounded-ctl border border-dashed border-edge text-[12px] text-fg3"
          style={{ height }}
        >
          暂无可统计的占用数据
        </div>
      ) : (
        <svg width={width} height={height}>
          {rects.map((r, i) => {
            const pad = 1.5;
            const rx = r.x + pad;
            const ry = r.y + pad;
            const rw = Math.max(0, r.w - pad * 2);
            const rh = Math.max(0, r.h - pad * 2);
            const showLabel = rw > 56 && rh > 22;
            const showSize = showLabel && rh > 44;
            // 文字距格边至少 6px，按实测宽度截断，避免溢出格子
            const textMax = rw - 12;
            const label = showLabel
              ? ellipsize(formatLabel?.(r.item.name) ?? r.item.name, textMax, LABEL_FONT)
              : "";
            const sizeText = showSize ? ellipsize(formatBytes(r.item.size), textMax, SIZE_FONT) : "";
            return (
              <g key={`${r.item.name}-${i}`}>
                <rect
                  x={rx}
                  y={ry}
                  width={rw}
                  height={rh}
                  rx={5}
                  fill={CHART_COLORS[i % CHART_COLORS.length]}
                  fillOpacity={0.82}
                  stroke="var(--app-panel)"
                  strokeWidth={1}
                />
                <title>{`${r.item.name}：${formatBytes(r.item.size)}`}</title>
                {showLabel && (
                  <text
                    x={rx + rw / 2}
                    y={ry + (showSize ? rh / 2 - 4 : rh / 2)}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={11}
                    fontWeight={500}
                    fill="var(--app-on-accent)"
                    className="select-none"
                  >
                    {label}
                  </text>
                )}
                {showSize && (
                  <text
                    x={rx + rw / 2}
                    y={ry + rh / 2 + 12}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={10}
                    fill="var(--app-on-accent)"
                    fillOpacity={0.85}
                    className="select-none tabular-nums"
                  >
                    {sizeText}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
