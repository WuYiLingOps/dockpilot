import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../lib/api";
import { useTheme } from "../../lib/theme";
import { Button, EmptyState, Select } from "../ui";

function terminalTheme(dark: boolean) {
  return dark
    ? {
        background: "#161618",
        foreground: "#f5f5f7",
        cursor: "#0a84ff",
        selectionBackground: "rgba(10, 132, 255, 0.35)",
        black: "#4b4b50",
        red: "#ff453a",
        green: "#30d158",
        yellow: "#ff9f0a",
        blue: "#0a84ff",
        magenta: "#bf5af2",
        cyan: "#5ac8f5",
        white: "#d1d1d6",
        brightBlack: "#74747a",
        brightRed: "#ff6961",
        brightGreen: "#5ee38b",
        brightYellow: "#ffb340",
        brightBlue: "#409cff",
        brightMagenta: "#d378f6",
        brightCyan: "#8ad8ff",
        brightWhite: "#f5f5f7",
      }
    : {
        background: "#ffffff",
        foreground: "#1d1d1f",
        cursor: "#007aff",
        selectionBackground: "rgba(0, 122, 255, 0.22)",
        black: "#1d1d1f",
        red: "#d70015",
        green: "#1e9e4b",
        yellow: "#b25b00",
        blue: "#007aff",
        magenta: "#ad3da4",
        cyan: "#05979b",
        white: "#8e8e93",
        brightBlack: "#85858b",
        brightRed: "#ff453a",
        brightGreen: "#30d158",
        brightYellow: "#ff9f0a",
        brightBlue: "#0a84ff",
        brightMagenta: "#bf5af2",
        brightCyan: "#5ac8f5",
        brightWhite: "#1d1d1f",
      };
}

/** 容器详情 · 终端 Tab（交互式 shell，主题随应用亮暗切换） */
export function TerminalView({ id, running }: { id: string; running: boolean }) {
  const { isDark } = useTheme();
  const [shell, setShell] = useState("bash");
  const [epoch, setEpoch] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!running) return;
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontSize: 12.5,
      fontFamily:
        'ui-monospace, "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
      cursorBlink: true,
      theme: terminalTheme(isDark),
    });
    termRef.current = term;
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
      termRef.current = null;
    };
    // 主题切换不重建终端，由下方 effect 单独热更新配色
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, shell, epoch, running]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(isDark);
  }, [isDark]);

  if (!running) {
    return (
      <EmptyState
        icon={<span className="font-mono text-2xl text-fg3">$_</span>}
        title="容器未运行"
        desc="终端只能连接运行中的容器"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex h-10 shrink-0 items-center gap-3 border-b border-edge bg-panel px-4"
        data-no-drag
      >
        <Select
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          className="w-28"
        >
          <option value="bash">bash</option>
          <option value="sh">sh</option>
          <option value="ash">ash</option>
        </Select>
        <Button variant="ghost" className="h-7" onClick={() => setEpoch((n) => n + 1)}>
          <RotateCw size={14} />
          重连
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-4">
        <div
          ref={hostRef}
          className="h-full w-full overflow-hidden rounded-card border border-edge bg-panel p-2 shadow-[var(--app-shadow)] dark:bg-[#161618]"
        />
      </div>
    </div>
  );
}
