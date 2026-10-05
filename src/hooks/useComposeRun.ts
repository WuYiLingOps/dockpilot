import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import type { ComposeOutput } from "../types/compose";

type Unsubscribe = () => void;
type RunResult = { code: number | null; error: string | null };

const MAX_LINES = 3000;

/**
 * 管理一次 compose CLI 子进程输出流：行缓冲 + 运行状态 + 结束回调。
 * start 的入参是「给定 onOutput 回调返回取消函数」的 api 调用（composeAction）。
 * target/action/pendingText 供列表页渲染行内中间态（哪一行、哪个按钮、什么文案）。
 */
export function useComposeRun() {
  const qc = useQueryClient();
  const [lines, setLines] = useState<ComposeOutput[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [action, setAction] = useState("");
  const [pendingText, setPendingText] = useState("");
  const unsubRef = useRef<Unsubscribe | null>(null);
  const doneRef = useRef<((r: RunResult) => void) | null>(null);

  const stop = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    doneRef.current = null;
  }, []);

  /** 清空面板（仅在没有进行中的流时允许） */
  const clear = useCallback(() => {
    if (unsubRef.current) return;
    setLines([]);
    setResult(null);
  }, []);

  const start = useCallback(
    (
      run: (
        onOutput: (o: ComposeOutput) => void,
        onError: (e: string) => void,
      ) => Unsubscribe,
      opts: {
        label: string;
        /** 操作对象（项目名），供列表行匹配出「哪一行在执行」 */
        target?: string;
        /** 本次动作（up/stop/…），供列表行匹配出「哪个按钮在执行」 */
        action?: string;
        /** 行内简短中间态文案（如「停止中…」） */
        pendingText?: string;
        onDone?: (r: RunResult) => void;
      },
    ) => {
      const finish = (r: RunResult) => {
        setRunning(false);
        setResult(r);
        unsubRef.current = null;
        doneRef.current = null;
        if (r.error !== null) {
          toast.error(`${opts.label}失败: ${r.error}`);
        } else if (r.code === 0) {
          toast.success(`${opts.label}完成`);
          // 编排动作会改变容器/镜像状态，完成后统一刷新
          void qc.invalidateQueries({ queryKey: ["composeProjects"] });
          void qc.invalidateQueries({ queryKey: ["containers"] });
          void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
        } else {
          toast.error(`${opts.label}失败（退出码 ${r.code}）`);
        }
        opts.onDone?.(r);
      };

      stop();
      setLines([]);
      setRunning(true);
      setResult(null);
      setLabel(opts.label);
      setTarget(opts.target ?? "");
      setAction(opts.action ?? "");
      setPendingText(opts.pendingText ?? "");
      doneRef.current = opts.onDone ?? null;

      unsubRef.current = run(
        (o) => {
          if (o.code !== null || o.error !== null) {
            finish({ code: o.code, error: o.error });
            return;
          }
          setLines((prev) => {
            const next = [...prev, o];
            return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
          });
        },
        // 起进程前的同步失败（CLI 探测/项目配置反查 Err）走这里，否则 running 永久卡 true
        (e) => finish({ code: null, error: e }),
      );
    },
    [qc, stop],
  );

  // 组件卸载时终止后台子进程，避免无主流
  useEffect(() => () => stop(), [stop]);

  return { lines, running, result, label, target, action, pendingText, start, stop, clear };
}
