import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

// 不使用 StrictMode：日志/终端等流式副作用依赖挂载-卸载生命周期，
// 开发期的双重挂载会造成重复订阅
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <App />
    <Toaster theme="dark" position="top-center" richColors />
  </QueryClientProvider>,
);
