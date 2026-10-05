import { ChevronDown, ChevronUp, RotateCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { toast } from "sonner";
import { copyText, readClipboardText } from "../../lib/clipboard";
import { api } from "../../lib/api";
import { applog } from "../../lib/applog";
import { useSettings } from "../../lib/settings";
import { useTheme } from "../../lib/theme";
import { Badge, Button, EmptyState, IconButton, Select } from "../ui";
import type { ExecFrame } from "../../types/docker";

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

/** shell 自动降级链：容器内不存在当前 shell 时依次回退（Alpine 无 bash 等场景），ash 之后止步 */
const SHELL_FALLBACK: Record<string, string> = { bash: "sh", sh: "ash", ash: "" };

/** 容器详情 · 终端 Tab（交互式 shell，主题随应用亮暗切换；默认 shell 来自设置） */
export function TerminalView({ id, running }: { id: string; running: boolean }) {
  const { isDark } = useTheme();
  const { data: settings } = useSettings();
  const [shell, setShell] = useState<string>(() => settings?.terminal_shell ?? "bash");
  const [phase, setPhase] = useState<"connecting" | "connected" | "ended">("connecting");
  const [epoch, setEpoch] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // shell 自动降级时记录旧值，新会话首帧到达后在终端里说明（重建会话会重置终端内容）
  const fallbackRef = useRef("");

  // 字号/滚回变更需重建终端实例，并入下方 effect 依赖
  const fontSize = settings?.terminal_font_size ?? 12.5;
  const scrollback = settings?.terminal_scrollback ?? 1000;

  const closeSearch = () => {
    setSearchOpen(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  /** 粘贴：经 term.paste 走括号粘贴模式转换，多行文本不会被 shell 逐行执行 */
  const pasteFromClipboard = async () => {
    const term = termRef.current;
    if (!term) return;
    const text = await readClipboardText();
    if (text == null) {
      toast.error("读取剪贴板失败");
      return;
    }
    if (text) term.paste(text);
  };

  /** 右键：有选区=复制并清除选区，无选区=粘贴（Windows Terminal 风格） */
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (sel) {
      void copyText(sel);
      term.clearSelection();
      return;
    }
    void pasteFromClipboard();
  };

  useEffect(() => {
    if (!running) return;
    const host = hostRef.current;
    if (!host) return;

    setPhase("connecting");
    const term = new XTerm({
      fontSize,
      fontFamily:
        'ui-monospace, "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
      scrollback,
      cursorBlink: true,
      theme: terminalTheme(isDark),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    term.open(host);
    fit.fit();

    // Ctrl+Shift+C/V 复制粘贴（Ctrl+C 保持 SIGINT 中断语义）；Ctrl+F 打开搜索条
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
        if (ev.key === "C" || ev.key === "c") {
          const sel = term.getSelection();
          if (sel) void copyText(sel);
          return false;
        }
        if (ev.key === "V" || ev.key === "v") {
          void pasteFromClipboard();
          return false;
        }
        return true;
      }
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && ev.key === "f") {
        setSearchOpen(true);
        return false;
      }
      return true;
    });

    // fit 去抖 50ms：拖拽窗口时 ResizeObserver 连续触发，避免每次都同步 PTY 尺寸
    let fitTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        try {
          fit.fit();
        } catch {
          // 容器尺寸为 0 时 fit 会抛错（如切页瞬间），忽略即可
        }
      }, 50);
    });
    observer.observe(host);

    let disposed = false;
    let execId = "";
    let unsubOutput: (() => void) | undefined;
    // 首帧输出到达才算真正连上（exec 已 attach 且在产出）；此前的输入/尺寸先缓存
    let connected = false;
    let endNotified = false;
    let pendingInput = "";
    let pendingResize: { cols: number; rows: number } | null = null;
    let resizeWarned = false;

    const markEnded = (reason: string) => {
      if (endNotified || disposed) return;
      endNotified = true;
      setPhase("ended");
      term.write(`\r\n\x1b[33m── ${reason}，点上方「重连」可重建会话 ──\x1b[0m\r\n`);
    };

    const sendInput = (data: string) => {
      api.execInput(execId, data).catch((e) => {
        applog.warn(`终端输入写入失败（会话可能已关闭）: ${String(e)}`);
        if (connected) markEnded("会话已断开");
        // 会话尚未建立完成（exec 创建/启动中）：继续缓存，首帧到达后补发
        else pendingInput += data;
      });
    };

    const doResize = async (cols: number, rows: number, retriable: boolean) => {
      try {
        await api.execResize(execId, cols, rows);
      } catch (e) {
        // 会话未建立：尺寸留在 pendingResize，首帧到达后补发
        if (!connected) return;
        if (retriable) {
          await new Promise((r) => setTimeout(r, 200));
          if (!disposed) await doResize(cols, rows, false);
          return;
        }
        applog.warn(`终端尺寸调整失败（会话可能已关闭）: ${String(e)}`);
        if (!resizeWarned && !disposed) {
          resizeWarned = true;
          term.write("\x1b[33m（尺寸同步失败，长行显示可能错位，可点「重连」）\x1b[0m\r\n");
        }
      }
    };

    const onFrame = (f: ExecFrame) => {
      if (disposed) return;
      if (f.type === "data") {
        if (!connected) {
          connected = true;
          setPhase("connected");
          const fb = fallbackRef.current;
          if (fb) {
            fallbackRef.current = "";
            term.write(`\x1b[33m（容器内无 ${fb}，已自动改用 ${shell}）\x1b[0m\r\n`);
          }
          if (pendingResize) {
            void doResize(pendingResize.cols, pendingResize.rows, true);
            pendingResize = null;
          }
          if (pendingInput) {
            sendInput(pendingInput);
            pendingInput = "";
          }
        }
        term.write(f.text);
        return;
      }
      // exec 启动报 shell 不存在：沿降级链自动重建会话
      const next = SHELL_FALLBACK[shell];
      if (next && /executable file not found|no such file/i.test(f.reason)) {
        fallbackRef.current = shell;
        setShell(next);
        return;
      }
      markEnded(f.reason);
    };

    term.onData((data) => {
      if (connected) sendInput(data);
      else pendingInput += data;
    });
    term.onResize(({ cols, rows }) => {
      if (!connected) {
        pendingResize = { cols, rows };
        return;
      }
      void doResize(cols, rows, true);
    });

    void (async () => {
      try {
        const created = await api.execCreate(id, shell);
        if (disposed) return;
        execId = created;
        unsubOutput = api.execAttach(execId, onFrame);
      } catch (e) {
        markEnded(`连接失败: ${String(e)}`);
      }
    })();

    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      unsubOutput?.();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
    // 主题切换不重建终端，由下方 effect 单独热更新配色
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, shell, epoch, running, fontSize, scrollback]);

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
        <Button
          variant={phase === "ended" ? "tinted" : "ghost"}
          className="h-7"
          onClick={() => setEpoch((n) => n + 1)}
        >
          <RotateCw size={14} />
          重连
        </Button>
        {phase === "connecting" && <Badge tone="warn">连接中</Badge>}
        {phase === "ended" && <Badge tone="err">已断开</Badge>}
      </div>
      <div className="min-h-0 flex-1 p-4">
        <div
          ref={hostRef}
          onContextMenu={handleContextMenu}
          className="relative h-full w-full overflow-hidden rounded-card border border-edge bg-panel p-2 shadow-[var(--app-shadow)] dark:bg-[#161618]"
        >
          {searchOpen && (
            <div
              className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-edge bg-panel px-1.5 py-1 shadow-[var(--app-shadow)]"
              data-no-drag
            >
              <Search size={13} className="ml-1 shrink-0 text-fg3" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (!query) return;
                    if (e.shiftKey) searchRef.current?.findPrevious(query);
                    else searchRef.current?.findNext(query);
                  } else if (e.key === "Escape") {
                    closeSearch();
                  }
                }}
                placeholder="搜索终端内容"
                className="w-44 bg-transparent px-1.5 text-[12.5px] text-fg outline-none placeholder:text-fg3"
              />
              <IconButton
                title="上一个（Shift+Enter）"
                className="h-6 w-6"
                onClick={() => query && searchRef.current?.findPrevious(query)}
              >
                <ChevronUp size={13} />
              </IconButton>
              <IconButton
                title="下一个（Enter）"
                className="h-6 w-6"
                onClick={() => query && searchRef.current?.findNext(query)}
              >
                <ChevronDown size={13} />
              </IconButton>
              <IconButton title="关闭（Esc）" className="h-6 w-6" onClick={closeSearch}>
                <X size={13} />
              </IconButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
