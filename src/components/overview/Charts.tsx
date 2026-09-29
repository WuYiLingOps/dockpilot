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
/* 迷你趋势线 — 实时资源泳道（CPU / 内存 / 网络 / 磁盘）                 */
/* ---------------------------------------------------------------- */

export interface SparkSeries {
  name: string;
  /** CSS 颜色（传 var(--app-chart-x)） */
  color: string;
  values: number[];
}

/** y 轴最大值取整：向上取到 1/2/5×10^n，全 0 时兜底 10KB */
export function niceMax(v: number): number {
  if (v <= 0) return 10 * 1024;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    if (v <= m * base) return m * base;
  }
  return 10 * base;
}

export function Sparkline({
  series,
  times,
  domain,
  height = 44,
  fixedMax,
}: {
  series: SparkSeries[];
  /** 各采样点时刻（毫秒），与各 series 的 values 对齐；与 domain 同时提供时按绝对时刻落位 */
  times?: number[];
  /** x 轴固定时间域 [start, end]（毫秒）。提供后窗口宽度恒定，数据从右往左逐渐填满 */
  domain?: [number, number];
  height?: number;
  /** 固定 y 上限（如 CPU/内存的 100），不传则按数据 niceMax 自动取整 */
  fixedMax?: number;
}) {
  const [ref, { width }] = useMeasure<HTMLDivElement>();
  const hasData = series.some((s) => s.values.length > 0);
  const max = fixedMax ?? niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const n = Math.max(...series.map((s) => s.values.length), 0);
  const timed = domain != null && times != null && times.length === n && n > 0 && domain[1] > domain[0];
  const PAD_Y = 3;

  const x = (i: number) => {
    if (timed && domain && times) {
      const p = (times[i] - domain[0]) / (domain[1] - domain[0]);
      // 轻微的时钟抖动可能导致样本落在域外，截断即可
      return Math.min(1, Math.max(0, p)) * width;
    }
    return n <= 1 ? width : (i / (n - 1)) * width;
  };
  const y = (v: number) => PAD_Y + (1 - Math.min(v, max) / max) * (height - PAD_Y * 2);
  const line = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = (values: number[]) =>
    values.length > 0
      ? `${line(values)} L${x(values.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`
      : "";

  return (
    <div ref={ref} className="min-w-0 flex-1" style={{ height }}>
      <svg width={width} height={height} className="overflow-visible">
        {hasData ? (
          series.map((s) => (
            <g key={s.name}>
              <path d={area(s.values)} fill={s.color} fillOpacity={0.16} stroke="none" />
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
            x2={Math.max(0, width)}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--app-edge-strong)"
            strokeDasharray="3 4"
          />
        )}
      </svg>
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

/** squarify 布局输入：item 携带原始数据（展示用），size 为参与布局的调整后面积 */
interface SquarifyInput {
  item: NamedSizeDto;
  size: number;
}

/** squarified treemap（Bruls et al. 算法的迭代版），返回实际像素布局 */
function squarify(items: SquarifyInput[], width: number, height: number): TreemapRect[] {
  const total = items.reduce((s, d) => s + d.size, 0);
  if (total <= 0 || width <= 10 || height <= 10) return [];
  const scale = (width * height) / total;
  const sorted = [...items]
    .sort((a, b) => b.size - a.size)
    .map((d) => ({ item: d.item, area: d.size * scale }));

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
  "var(--app-chart-7)",
  "var(--app-chart-8)",
  "var(--app-chart-9)",
  "var(--app-chart-10)",
];

/** 按名称稳定散列取图表色：同一名称每次渲染同色，列表重排 / 数据刷新不跳色 */
export function stableChartColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CHART_COLORS[h % CHART_COLORS.length];
}

/** 多色渐变小样：图例中表示"该类目下按名称多彩着色" */
export const CHART_COLORS_SWATCH = `linear-gradient(135deg, ${CHART_COLORS.join(", ")})`;

/** 跟随鼠标的悬停信息卡：fixed 定位不随滚动容器裁剪，靠近视口边缘时自动翻转 */
function TreemapTooltip({
  item,
  total,
  x,
  y,
  extra,
}: {
  item: NamedSizeDto;
  total: number;
  x: number;
  y: number;
  extra?: ReactNode;
}) {
  const pct = total > 0 ? ((item.size / total) * 100).toFixed(1) : "0.0";
  // 翻转与夹取用的估算尺寸（与 max-width 一致；高度按最多几行估）
  const W = 280;
  const H = 120;
  const flipX = x + 12 + W > window.innerWidth;
  const left = flipX ? Math.max(8, x - 12 - W) : x + 12;
  const top = Math.min(Math.max(8, y + 12), Math.max(8, window.innerHeight - H - 8));
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-[280px] rounded-ctl border border-edge bg-panel px-3 py-2 shadow-[var(--app-shadow)]"
      style={{ left, top }}
    >
      <div className="break-all font-mono text-[11px] font-medium text-fg">
        {item.name}
      </div>
      <div className="mt-1 flex items-baseline gap-2 text-[11px] text-fg2">
        <span className="font-semibold tabular-nums text-fg">
          {formatBytes(item.size)}
        </span>
        <span className="tabular-nums text-fg3">占比 {pct}%</span>
      </div>
      {extra}
    </div>
  );
}

/** 最小可见占比：过小（含 0 B）的项在树图中至少占该比例的面积，避免被大项完全
 *  吞掉而"消失"（如可写层为 0、数据都在卷里的容器）；真实大小与占比仍以原始
 *  数据为准，看悬停信息卡或列表视图 */
const MIN_VISIBLE_SHARE = 0.03;

function toLayoutInputs(items: NamedSizeDto[]): SquarifyInput[] {
  if (items.length === 0) return [];
  const total = items.reduce((s, d) => s + d.size, 0);
  // 全部为 0 时均分展示，避免整图只剩一个空态
  if (total <= 0) return items.map((item) => ({ item, size: 1 }));
  const floor = total * MIN_VISIBLE_SHARE;
  return items.map((item) => ({ item, size: Math.max(item.size, floor) }));
}

export function Treemap({
  items,
  height = 240,
  formatLabel,
  colorFor,
  tooltipExtra,
  onSelect,
}: {
  items: NamedSizeDto[];
  height?: number;
  /** 展示名的压缩函数（完整名始终保留在悬停信息卡里） */
  formatLabel?: (name: string) => string;
  /** 格子着色函数（语义着色），缺省按索引取图表色板 */
  colorFor?: (item: NamedSizeDto, index: number) => string;
  /** 悬停信息卡的附加行（在名称/大小/占比之后），如容器运行状态 */
  tooltipExtra?: (item: NamedSizeDto) => ReactNode;
  /** 点击格子的回调（提供后格子显示手型光标），如跳转容器详情 */
  onSelect?: (item: NamedSizeDto) => void;
}) {
  const [ref, { width }] = useMeasure<HTMLDivElement>();
  const rects = squarify(toLayoutInputs(items), width, height);
  const total = items.reduce((s, d) => s + d.size, 0);
  const [hover, setHover] = useState<{
    item: NamedSizeDto;
    x: number;
    y: number;
  } | null>(null);

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
        <>
          <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
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
              const fill = colorFor
                ? colorFor(r.item, i)
                : CHART_COLORS[i % CHART_COLORS.length];
              return (
                <g
                  key={`${r.item.name}-${i}`}
                  className={onSelect ? "cursor-pointer" : undefined}
                  onMouseMove={(e) =>
                    setHover({ item: r.item, x: e.clientX, y: e.clientY })
                  }
                  onClick={() => onSelect?.(r.item)}
                >
                  <rect
                    x={rx}
                    y={ry}
                    width={rw}
                    height={rh}
                    rx={5}
                    fill={fill}
                    fillOpacity={0.82}
                    stroke="var(--app-panel)"
                    strokeWidth={1}
                  />
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
          {hover && (
            <TreemapTooltip
              item={hover.item}
              total={total}
              x={hover.x}
              y={hover.y}
              extra={tooltipExtra?.(hover.item)}
            />
          )}
        </>
      )}
    </div>
  );
}
