import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { CloseAction } from "../types/settings";
import { Button, CheckDot, Modal } from "./ui";

/**
 * 关闭窗口询问弹窗：close_action 为 "ask" 时，Rust 拦截关闭并发出
 * close-requested 事件，本组件监听后弹出，由 apply_close_action 回传决定；
 * 勾选「记住我的选择」后写入设置，之后同类关闭不再询问。
 * Esc / 点遮罩 / 关闭按钮 = 取消本次关闭，窗口保持原状。
 */
export function ClosePromptDialog() {
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("close-requested", () => {
      setOpen(true);
      setBusy(false);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  /** exit 时进程直接退出，promise 不会有响应；失败时复位 busy 可重试 */
  const decide = (action: CloseAction) => {
    setBusy(true);
    void api
      .applyCloseAction(action, remember)
      .catch(() => setBusy(false))
      .finally(() => setOpen(false));
  };

  return (
    <Modal
      open={open}
      title="关闭 DockPilot"
      onClose={() => setOpen(false)}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={() => decide("exit")}>
            退出应用
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => decide("minimize")}>
            最小化到托盘
          </Button>
        </>
      }
    >
      <p>最小化到托盘后应用在后台运行，容器异常桌面通知不受影响，可随时从托盘恢复窗口或退出。</p>
      <button
        type="button"
        onClick={() => setRemember(!remember)}
        className="mt-4 flex items-center gap-2 text-left text-[12px] text-fg2 transition-colors hover:text-fg"
      >
        <CheckDot checked={remember} />
        记住我的选择（可随时在「设置 → 后台与关闭」中修改）
      </button>
    </Modal>
  );
}
