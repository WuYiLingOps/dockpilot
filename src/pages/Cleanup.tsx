import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Database, Eraser, HardDrive, Layers, PackageOpen } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import type { MsgKey } from "../lib/i18n/zh";
import type { DiskUsageDto, UsageCategory } from "../types/daemon";
import { Badge, Button, CheckDot, EmptyState, ErrorNote, IconButton, Modal, PageHeader, RefreshIcon, Spinner } from "../components/ui";

interface KindDef {
  key: string;
  labelKey: MsgKey;
  descKey: MsgKey;
  icon: typeof HardDrive;
  danger?: boolean;
  pick: (u: DiskUsageDto) => UsageCategory;
}

/** 清理类别定义；unused_images 是 dangling_images 的超集，选择前者时后者自动跳过 */
const KINDS: KindDef[] = [
  {
    key: "dangling_images",
    labelKey: "cleanup.danglingImages",
    descKey: "cleanup.danglingImagesDesc",
    icon: Layers,
    pick: (u) => u.dangling_images,
  },
  {
    key: "unused_images",
    labelKey: "cleanup.unusedImages",
    descKey: "cleanup.unusedImagesDesc",
    icon: PackageOpen,
    pick: (u) => u.unused_images,
  },
  {
    key: "stopped_containers",
    labelKey: "cleanup.stoppedContainers",
    descKey: "cleanup.stoppedContainersDesc",
    icon: HardDrive,
    pick: (u) => u.stopped_containers,
  },
  {
    key: "unused_volumes",
    labelKey: "cleanup.unusedVolumes",
    descKey: "cleanup.unusedVolumesDesc",
    icon: Database,
    danger: true,
    pick: (u) => u.unused_volumes,
  },
  {
    key: "build_cache",
    labelKey: "cleanup.buildCache",
    descKey: "cleanup.buildCacheDesc",
    icon: Eraser,
    pick: (u) => u.build_cache,
  },
];

export function Cleanup() {
  const qc = useQueryClient();
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const query = useQuery({
    queryKey: ["diskUsage"],
    queryFn: api.diskUsage,
    refetchInterval: 30000,
  });
  const usage = query.data;

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const cleanup = useMutation({
    mutationFn: () => {
      // 未使用镜像的清理已覆盖悬空镜像，避免重复执行
      const kinds = KINDS.map((k) => k.key).filter(
        (k) => selected.has(k) && !(k === "dangling_images" && selected.has("unused_images")),
      );
      return api.cleanup(kinds);
    },
    onSuccess: (res) => {
      setConfirmOpen(false);
      setSelected(new Set());
      if (res.total_reclaimed > 0) {
        toast.success(t("cleanup.doneReclaimed", { size: formatBytes(res.total_reclaimed) }));
      } else {
        toast.success(t("cleanup.done"));
      }
      for (const item of res.items) {
        if (item.error) {
          const kindDef = KINDS.find((k) => k.key === item.kind);
          const label = kindDef ? t(kindDef.labelKey) : item.kind;
          toast.error(t("cleanup.kindFailed", { label, err: item.error }));
        }
      }
      for (const key of ["diskUsage", "containers", "images", "dockerInfo"]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e) => toast.error(t("cleanup.failed", { err: String(e) })),
  });

  const selectedKinds = KINDS.filter((k) => selected.has(k.key));
  const selectedCount = selectedKinds.reduce((acc, k) => acc + (usage ? k.pick(usage).count : 0), 0);

  return (
    <>
      <PageHeader
        title={t("nav.cleanup")}
        desc={
          usage
            ? t("cleanup.pageDesc", { size: formatBytes(usage.total_reclaimable) })
            : t("st.usageLoading")
        }
      >
        <IconButton
          title={t("common.refresh")}
          onClick={() => void query.refetch()}
          className="h-8 w-8"
        >
          <RefreshIcon spinning={query.isFetching} size={15} />
        </IconButton>
      </PageHeader>

      {query.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : query.isError ? (
        <ErrorNote message={String(query.error)} onRetry={() => void query.refetch()} />
      ) : !usage ? null : usage.total_reclaimable === 0 &&
        usage.stopped_containers.count === 0 ? (
        <EmptyState
          icon={<Eraser size={40} strokeWidth={1.5} />}
          title={t("cleanup.allClean")}
          desc={t("cleanup.allCleanDesc")}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-2 overflow-auto p-4 pt-2">
            {KINDS.map((k) => {
              const u = k.pick(usage);
              const disabled = u.count === 0;
              return (
                <div
                  key={k.key}
                  onClick={() => !disabled && toggle(k.key)}
                  className={`flex items-center gap-3 rounded-card border px-4 py-3 transition-colors ${
                    disabled
                      ? "border-edge/60 bg-panel/50 opacity-60"
                      : selected.has(k.key)
                        ? "cursor-pointer border-accent/40 bg-accent/5 shadow-[var(--app-shadow)] hover:bg-accent/10"
                        : "cursor-pointer border-edge bg-panel shadow-[var(--app-shadow)] hover:bg-hover"
                  }`}
                >
                  <k.icon size={17} className="shrink-0 text-fg3" strokeWidth={1.6} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
                      {t(k.labelKey)}
                      {k.danger && <Badge tone="err">{t("cleanup.irreversible")}</Badge>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-fg3">{t(k.descKey)}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-[13px] text-fg2">
                      {t("cleanup.nObjects", { n: u.count })}
                    </div>
                    {u.size > 0 && (
                      <div className="mt-0.5 font-mono text-[11px] text-fg3">
                        {formatBytes(u.size)}
                      </div>
                    )}
                  </div>
                  {/* 多选指示器：空心圆环 → 蓝色实心对勾；点击行为由整行的 onClick 处理 */}
                  <CheckDot checked={selected.has(k.key)} disabled={disabled} />
                </div>
              );
            })}
          </div>

          {/* 底部操作条 */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-edge bg-panel px-4 py-3">
            <span className="text-[12px] text-fg3">
              {t("cleanup.selectedSummary", { kinds: selected.size, objects: selectedCount })}
            </span>
            <Button
              variant="danger"
              disabled={selected.size === 0 || cleanup.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              <Eraser size={14} />
              {t("cleanup.cleanSelected")}
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={confirmOpen}
        title={t("cleanup.confirmTitle")}
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" disabled={cleanup.isPending} onClick={() => cleanup.mutate()}>
              {cleanup.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
              {t("cleanup.confirm")}
            </Button>
          </>
        }
      >
        <p className="flex items-start gap-1.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
          {t("cleanup.confirmWarning")}
        </p>
        <ul className="mt-2 space-y-1">
          {selectedKinds.map((k) => (
            <li key={k.key} className="flex items-center justify-between">
              <span className={k.danger ? "text-err" : ""}>{t(k.labelKey)}</span>
              <span className="font-mono text-[12px] text-fg3">
                {t("cleanup.nObjects", { n: usage ? k.pick(usage).count : 0 })}
                {k.key === "dangling_images" && selected.has("unused_images")
                  ? t("cleanup.includedInUnused")
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
