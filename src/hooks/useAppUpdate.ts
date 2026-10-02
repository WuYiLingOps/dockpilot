/**
 * 启动自动检查更新：App.tsx 挂载一次。
 * 受设置 auto_check_updates 开关控制（手动「检查更新」不受限）；
 * 浏览器预览（版本回退 "0.0.0"）跳过；8s 延迟避开启动高峰，24h 节流。
 * 检查完全静默（结果只进 store，由设置「关于 → 软件更新」展示），失败仅记日志。
 */
import { useEffect, useRef } from "react";
import {
  checkNow,
  getState,
  shouldRunStartupCheck,
} from "../lib/appUpdate";
import { getAppVersion } from "../lib/platform";
import { useSettings } from "../lib/settings";

/** 启动检查延迟：避开启动高峰（容器/镜像轮询、云同步远端检查） */
const STARTUP_CHECK_DELAY_MS = 8000;

export function useAppUpdate() {
  const { data: settings } = useSettings();
  // 定时器回调里读最新设置（useCloudSync 的 settingsRef 模式）
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      if (settingsRef.current && !settingsRef.current.auto_check_updates) return;
      void (async () => {
        // 浏览器预览（无 Tauri 桥）版本回退 "0.0.0"，跳过
        if (cancelled || (await getAppVersion()) === "0.0.0") return;
        if (!shouldRunStartupCheck(getState().lastCheckAt, Date.now())) return;
        await checkNow(false);
      })();
    }, STARTUP_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // 仅挂载时布置一次；设置经 ref 读取最新值
  }, []);
}
