import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Database, Eraser, HardDrive, Layers, PackageOpen, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import type { DiskUsageDto, UsageCategory } from "../types/daemon";
import { Badge, Button, EmptyState, ErrorNote, IconButton, Modal, PageHeader, Spinner } from "../components/ui";

interface KindDef {
  key: string;
  label: string;
  desc: string;
  icon: typeof HardDrive;
  danger?: boolean;
  pick: (u: DiskUsageDto) => UsageCategory;
}

/** 清理类别定义；unused_images 是 dangling_images 的超集，选择前者时后者自动跳过 */
const KINDS: KindDef[] = [
  {
    key: "dangling_images",
    label: "悬空镜像",
    desc: "无标签的 <none> 镜像层",
    icon: Layers,
    pick: (u) => u.dangling_images,
  },
  {
    key: "unused_images",
    label: "未使用镜像",
    desc: "未被任何容器引用的镜像（含悬空）",
    icon: PackageOpen,
    pick: (u) => u.unused_images,
  },
  {
    key: "stopped_containers",
    label: "已停止容器",
    desc: "退出/创建/死亡状态的容器记录",
    icon: HardDrive,
    pick: (u) => u.stopped_containers,
  },
  {
    key: "unused_volumes",
    label: "未使用卷",
    desc: "未被容器挂载的数据卷，卷内数据将被删除",
    icon: Database,
    danger: true,
    pick: (u) => u.unused_volumes,
  },
  {
    key: "build_cache",
    label: "构建缓存",
    desc: "docker build 产生的层缓存",
    icon: Eraser,
    pick: (u) => u.build_cache,
  },
];

export function Cleanup() {
  const qc = useQueryClient();
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
        toast.success(`清理完成，回收 ${formatBytes(res.total_reclaimed)}`);
      } else {
        toast.success("清理完成");
      }
      for (const item of res.items) {
        if (item.error) {
          const label = KINDS.find((k) => k.key === item.kind)?.label ?? item.kind;
          toast.error(`${label}清理失败: ${item.error}`);
        }
      }
      for (const key of ["diskUsage", "containers", "images", "dockerInfo"]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e) => toast.error(`清理失败: ${e}`),
  });

  const selectedKinds = KINDS.filter((k) => selected.has(k.key));
  const selectedCount = selectedKinds.reduce((acc, k) => acc + (usage ? k.pick(usage).count : 0), 0);

  return (
    <>
      <PageHeader
        title="空间清理"
        desc={
          usage
            ? `可回收约 ${formatBytes(usage.total_reclaimable)}`
            : "统计 Docker 磁盘占用中"
        }
      >
        <IconButton
          title="刷新"
          onClick={() => void query.refetch()}
          className="h-8 w-8"
        >
          <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""} />
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
          title="一切都很干净"
          desc="没有可回收的空间"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-2 overflow-auto p-4 pt-2">
            {KINDS.map((k) => {
              const u = k.pick(usage);
              const disabled = u.count === 0;
              return (
                <label
                  key={k.key}
                  className={`flex items-center gap-3 rounded-card border px-4 py-3 transition-colors ${
                    disabled
                      ? "border-edge/60 bg-panel/50 opacity-60"
                      : "cursor-pointer border-edge bg-panel shadow-[var(--app-shadow)] hover:bg-hover"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(k.key)}
                    disabled={disabled}
                    onChange={() => toggle(k.key)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  <k.icon size={17} className="shrink-0 text-fg3" strokeWidth={1.6} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
                      {k.label}
                      {k.danger && <Badge tone="err">不可恢复</Badge>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-fg3">{k.desc}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-[13px] text-fg2">{u.count} 项</div>
                    {u.size > 0 && (
                      <div className="mt-0.5 font-mono text-[11px] text-fg3">
                        {formatBytes(u.size)}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>

          {/* 底部操作条 */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-edge bg-panel px-4 py-3">
            <span className="text-[12px] text-fg3">
              已选 {selected.size} 类，约 {selectedCount} 个对象
            </span>
            <Button
              variant="danger"
              disabled={selected.size === 0 || cleanup.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              <Eraser size={14} />
              清理所选
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={confirmOpen}
        title="确认清理"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button variant="danger" disabled={cleanup.isPending} onClick={() => cleanup.mutate()}>
              {cleanup.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
              确认清理
            </Button>
          </>
        }
      >
        <p className="flex items-start gap-1.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
          清理操作不可恢复，将删除以下对象：
        </p>
        <ul className="mt-2 space-y-1">
          {selectedKinds.map((k) => (
            <li key={k.key} className="flex items-center justify-between">
              <span className={k.danger ? "text-err" : ""}>{k.label}</span>
              <span className="font-mono text-[12px] text-fg3">
                {usage ? k.pick(usage).count : "?"} 项
                {k.key === "dangling_images" && selected.has("unused_images")
                  ? "（已含在未使用镜像中）"
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
