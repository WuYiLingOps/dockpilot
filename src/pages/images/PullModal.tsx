import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "../../lib/i18n";
import { api } from "../../lib/api";
import { useRegistries } from "../../lib/registries";
import { refRegistryDomain, resolvePullCredential } from "./shared";
import { Button, Input, Modal } from "../../components/ui";

export function PullModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [image, setImage] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const { data: registries } = useRegistries();
  const name = image.trim();
  // 凭据提示：按镜像引用的 registry 域名自动匹配（与后端拉取行为一致）
  const credential = registries && name ? resolvePullCredential(name, registries) : null;
  const domain = name ? refRegistryDomain(name) : null;

  const start = () => {
    const name = image.trim();
    if (!name || running) return;
    setRunning(true);
    setLines([t("img.pullingStart", { name })]);
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
        if (p.cancelled) {
          toast.info(t("img.pullCancelled"));
        } else if (p.error) {
          toast.error(t("img.pullFailed", { err: p.error }));
        } else {
          toast.success(t("img.pullDone"));
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
      title={t("img.pullTitle")}
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            {t("common.close")}
          </Button>
          <Button variant="primary" disabled={running || !image.trim()} onClick={start}>
            {running ? t("img.pulling") : t("img.startPull")}
          </Button>
        </>
      }
    >
      <Input
        value={image}
        onChange={(e) => setImage(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && start()}
        placeholder={t("img.pullPlaceholder")}
        disabled={running}
        className="w-full font-mono"
        autoFocus
      />
      {name && (
        <div className="mt-2 text-[11px] leading-4 text-fg3">
          {credential
            ? t("img.usingCredential", { name: credential.name, registry: credential.registry })
            : domain !== "docker.io" &&
              t("img.privateRepoHint", { domain: domain ?? "" })}
        </div>
      )}
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
