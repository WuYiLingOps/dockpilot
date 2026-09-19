import { useQuery } from "@tanstack/react-query";
import { Eraser, ScrollText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../components/ui";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorNote,
  PageHeader,
  Select,
  Spinner,
} from "../components/ui";

type Stream = "out" | "err";

interface Line {
  text: string;
  stream: Stream;
}

const MAX_LINES = 5000;

export function Logs() {
  const containers = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
  });
  const list = containers.data ?? [];

  const [id, setId] = useState("");
  const [tail, setTail] = useState("1000");
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [filter, setFilter] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pending = useRef<Line | null>(null);

  // 默认选中第一个容器
  useEffect(() => {
    if (!id && list.length > 0) setId(list[0].id);
  }, [list, id]);

  useEffect(() => {
    if (!id) return;
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

  if (containers.isLoading) {
    return (
      <>
        <PageHeader title="日志" />
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      </>
    );
  }

  if (containers.isError) {
    return (
      <>
        <PageHeader title="日志" />
        <ErrorNote
          message={String(containers.error)}
          onRetry={() => void containers.refetch()}
        />
      </>
    );
  }

  if (list.length === 0) {
    return (
      <>
        <PageHeader title="日志" />
        <EmptyState
          icon={<ScrollText size={40} />}
          title="没有可选的容器"
          desc="先创建并运行一个容器，再回到这里查看日志"
        />
      </>
    );
  }

  const keyword = filter.trim().toLowerCase();
  const shown = keyword
    ? lines.filter((l) => l.text.toLowerCase().includes(keyword))
    : lines;

  return (
    <>
      <PageHeader title="日志" desc="流式查看容器输出">
        <Select value={id} onChange={(e) => setId(e.target.value)}>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}（{c.state === "running" ? "运行中" : c.status}）
            </option>
          ))}
        </Select>
        <Select value={tail} onChange={(e) => setTail(e.target.value)}>
          <option value="100">最近 100 行</option>
          <option value="1000">最近 1000 行</option>
          <option value="5000">最近 5000 行</option>
          <option value="10000">最近 10000 行</option>
        </Select>
        <Checkbox label="跟随" checked={follow} onChange={setFollow} />
        <Checkbox label="时间戳" checked={timestamps} onChange={setTimestamps} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤关键字"
          className="h-9 w-40 rounded-lg border border-edge bg-panel px-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-emerald-500/50"
        />
        <Button variant="outline" onClick={() => setLines([])}>
          <Eraser size={14} />
          清屏
        </Button>
      </PageHeader>

      <div
        ref={boxRef}
        onScroll={() => {
          const el = boxRef.current;
          if (el) {
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }
        }}
        className="flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-5"
      >
        {shown.length === 0 ? (
          <div className="pt-8 text-center text-zinc-600">
            {lines.length === 0 ? "暂无日志输出" : "没有匹配过滤条件的行"}
          </div>
        ) : (
          shown.map((l, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-all",
                l.stream === "err" ? "text-rose-400" : "text-zinc-300",
              )}
            >
              {l.text || " "}
            </div>
          ))
        )}
      </div>
    </>
  );
}
