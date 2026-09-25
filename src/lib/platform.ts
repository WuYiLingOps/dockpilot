import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** 后端运行平台（std::env::consts::OS："linux" / "windows" / "macos"），进程内只取一次 */
const platformPromise: Promise<string> = invoke<string>("platform").catch(() => "linux");

export function platform(): Promise<string> {
  return platformPromise;
}

/** 是否 Windows 构建：依赖本机 Docker 的功能（本地连接/镜像加速/编排）在 Windows 不可用 */
export function useIsWindows(): boolean {
  const [win, setWin] = useState(false);
  useEffect(() => {
    let mounted = true;
    void platform().then((p) => {
      if (mounted) setWin(p === "windows");
    });
    return () => {
      mounted = false;
    };
  }, []);
  return win;
}
