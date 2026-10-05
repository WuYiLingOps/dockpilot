import { useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useRegistries } from "../../lib/registries";
import { shortId } from "../../lib/format";
import type { ImageDto } from "../../types/docker";
import { Button, Modal, Select, Spinner } from "../ui";

/** 单个镜像的推送目标与运行状态 */
type PushRow = {
  source: string;
  repository: string;
  tag: string;
  /** pending | running | done | error | cancelled */
  status: "pending" | "running" | "done" | "error" | "cancelled";
  /** 最近一条进度文本 */
  note: string;
};

/** 从本地镜像引用推导推送目标建议：去掉与已知仓库一致的 host 前缀，拆出 tag（与 Images.tsx 同款） */
function suggestPushTarget(reference: string): { repository: string; tag: string } {
  const colon = reference.lastIndexOf(":");
  const hasTag = colon > reference.lastIndexOf("/") && colon >= 0;
  const repo = hasTag ? reference.slice(0, colon) : reference;
  const t = hasTag ? reference.slice(colon + 1) : "latest";
  const segments = repo.split("/");
  const first = segments[0] ?? "";
  const hostLike =
    segments.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  const repository = hostLike ? segments.slice(1).join("/") : repo;
  return { repository: repository || repo, tag: t || "latest" };
}

/**
 * 批量推送：统一选凭据，逐行自动推导目标引用（仓库名可改），
 * 按顺序逐个推送；单镜像失败不阻塞后续，可随时取消。
 */
export function BatchPushModal({
  imgs,
  onClose,
}: {
  imgs: ImageDto[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: registries } = useRegistries();
  const [registryId, setRegistryId] = useState("");
  const [rows, setRows] = useState<PushRow[]>([]);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  const list = registries ?? [];

  // 打开时按当前镜像集初始化目标行（source 取首个标签）
  useEffect(() => {
    setRows(
      imgs.map((img) => {
        const source = img.tags[0] || shortId(img.id);
        const suggest = suggestPushTarget(source);
        return { source, repository: suggest.repository, tag: suggest.tag, status: "pending" as const, note: "" };
      }),
    );
  }, [imgs]);

  // 凭据就绪后默认选中第一个
  useEffect(() => {
    if (!registries) return;
    setRegistryId((prev) =>
      prev && registries.some((r) => r.id === prev) ? prev : registries[0].id,
    );
  }, [registries]);

  const patchRow = (i: number, part: Partial<PushRow>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...part } : r)));

  const doneCount = rows.filter((r) => r.status === "done").length;
  const failCount = rows.filter((r) => r.status === "error").length;

  const start = async () => {
    if (running || !registryId) return;
    setRunning(true);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.status === "done") continue;
      patchRow(i, { status: "running", note: "准备推送…" });
      // 等当前镜像推送结束；取消时终止整批
      const outcome = await new Promise<"done" | "cancelled">((resolve) => {
        cancelRef.current = api.pushImage(row.source, registryId, row.repository, row.tag, (p) => {
          if (p.status || p.progress) {
            const text = [p.status, p.progress].filter(Boolean).join(" ");
            patchRow(i, { note: text });
          }
          if (p.done) {
            cancelRef.current = null;
            if (p.cancelled) {
              patchRow(i, { status: "cancelled", note: "已取消" });
              resolve("cancelled");
            } else if (p.error) {
              patchRow(i, { status: "error", note: p.error });
              resolve("done");
            } else {
              patchRow(i, { status: "done", note: "推送完成" });
              resolve("done");
            }
          }
        });
      });
      if (outcome === "cancelled") break;
    }
    setRunning(false);
    void qc.invalidateQueries({ queryKey: ["images"] });
  };

  const cancelPush = () => {
    cancelRef.current?.();
    cancelRef.current = null;
    setRunning(false);
  };

  const close = () => {
    if (running) cancelPush();
    onClose();
  };

  const totalBytes = useMemo(() => imgs.reduce((s, i) => s + i.size, 0), [imgs]);

  return (
    <Modal
      open
      title={`批量推送（${imgs.length} 个镜像 · 约 ${Math.round(totalBytes / 1024 / 1024)} MB）`}
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            {running ? "取消推送" : "关闭"}
          </Button>
          <Button
            variant="primary"
            disabled={running || !registryId || rows.length === 0 || list.length === 0}
            onClick={() => void start()}
          >
            {running ? `推送中… ${doneCount}/${rows.length}` : `开始推送（${rows.length}）`}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="shrink-0 text-[12px] text-fg3">仓库凭据</span>
        <Select
          value={registryId}
          onChange={(e) => setRegistryId(e.target.value)}
          className="min-w-0 flex-1"
          disabled={running || list.length === 0}
        >
          {list.length === 0 && <option value="">暂无凭据</option>}
          {list.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}（{r.registry}）
            </option>
          ))}
        </Select>
      </div>

      <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
        {rows.map((r, i) => (
          <div
            key={`${r.source}-${i}`}
            className="rounded-ctl border border-edge bg-panel2/40 px-2.5 py-1.5"
          >
            {/* 首行：源镜像完整引用 + 状态 */}
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg2"
                title={r.source}
              >
                {r.source}
              </span>
              <div className="flex shrink-0 items-center gap-1 text-[11px]">
                {r.status === "pending" && <span className="text-fg3">等待</span>}
                {r.status === "running" && (
                  <>
                    <Spinner className="h-3 w-3" />
                    <span className="text-fg3">推送中</span>
                  </>
                )}
                {r.status === "done" && (
                  <span className="flex items-center gap-0.5 text-ok">
                    <Check size={12} /> 完成
                  </span>
                )}
                {r.status === "error" && (
                  <span className="flex items-center gap-0.5 text-err">
                    <X size={12} /> 失败
                  </span>
                )}
                {r.status === "cancelled" && <span className="text-warn">已取消</span>}
              </div>
            </div>
            {/* 次行：目标仓库名:标签（可编辑） */}
            <div className="mt-1 flex items-center gap-1.5">
              <input
                value={r.repository}
                onChange={(e) => patchRow(i, { repository: e.target.value })}
                disabled={running || r.status !== "pending"}
                spellCheck={false}
                aria-label="目标仓库名"
                data-no-drag
                className="h-7 min-w-0 flex-1 rounded-ctl border border-edge-strong bg-panel px-2 font-mono text-[11.5px] text-fg outline-none focus:border-accent disabled:opacity-60"
              />
              <span className="shrink-0 font-mono text-[12px] text-fg3">:</span>
              <input
                value={r.tag}
                onChange={(e) => patchRow(i, { tag: e.target.value })}
                disabled={running || r.status !== "pending"}
                spellCheck={false}
                aria-label="目标标签"
                data-no-drag
                className="h-7 w-24 shrink-0 rounded-ctl border border-edge-strong bg-panel px-2 font-mono text-[11.5px] text-fg outline-none focus:border-accent disabled:opacity-60"
              />
            </div>
            {/* 进度 / 失败原因（完成后不重复展示） */}
            {r.note && (r.status === "running" || r.status === "error") && (
              <p
                className={`mt-1 truncate text-[11px] leading-4 ${
                  r.status === "error" ? "text-err" : "text-fg3"
                }`}
                title={r.note}
              >
                {r.note}
              </p>
            )}
          </div>
        ))}
      </div>

      {(running || failCount > 0) && (
        <p className="mt-2 text-[11px] leading-4 text-fg3">
          {running
            ? "按顺序逐个推送，失败会跳过并继续下一个；关闭弹窗即取消剩余队列。"
            : `完成 ${doneCount} · 失败 ${failCount}；失败原因见对应行内（悬停源镜像可看完整引用）。`}
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-fg3">
        仓库名可编辑；目标引用与本地不同时后端会自动打标签。共享层不会重复上传。
      </p>
    </Modal>
  );
}
