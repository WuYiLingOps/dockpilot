import { Component, type ReactNode } from "react";
import { AppWindow, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "../lib/clipboard";
import { applog } from "../lib/applog";
import { Button } from "./ui";

interface State {
  error: Error | null;
}

/** 前端渲染崩溃兜底：显示错误页而非白屏，崩溃详情写入应用日志 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const stack = info.componentStack ?? "(无组件栈)";
    applog.error(`前端渲染崩溃: ${error.message}\n${stack}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-canvas p-8 text-center">
        <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-panel text-fg3 shadow-[var(--app-shadow)]">
          <AppWindow size={30} strokeWidth={1.5} />
        </div>
        <div className="text-[15px] font-semibold text-fg">界面出现异常</div>
        <p className="max-w-md break-all text-[12px] text-fg3">{error.message}</p>
        <p className="max-w-md text-[12px] text-fg3">
          错误详情已记录到应用日志（设置 → 故障诊断），
          如反复出现请导出诊断包反馈。
        </p>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => location.reload()}>
            <RefreshCw size={14} />
            重新加载
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void copyText(`${error.message}\n${error.stack ?? ""}`).then(() =>
                toast.success("错误详情已复制"),
              )
            }
          >
            复制详情
          </Button>
        </div>
      </div>
    );
  }
}
