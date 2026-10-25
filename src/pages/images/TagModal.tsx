import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "../../lib/i18n";
import { api } from "../../lib/api";
import { shortId } from "../../lib/format";
import type { ImageDto } from "../../types/docker";
import { Button, Input, Modal, Spinner } from "../../components/ui";

/** 行内「打标签」弹窗：为镜像添加一个新引用，新旧标签指向同一镜像（docker tag） */
export function TagModal({ img, onClose }: { img: ImageDto; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [reference, setReference] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const r = reference.trim();
    if (!r || pending) return;
    setPending(true);
    try {
      await api.tagImage(img.id, r);
      toast.success(t("img.tagAdded", { ref: r }));
      void qc.invalidateQueries({ queryKey: ["images"] });
      onClose();
    } catch (e) {
      toast.error(t("img.tagFailed", { err: String(e) }));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open
      title={t("img.tagTitle")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={pending || !reference.trim()}
            onClick={() => void submit()}
          >
            {pending ? <Spinner className="h-3.5 w-3.5" /> : null}
            {t("img.add")}
          </Button>
        </>
      }
    >
      <p className="mb-3">
        {t("img.tagDescBefore")}{" "}
        <span className="font-mono text-fg">
          {img.tags[0] || shortId(img.id)}
        </span>{" "}
        {t("img.tagDescAfter")}
      </p>
      <Input
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder={t("img.tagPlaceholder")}
        className="w-full font-mono"
        spellCheck={false}
        autoFocus
      />
    </Modal>
  );
}
