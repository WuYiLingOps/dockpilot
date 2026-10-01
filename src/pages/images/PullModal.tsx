import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { Button, Input, Modal } from "../../components/ui";

export function PullModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [image, setImage] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const start = () => {
    const name = image.trim();
    if (!name || running) return;
    setRunning(true);
    setLines([`开始拉取 ${name} …`]);
    cancelRef.current = api.pullImage(name, (p) => {
      setLines((prev) => {
        const text = p.error
          ? `✗ ${p.error}`
          : [p.id, p.status, p.progress].filter(Boolean).join(" ");
        if (!text) return prev;
        const next = [...prev, text];
        return next.length > 300 ? next.slice(next.length - 300) : next;
      });
      if (p.done) {
        setRunning(false);
        if (p.error) {
          toast.error(`拉取失败: ${p.error}`);
        } else {
          toast.success("镜像拉取完成");
          void qc.invalidateQueries({ queryKey: ["images"] });
          void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
        }
      }
    });
  };

  const close = () => {
    if (running) cancelRef.current?.();
    cancelRef.current = null;
    setRunning(false);
    setLines([]);
    setImage("");
    onClose();
  };

  const onScroll = () => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <Modal
      open={open}
      title="拉取镜像"
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            关闭
          </Button>
          <Button variant="primary" disabled={running || !image.trim()} onClick={start}>
            {running ? "拉取中…" : "开始拉取"}
          </Button>
        </>
      }
    >
      <Input
        value={image}
        onChange={(e) => setImage(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && start()}
        placeholder="例如 nginx:latest 或 redis:7-alpine"
        disabled={running}
        className="w-full font-mono"
        autoFocus
      />
      {lines.length > 0 && (
        <div
          ref={boxRef}
          onScroll={onScroll}
          className="mt-3 h-44 overflow-auto rounded-ctl border border-edge bg-panel2 p-2.5 font-mono text-[11px] leading-4 text-fg2"
        >
          {lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {l}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
