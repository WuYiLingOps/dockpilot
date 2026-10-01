import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { shortId } from "../../lib/format";
import type { ImageDto } from "../../types/docker";
import { Button, Input, Modal, Spinner } from "../../components/ui";

/** 行内「打标签」弹窗：为镜像添加一个新引用，新旧标签指向同一镜像（docker tag） */
export function TagModal({ img, onClose }: { img: ImageDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [reference, setReference] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const r = reference.trim();
    if (!r || pending) return;
    setPending(true);
    try {
      await api.tagImage(img.id, r);
      toast.success(`已添加标签 ${r}`);
      void qc.invalidateQueries({ queryKey: ["images"] });
      onClose();
    } catch (e) {
      toast.error(`打标签失败: ${e}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open
      title="添加标签"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={pending || !reference.trim()}
            onClick={() => void submit()}
          >
            {pending ? <Spinner className="h-3.5 w-3.5" /> : null}
            添加
          </Button>
        </>
      }
    >
      <p className="mb-3">
        为镜像{" "}
        <span className="font-mono text-fg">
          {img.tags[0] || shortId(img.id)}
        </span>{" "}
        添加一个新标签。
      </p>
      <Input
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="myrepo/myimage:v1（缺省 tag 为 latest）"
        className="w-full font-mono"
        spellCheck={false}
        autoFocus
      />
    </Modal>
  );
}
