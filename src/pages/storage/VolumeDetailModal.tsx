import { Trash2 } from "lucide-react";
import { formatBytes } from "../../lib/format";
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
  if (!vol) return null;
  return (
    <Modal
      open
      title="存储卷详情"
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" className="mr-auto" onClick={() => onDelete(vol)}>
            <Trash2 size={14} />
            删除卷
          </Button>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <div className="space-y-1">
        <InfoRow label="名称" value={vol.name} />
        <InfoRow label="驱动" value={vol.driver} />
        <InfoRow label="范围" value={vol.scope || "-"} />
        <InfoRow label="大小" value={formatBytes(vol.size)} />
        <InfoRow label="创建时间" value={formatDateTime(vol.created)} />
        <InfoRow label="挂载点" value={vol.mountpoint || "-"} />
        <InfoRow
          label="标签"
          value={
            vol.labels.length > 0
              ? vol.labels.map((l) => `${l.key}=${l.value}`).join("  ")
              : "-"
          }
        />
      </div>
      <div className="mt-3 border-t border-edge/60 pt-3">
        <div className="mb-1.5 text-[12px] font-medium text-fg2">
          使用该卷的容器（{vol.used_by.length}）
        </div>
        {vol.used_by.length === 0 ? (
          <p className="text-[12px] text-fg3">暂无容器使用该卷</p>
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
