import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Toaster } from "sonner";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applog, installGlobalErrorHandlers } from "./lib/applog";
import { useTheme } from "./lib/theme";
import "./index.css";

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // 查询失败（重试耗尽）统一记录到应用日志；同一键的相同错误只记一次，避免轮询刷屏
    onError: (() => {
      const lastByKey = new Map<string, string>();
      return (error, query) => {
        const key = String(query.queryKey[0] ?? "");
        const msg = String(error);
        if (lastByKey.get(key) === msg) return;
        lastByKey.set(key, msg);
        void applog.warn(`数据查询失败 ${key}: ${msg}`);
      };
    })(),
  }),
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

// 全局兜底：未捕获异常 / Promise 拒绝写入应用日志
installGlobalErrorHandlers();

// 窗口圆角：CSS clip-path 裁剪方案仅用于 Linux；Windows 上 WebView2 透明合成的
// 裁剪边缘会有黑边瑕疵，改用原生 DWM 圆角（见 src-tauri lib.rs），页面恒为直角。
// 最大化/全屏时给 html 加 window-square 恢复直角（规则见 index.css）。
// 浏览器预览（tauri-mock）没有窗口插件命令，isMaximized 失败即保持圆角
function setupWindowCorner() {
  const apply = (square: boolean) =>
    document.documentElement.classList.toggle("window-square", square);
  if (navigator.userAgent.includes("Windows NT")) {
    apply(true);
    return;
  }
  try {
    const win = getCurrentWindow();
    const update = () => {
      void Promise.all([win.isMaximized(), win.isFullscreen()])
        .then(([max, full]) => apply(max || full))
        .catch(() => apply(false));
    };
    void update();
    try {
      void win.listen("tauri://resize", update);
    } catch {
      // mock 环境无事件系统
    }
  } catch {
    // 非 Tauri 环境：保持圆角
  }
}
setupWindowCorner();

// 不使用 StrictMode：日志/终端等流式副作用依赖挂载-卸载生命周期，
// 开发期的双重挂载会造成重复订阅
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <ThemedToaster />
  </QueryClientProvider>,
);

function ThemedToaster() {
  const { isDark } = useTheme();
  return <Toaster theme={isDark ? "dark" : "light"} position="top-center" richColors />;
}
