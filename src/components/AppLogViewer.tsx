import { Download, X } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { withDragRegion } from "../lib/drag";
import { copyText } from "../lib/clipboard";
import { formatBytes } from "../lib/format";
import type { AppLogEntry, LogFileMeta } from "../types/diagnostics";
import { Button, CheckDot, IconButton, Input, SegmentedControl, Select } from "./ui";
import { cn } from "./ui";

const MAX_LINES = 5000;
const POLL_MS = 2000;

type LevelFilter = "all" | "info" | "warn" | "error";

const LEVEL_FILTERS: { key: LevelFilter; label: string; min: number }[] = [
  { key: "all", label: "全部", min: 5 },
  { key: "info", label: "Info+", min: 3 },
  { key: "warn", label: "警告", min: 2 },
  { key: "error", label: "错误", min: 1 },
];

/** 级别序数：ERROR=1 … TRACE=5（与后端 LogEntry 约定一致） */
function levelNum(level: string): number {
  switch (level) {
    case "ERROR":
      return 1;
    case "WARN":
      return 2;
    case "INFO":
      return 3;
    case "DEBUG":
      return 4;
    default:
      return 5;
  }
}

function fileLabel(name: string): string {
  if (name === "dockpilot.log") return "当前会话";
  const label = name.replace(/^dockpilot_/, "").replace(/\.log$/, "").replace("_", " ");
  return `归档 ${label}`;
}

function levelClass(level: string): string {
  if (level === "ERROR") return "text-err";
  if (level === "WARN") return "text-warn";
  if (level === "DEBUG" || level === "TRACE") return "text-fg3";
  return "text-fg2";
}

/**
 * 应用使用日志查看器（设置 → 故障诊断 / 启动横幅入口）。
 * 全屏覆盖内容区（侧栏与标题栏保持可见）；数据源为日志文件——
 * 首屏尾部加载，跟随模式下按字节 offset 每 2s 增量拉取。
 */
export function AppLogViewer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [files, setFiles] = useState<LogFileMeta[]>([]);
  const [file, setFile] = useState("dockpilot.log");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [filter, setFilter] = useState("");
  const [entries, setEntries] = useState<AppLogEntry[]>([]);
  const [follow, setFollow] = useState(true);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const offsetRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const fileRef = useRef(file);
  fileRef.current = file;

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 打开时拉取文件列表，默认选中当前会话
  useEffect(() => {
    if (!open) return;
    setFiles([]);
    void api
      .listLogFiles()
      .then((list) => {
        setFiles(list);
        if (list[0]) setFile(list[0].name);
      })
      .catch((e) => toast.error(`读取日志列表失败: ${e}`));
  }, [open]);

  // 切换文件：重置并尾部加载
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setEntries([]);
    stick.current = true;
    offsetRef.current = null;
    setLoading(true);
    api
      .readAppLog(file, null)
      .then((page) => {
        if (!alive) return;
        // 后端异常时兜底空页，避免渲染崩溃（ErrorBoundary 之外的软防御）
        offsetRef.current = page?.next_offset ?? 0;
        setEntries(page?.entries ?? []);
      })
      .catch((e) => toast.error(`读取日志失败: ${e}`))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [file, open]);

  // 跟随：按 offset 增量拉取（文件轮转导致 offset 越界时后端回落全量，前端整体替换）
  useEffect(() => {
    if (!open || !follow) return;
    const timer = setInterval(() => {
      if (busyRef.current || offsetRef.current === null) return;
      busyRef.current = true;
      api
        .readAppLog(fileRef.current, offsetRef.current)
        .then((page) => {
          if (!page) return;
          const rotated = page.next_offset < (offsetRef.current ?? 0);
          offsetRef.current = page.next_offset;
          setEntries((prev) => {
            const base = rotated ? [] : prev;
            const next = [...base, ...(page.entries ?? [])];
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        })
        .catch(() => {})
        .finally(() => {
          busyRef.current = false;
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, follow]);

  // 自动滚动到底部（用户上滚时暂停）
  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  if (!open) return null;

  const keyword = filter.trim().toLowerCase();
  const min = LEVEL_FILTERS.find((f) => f.key === level)?.min ?? 5;
  const shown = entries.filter(
    (e) =>
      levelNum(e.level) <= min &&
      (!keyword ||
        e.message.toLowerCase().includes(keyword) ||
        e.target.toLowerCase().includes(keyword)),
  );

  const exportLog = async () => {
    if (exporting) return;
    try {
      const path = await save({
        title: "导出使用日志",
        defaultPath: file,
        filters: [{ name: "日志文件", extensions: ["log", "txt"] }],
      });
      if (!path) return;
      setExporting(true);
      const size = await api.exportAppLogFile(file, path);
      toast.success(`已导出 ${formatBytes(size)} 日志到 ${path}`);
    } catch (e) {
      toast.error(`导出日志失败: ${e}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    // fixed 全窗覆盖并压过设置弹窗（z-50）：从「故障诊断」打开日志查看时
    // 盖在弹窗之上，关闭后回到弹窗上下文。data-app-log-viewer 供设置弹窗
    // 的 Esc 处理识别"查看器在前台"，避免一次 Esc 把两层一起关掉
    <div
      data-app-log-viewer
      className="fixed inset-0 z-[60] flex min-h-0 flex-col bg-canvas"
    >
      {/* 全窗覆盖层：不使用 PageHeader（它为标题栏窗口控制按钮预留了右侧边距，
              覆盖层本身已盖住那些按钮，X 应贴齐右上角） */}
      <div
        {...withDragRegion()}
        className="flex h-12 shrink-0 items-center justify-between border-b border-edge bg-panel pl-4 pr-3"
      >
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="truncate text-[15px] font-semibold text-fg">使用日志</h1>
          <p className="truncate text-xs text-fg3">DockPilot 自身运行与操作记录</p>
        </div>
        <IconButton title="关闭（Esc）" onClick={onClose} data-no-drag>
          <X size={16} />
        </IconButton>
      </div>

      <div
        className="flex h-10 shrink-0 flex-wrap items-center gap-3 border-b border-edge bg-panel px-4"
        data-no-drag
      >
        <Select
          value={file}
          className="w-52"
          onChange={(e) => setFile(e.target.value)}
        >
          {(files.length > 0 ? files : [{ name: file, size: 0, modified: null }]).map((f) => (
            <option key={f.name} value={f.name}>
              {fileLabel(f.name)}
              {f.size > 0 ? `（${formatBytes(f.size)}）` : ""}
            </option>
          ))}
        </Select>
        <SegmentedControl
          options={LEVEL_FILTERS.map(({ key, label }) => ({ key, label }))}
          value={level}
          onChange={setLevel}
        />
        <button
          type="button"
          role="checkbox"
          aria-checked={follow}
          title="自动滚动到最新日志"
          onClick={() => setFollow(!follow)}
          className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[12px] text-fg2 hover:text-fg"
        >
          <CheckDot checked={follow} />
          跟随
        </button>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤关键字"
          className="ml-auto h-7 w-44"
        />
        <Button
          variant="ghost"
          className="h-7"
          title="把当前会话/归档的日志文件复制到所选位置"
          disabled={exporting}
          onClick={() => void exportLog()}
        >
          <Download size={14} />
          导出
        </Button>
      </div>

      <div
        ref={boxRef}
        onScroll={() => {
          const el = boxRef.current;
          if (el) {
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }
        }}
        className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-5"
      >
        {loading ? (
          <div className="pt-8 text-center text-fg3">正在读取日志…</div>
        ) : shown.length === 0 ? (
          <div className="pt-8 text-center text-fg3">
            {entries.length === 0 ? "暂无日志" : "没有匹配过滤条件的条目"}
          </div>
        ) : (
          shown.map((e, i) => (
            <div
              key={i}
              title="点击复制该条日志"
              onClick={() =>
                void copyText(`[${e.ts}][${e.target}][${e.level}] ${e.message}`)
              }
              className={cn(
                "cursor-pointer whitespace-pre-wrap break-all hover:bg-hover/60",
                levelClass(e.level),
              )}
            >
              <span className="text-fg3">{e.ts}</span>{" "}
              <span className="text-fg3/70">[{e.target}]</span> {e.message || " "}
            </div>
          ))
        )}
      </div>

      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-edge bg-panel px-4 text-[11px] text-fg3">
        <span>
          {shown.length}/{entries.length} 条
          {entries.length >= MAX_LINES ? `（内存上限 ${MAX_LINES} 条，完整内容请导出）` : ""}
        </span>
        <span className="ml-auto">{follow ? "跟随中 · 每 2s 刷新" : "已暂停跟随"}</span>
      </div>
    </div>
  );
}
