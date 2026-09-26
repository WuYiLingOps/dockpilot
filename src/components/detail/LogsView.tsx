import { Download, Eraser } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { useSettings } from "../../lib/settings";
import { cn, Button, Checkbox, Input, Select } from "../ui";

type Stream = "out" | "err";

interface Line {
  text: string;
  stream: Stream;
}

const MAX_LINES = 5000;

/** 容器详情 · 日志 Tab（流式、自动跟随、关键字过滤；默认值来自设置） */
export function LogsView({ id }: { id: string }) {
  const { data: settings } = useSettings();
  const [tail, setTail] = useState(() =>
    String(settings?.logs_default_tail ?? 1000),
  );
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(
    () => settings?.logs_timestamps ?? false,
  );
  const [filter, setFilter] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [exporting, setExporting] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pending = useRef<Line | null>(null);

  useEffect(() => {
    setLines([]);
    pending.current = null;
    stick.current = true;

    const push = (chunk: { stream: Stream; data: string }) => {
      const completed: Line[] = [];
      const parts = chunk.data.split("\n");
      parts.forEach((part, i) => {
        const isLast = i === parts.length - 1;
        if (pending.current) {
          pending.current.text += part;
          if (!isLast) {
            completed.push(pending.current);
            pending.current = null;
          }
        } else if (isLast) {
          if (part !== "") pending.current = { text: part, stream: chunk.stream };
        } else {
          completed.push({ text: part, stream: chunk.stream });
        }
      });
      if (completed.length > 0) {
        setLines((prev) => {
          const next = [...prev, ...completed];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      }
    };

    const unsub = api.streamLogs(id, follow, tail, timestamps, push);
    return () => unsub();
  }, [id, follow, tail, timestamps]);

  // 自动滚动到底部（用户上滚时暂停）
  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const keyword = filter.trim().toLowerCase();
  const shown = keyword
    ? lines.filter((l) => l.text.toLowerCase().includes(keyword))
    : lines;

  /** 按当前参数（回看行数/时间戳）把日志写入用户选择的文件 */
  const exportLogs = async () => {
    if (exporting) return;
    try {
      const path = await save({
        title: "导出容器日志",
        defaultPath: `container-${id.slice(0, 12)}.log`,
        filters: [{ name: "日志文件", extensions: ["log", "txt"] }],
      });
      if (!path) return;
      setExporting(true);
      const size = await api.exportLogs(id, tail, timestamps, path);
      toast.success(`已导出 ${formatBytes(size)} 日志到 ${path}`);
    } catch (e) {
      toast.error(`导出日志失败: ${e}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex h-10 shrink-0 flex-wrap items-center gap-3 border-b border-edge bg-panel px-4"
        data-no-drag
      >
        <Select
          value={tail}
          onChange={(e) => setTail(e.target.value)}
          className="w-32"
        >
          <option value="100">最近 100 行</option>
          <option value="1000">最近 1000 行</option>
          <option value="5000">最近 5000 行</option>
          <option value="10000">最近 10000 行</option>
        </Select>
        <Checkbox label="跟随" checked={follow} onChange={setFollow} />
        <Checkbox label="时间戳" checked={timestamps} onChange={setTimestamps} />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤关键字"
          className="ml-auto h-7 w-44"
        />
        <Button variant="ghost" className="h-7" onClick={() => setLines([])}>
          <Eraser size={14} />
          清屏
        </Button>
        <Button
          variant="ghost"
          className="h-7"
          title="按当前参数导出日志到文件"
          disabled={exporting}
          onClick={() => void exportLogs()}
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
        {shown.length === 0 ? (
          <div className="pt-8 text-center text-fg3">
            {lines.length === 0 ? "暂无日志输出" : "没有匹配过滤条件的行"}
          </div>
        ) : (
          shown.map((l, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-all",
                l.stream === "err" ? "text-err" : "text-fg2",
              )}
            >
              {l.text || " "}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
