import { useQueryClient } from "@tanstack/react-query";
import { Braces, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "../../lib/i18n";
import { api } from "../../lib/api";
import { formatBytes, shortId } from "../../lib/format";
import type { ImageDto } from "../../types/docker";
import { InspectView } from "../../components/detail/InspectView";
import { Button, IconButton, Modal, Spinner } from "../../components/ui";

/** 标签管理弹窗：列出镜像全部标签，可逐个移除；最后一个标签移除即删除整个镜像 */
export function TagsModal({ img, onClose }: { img: ImageDto; onClose: () => void }) {
  const t = useT();
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
        toast.success(t("img.tagDeletedImage", { ref: reference }));
        onClose();
        return;
      }
      toast.success(t("img.tagRemoved", { ref: reference }));
      const rest = tags.filter((t) => t !== reference);
      setTags(rest);
      if (rest.length === 0) onClose();
    } catch (e) {
      toast.error(t("img.tagRemoveFailed", { err: String(e) }));
    } finally {
      setPendingTag(null);
      setConfirmLast(false);
    }
  };

  return (
    <Modal open title={t("img.tagsTitle")} onClose={onClose}>
      <p className="mb-3">
        {t("img.tagsSummaryBefore")}{" "}
        <span className="font-mono text-fg">{shortId(img.id)}</span>{" "}
        {t("img.tagsSummaryAfter", { n: tags.length, size: formatBytes(img.size) })}
      </p>
      <div className="space-y-1.5">
        {tags.map((tag) => (
          <div
            key={tag}
            className="flex items-center gap-2 rounded-ctl border border-edge bg-panel2/40 px-2.5 py-2"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg2" title={tag}>
              {tag}
            </span>
            <IconButton
              title={
                tags.length === 1
                  ? t("img.removeLastWarn")
                  : t("img.removeTagTitle", { ref: tag })
              }
              disabled={pendingTag !== null}
              className="hover:bg-err/10 hover:text-err"
              onClick={() => (tags.length === 1 ? setConfirmLast(true) : void remove(tag))}
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
            {t("img.lastTagWarn")}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmLast(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={pendingTag !== null}
              onClick={() => void remove(tags[0])}
            >
              {pendingTag !== null ? <Spinner className="h-3.5 w-3.5" /> : null}
              {t("img.confirmDeleteImage")}
            </Button>
          </div>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button variant="outline" onClick={() => setShowJson(true)}>
          <Braces size={13} />
          {t("img.viewJson")}
        </Button>
      </div>
      {showJson && (
        <Modal
          open
          title={t("img.jsonTitle", { ref: img.tags[0] || shortId(img.id) })}
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
