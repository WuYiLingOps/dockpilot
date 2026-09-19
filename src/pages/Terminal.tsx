import { useQuery } from "@tanstack/react-query";
import { RotateCw, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api";
import { Button, EmptyState, PageHeader, Select } from "../components/ui";

export function Terminal() {
  const containers = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
  });
  const running = (containers.data ?? []).filter((c) => c.state === "running");

  const [id, setId] = useState("");
  const [shell, setShell] = useState("bash");
  const [epoch, setEpoch] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id && running.length > 0) setId(running[0].id);
    // 容器全部退出时清空选择，避免连到已停止的容器
    if (id && running.length > 0 && !running.some((c) => c.id === id)) {
      setId(running[0].id);
    }
  }, [running, id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !id) return;

    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
      theme: {
        background: "#0a0c10",
        foreground: "#e2e8f0",
        cursor: "#34d399",
        selectionBackground: "#334155",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // 容器尺寸为 0 时 fit 会抛错（如切页瞬间），忽略即可
      }
    });
    observer.observe(host);

    let disposed = false;
    let execId = "";
    let unsubOutput: (() => void) | undefined;

    term.onData((data) => {
      if (execId) void api.execInput(execId, data);
    });
    term.onResize(({ cols, rows }) => {
      if (execId) void api.execResize(execId, cols, rows);
    });

    void (async () => {
      try {
        execId = await api.execCreate(id, shell);
        if (disposed) return;
        unsubOutput = api.execAttach(execId, (s) => term.write(s));
        await api.execResize(execId, term.cols, term.rows);
      } catch (e) {
        term.write(`\r\n\x1b[31m连接失败: ${String(e)}\x1b[0m`);
      }
    })();

    return () => {
      disposed = true;
      unsubOutput?.();
      observer.disconnect();
      term.dispose();
    };
  }, [id, shell, epoch]);

  return (
    <>
      <PageHeader title="终端" desc="进入容器内部执行命令">
        <Select value={id} onChange={(e) => setId(e.target.value)}>
          {running.length === 0 && <option value="">（无运行中的容器）</option>}
          {running.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select value={shell} onChange={(e) => setShell(e.target.value)}>
          <option value="bash">bash</option>
          <option value="sh">sh</option>
          <option value="ash">ash</option>
        </Select>
        <Button variant="outline" disabled={!id} onClick={() => setEpoch((n) => n + 1)}>
          <RotateCw size={14} />
          重连
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 p-4">
        {running.length === 0 ? (
          <div className="h-full rounded-xl border border-edge bg-panel">
            <EmptyState
              icon={<SquareTerminal size={40} />}
              title="没有运行中的容器"
              desc="先在「容器」页启动一个容器，再回来打开终端"
            />
          </div>
        ) : (
          <div
            ref={hostRef}
            className="h-full w-full overflow-hidden rounded-xl border border-edge bg-app p-2"
          />
        )}
      </div>
    </>
  );
}
