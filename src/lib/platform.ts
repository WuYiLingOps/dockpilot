import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** 后端运行平台（std::env::consts::OS："linux" / "windows" / "macos"），进程内只取一次 */
const platformPromise: Promise<string> = invoke<string>("platform").catch(() => "linux");

export function platform(): Promise<string> {
  return platformPromise;
}

/** 应用版本（tauri.conf.json 的 version；mock 环境回退占位值），进程内只取一次 */
const versionPromise: Promise<string> = import("@tauri-apps/api/app")
  .then(({ getVersion }) => getVersion())
  .catch(() => "0.0.0");

export function getAppVersion(): Promise<string> {
  return versionPromise;
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
