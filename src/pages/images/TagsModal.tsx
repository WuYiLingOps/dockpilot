import { useQueryClient } from "@tanstack/react-query";
import { Braces, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { formatBytes, shortId } from "../../lib/format";
import type { ImageDto } from "../../types/docker";
import { InspectView } from "../../components/detail/InspectView";
import { Button, IconButton, Modal, Spinner } from "../../components/ui";

/** 标签管理弹窗：列出镜像全部标签，可逐个移除；最后一个标签移除即删除整个镜像 */
export function TagsModal({ img, onClose }: { img: ImageDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [tags, setTags] = useState<string[]>(img.tags);
  const [pendingTag, setPendingTag] = useState<string | null>(null);
  const [confirmLast, setConfirmLast] = useState(false);
  const [showJson, setShowJson] = useState(false);

  const remove = async (reference: string) => {
    if (pendingTag) return;
    setPendingTag(reference);
    try {
      const deletedImage = await api.untagImage(reference);
      void qc.invalidateQueries({ queryKey: ["images"] });
      void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
      if (deletedImage) {
        toast.success(`镜像 ${reference} 已删除（它是最后一个标签）`);
        onClose();
        return;
      }
      toast.success(`已移除标签 ${reference}`);
      const rest = tags.filter((t) => t !== reference);
      setTags(rest);
      if (rest.length === 0) onClose();
    } catch (e) {
      toast.error(`移除标签失败: ${e}`);
    } finally {
      setPendingTag(null);
      setConfirmLast(false);
    }
  };

  return (
    <Modal open title="标签管理" onClose={onClose}>
      <p className="mb-3">
        镜像{" "}
        <span className="font-mono text-fg">{shortId(img.id)}</span> 共{" "}
        {tags.length} 个标签，均指向同一镜像（{formatBytes(img.size)}）。
      </p>
      <div className="space-y-1.5">
        {tags.map((t) => (
          <div
            key={t}
            className="flex items-center gap-2 rounded-ctl border border-edge bg-panel2/40 px-2.5 py-2"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg2" title={t}>
              {t}
            </span>
            <IconButton
              title={
                tags.length === 1 ? "移除该标签将删除整个镜像" : `移除标签 ${t}`
              }
              disabled={pendingTag !== null}
              className="hover:bg-err/10 hover:text-err"
              onClick={() => (tags.length === 1 ? setConfirmLast(true) : void remove(t))}
            >
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
      </div>
      {confirmLast && (
        <div className="mt-3 rounded-ctl border border-err/20 bg-err/5 p-2.5 text-[12px] leading-4 text-err">
          <p>
            <span className="font-mono">{tags[0]}</span>{" "}
            是该镜像最后一个标签，移除将删除整个镜像（不可恢复）。
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmLast(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={pendingTag !== null}
              onClick={() => void remove(tags[0])}
            >
              {pendingTag !== null ? <Spinner className="h-3.5 w-3.5" /> : null}
              确认删除镜像
            </Button>
          </div>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button variant="outline" onClick={() => setShowJson(true)}>
          <Braces size={13} />
          查看原始 JSON
        </Button>
      </div>
      {showJson && (
        <Modal
          open
          title={`镜像 JSON — ${img.tags[0] || shortId(img.id)}`}
          onClose={() => setShowJson(false)}
          size="lg"
        >
          <div className="h-[60vh] -mx-5 -mb-5">
            <InspectView kind="image" id={img.id} />
          </div>
        </Modal>
      )}
    </Modal>
  );
}
