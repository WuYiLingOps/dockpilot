import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Image as ImageIcon,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { formatBytes, shortId, timeAgo } from "../lib/format";
import type { ImageDto } from "../types/docker";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorNote,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Spinner,
} from "../components/ui";

const GRID =
  "grid grid-cols-[minmax(220px,1.8fr)_130px_110px_110px_96px] items-center gap-x-3";

export function Images({ search }: { search: string }) {
  const qc = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<ImageDto | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);

  const query = useQuery({
    queryKey: ["images"],
    queryFn: api.listImages,
    refetchInterval: 20000,
  });

  const remove = useMutation({
    mutationFn: (v: { img: ImageDto; force: boolean }) =>
      api.removeImage(v.img.id, v.force),
    onSuccess: () => {
      toast.success("镜像已删除");
      setPendingDelete(null);
      void qc.invalidateQueries({ queryKey: ["images"] });
      void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
    },
    onError: (e) => toast.error(`删除镜像失败: ${e}`),
  });

  const list = query.data ?? [];
  const keyword = search.trim().toLowerCase();
  const filtered = keyword
    ? list.filter(
        (img) =>
          img.tags.some((t) => t.toLowerCase().includes(keyword)) ||
          img.id.toLowerCase().includes(keyword),
      )
    : list;

  return (
    <>
      <PageHeader title="镜像" desc={`${list.length} 个本地镜像`}>
        <Button variant="primary" onClick={() => setPullOpen(true)}>
          <Download size={15} />
          拉取镜像
        </Button>
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
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ImageIcon size={40} strokeWidth={1.5} />}
          title={keyword ? "没有匹配的镜像" : "本地没有镜像"}
          desc={keyword ? "换个关键字试试" : "点击右上角「拉取镜像」获取一个镜像"}
        />
      ) : (
        <div className="flex-1 overflow-auto p-4 pt-2">
          <div className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
            <div
              className={`${GRID} h-8 border-b border-edge bg-panel2/60 px-4 text-[11px] font-medium text-fg3`}
            >
              <div>标签</div>
              <div>镜像 ID</div>
              <div>大小</div>
              <div>创建时间</div>
              <div />
            </div>
            {filtered.map((img) => {
              const [main = "", ...rest] = img.tags;
              return (
                <div
                  key={img.id}
                  className={`${GRID} group border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-hover`}
                >
                  <div className="min-w-0">
                    <div
                      className="truncate font-mono text-[12px] text-fg"
                      title={main || "<none>:<none>"}
                    >
                      {main || "<none>:<none>"}
                    </div>
                    {rest.length > 0 && (
                      <div className="text-[11px] text-fg3" title={rest.join(", ")}>
                        还有 {rest.length} 个标签
                      </div>
                    )}
                  </div>
                  <div className="font-mono text-[12px] text-fg3">{shortId(img.id)}</div>
                  <div className="font-mono text-[12px] text-fg2">
                    {formatBytes(img.size)}
                  </div>
                  <div className="text-[12px] text-fg3">{timeAgo(img.created)}</div>
                  <div className="flex items-center justify-end opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    <IconButton
                      title="删除"
                      disabled={remove.isPending}
                      className="hover:bg-err/10 hover:text-err"
                      onClick={() => {
                        setForceDelete(false);
                        setPendingDelete(img);
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Modal
        open={pendingDelete !== null}
        title="删除镜像"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() =>
                pendingDelete && remove.mutate({ img: pendingDelete, force: forceDelete })
              }
            >
              确认删除
            </Button>
          </>
        }
      >
        <p>
          确定删除镜像{" "}
          <span className="font-mono text-fg">
            {pendingDelete?.tags[0] || shortId(pendingDelete?.id ?? "")}
          </span>{" "}
          吗？
        </p>
        <div className="mt-3">
          <Checkbox
            label="强制删除（被容器占用的镜像需要勾选）"
            checked={forceDelete}
            onChange={setForceDelete}
          />
        </div>
      </Modal>

      <PullModal open={pullOpen} onClose={() => setPullOpen(false)} />
    </>
  );
}

function PullModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [image, setImage] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const start = () => {
    const name = image.trim();
    if (!name || running) return;
    setRunning(true);
    setLines([`开始拉取 ${name} …`]);
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
        if (p.error) {
          toast.error(`拉取失败: ${p.error}`);
        } else {
          toast.success("镜像拉取完成");
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
      title="拉取镜像"
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            关闭
          </Button>
          <Button variant="primary" disabled={running || !image.trim()} onClick={start}>
            {running ? "拉取中…" : "开始拉取"}
          </Button>
        </>
      }
    >
      <Input
        value={image}
        onChange={(e) => setImage(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && start()}
        placeholder="例如 nginx:latest 或 redis:7-alpine"
        disabled={running}
        className="w-full font-mono"
        autoFocus
      />
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
