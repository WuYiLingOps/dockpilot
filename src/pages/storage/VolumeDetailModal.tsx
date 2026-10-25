import { Trash2 } from "lucide-react";
import { formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { VolumeDto } from "../../types/docker";
import { Button, Modal } from "../../components/ui";
import { formatDateTime, InfoRow } from "./shared";

export function VolumeDetailModal({
  vol,
  onClose,
  onDelete,
}: {
  vol: VolumeDto | null;
  onClose: () => void;
  onDelete: (v: VolumeDto) => void;
}) {
  const t = useT();
  if (!vol) return null;
  return (
    <Modal
      open
      title={t("st.volumeDetailTitle")}
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" className="mr-auto" onClick={() => onDelete(vol)}>
            <Trash2 size={14} />
            {t("st.deleteVolume")}
          </Button>
          <Button variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="space-y-1">
        <InfoRow label={t("st.name")} value={vol.name} />
        <InfoRow label={t("st.driver")} value={vol.driver} />
        <InfoRow label={t("st.thScope")} value={vol.scope || "-"} />
        <InfoRow label={t("st.thSize")} value={formatBytes(vol.size)} />
        <InfoRow label={t("st.createdAt")} value={formatDateTime(vol.created)} />
        <InfoRow label={t("st.mountpoint")} value={vol.mountpoint || "-"} />
        <InfoRow
          label={t("st.thLabels")}
          value={
            vol.labels.length > 0
              ? vol.labels.map((l) => `${l.key}=${l.value}`).join("  ")
              : "-"
          }
        />
      </div>
      <div className="mt-3 border-t border-edge/60 pt-3">
        <div className="mb-1.5 text-[12px] font-medium text-fg2">
          {t("st.volumesUsing", { n: vol.used_by.length })}
        </div>
        {vol.used_by.length === 0 ? (
          <p className="text-[12px] text-fg3">{t("st.noContainersUsing")}</p>
        ) : (
          <div className="space-y-1">
            {vol.used_by.map((c) => (
              <div
                key={c}
                className="truncate rounded-btn bg-panel2 px-2.5 py-1.5 font-mono text-[12px] text-fg2"
              >
                {c}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
