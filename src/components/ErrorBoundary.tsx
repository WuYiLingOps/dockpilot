import { Component, type ReactNode } from "react";
import { AppWindow, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "../lib/clipboard";
import { applog } from "../lib/applog";
import { t, useT } from "../lib/i18n";
import { Button } from "./ui";

interface State {
  error: Error | null;
}

/** 崩溃兜底页（函数组件以使用 useT 随语言切换） */
function ErrorFallback({ error }: { error: Error }) {
  const t = useT();
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-canvas p-8 text-center">
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-panel text-fg3 shadow-[var(--app-shadow)]">
        <AppWindow size={30} strokeWidth={1.5} />
      </div>
      <div className="text-[15px] font-semibold text-fg">{t("errorBoundary.title")}</div>
      <p className="max-w-md break-all text-[12px] text-fg3">{error.message}</p>
      <p className="max-w-md text-[12px] text-fg3">{t("errorBoundary.desc")}</p>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={() => location.reload()}>
          <RefreshCw size={14} />
          {t("errorBoundary.reload")}
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            void copyText(`${error.message}\n${error.stack ?? ""}`).then(() =>
              toast.success(t("errorBoundary.copied")),
            )
          }
        >
          {t("errorBoundary.copyDetails")}
        </Button>
      </div>
    </div>
  );
}

/** 前端渲染崩溃兜底：显示错误页而非白屏，崩溃详情写入应用日志 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const stack = info.componentStack ?? t("log.noComponentStack");
    applog.error(`${t("log.renderCrash", { msg: error.message })}\n${stack}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ErrorFallback error={error} />;
  }
}
