import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Image as ImageIcon, RefreshCw, Search, Trash2 } from "lucide-react";
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

export function Images() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ImageDto | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);

  const query = useQuery({
    queryKey: ["images"],
    queryFn: api.listImages,
    refetchInterval: 20000,
  });

  const remove = useMutation({
    mutationFn: (img: ImageDto) => api.removeImage(img.id, forceDelete),
    onSuccess: () => {
      toast.success("镜像已删除");
      setPendingDelete(null);
      setForceDelete(false);
      void qc.invalidateQueries({ queryKey: ["images"] });
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
      <PageHeader title="镜像" desc="本地镜像与拉取">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索标签 / ID"
            className="w-56 pl-8"
          />
        </div>
        <Button variant="primary" onClick={() => setPullOpen(true)}>
          <Download size={15} />
          拉取镜像
        </Button>
        <IconButton
          title="刷新"
          onClick={() => void query.refetch()}
          className="h-9 w-9 border border-edge"
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
          icon={<ImageIcon size={40} />}
          title={keyword ? "没有匹配的镜像" : "本地没有镜像"}
          desc={keyword ? "换个关键字试试" : "点击右上角「拉取镜像」获取一个镜像"}
        />
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-panel text-left text-xs text-zinc-500">
              <tr className="border-b border-edge">
                <th className="px-6 py-2.5 font-medium">标签</th>
                <th className="py-2.5 font-medium">镜像 ID</th>
                <th className="py-2.5 font-medium">大小</th>
                <th className="py-2.5 font-medium">创建时间</th>
                <th className="py-2.5 pr-6 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((img) => {
                const [main = "", ...rest] = img.tags;
                return (
                  <tr
                    key={img.id}
                    className="border-b border-edge/60 transition-colors last:border-0 hover:bg-panel2/50"
                  >
                    <td className="px-6 py-2.5 pr-4">
                      <div
                        className="max-w-72 truncate font-mono text-xs text-zinc-200"
                        title={main || "<none>:<none>"}
                      >
                        {main || "<none>:<none>"}
                      </div>
                      {rest.length > 0 && (
                        <div className="text-[10px] text-zinc-500" title={rest.join(", ")}>
                          还有 {rest.length} 个标签
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-zinc-400">
                      {shortId(img.id)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-zinc-400">
                      {formatBytes(img.size)}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-zinc-500">
                      {timeAgo(img.created)}
                    </td>
                    <td className="py-2.5 pr-6 text-right">
                      <IconButton
                        title="删除"
                        disabled={remove.isPending}
                        className="ml-auto hover:bg-rose-500/10 hover:text-rose-400"
                        onClick={() => {
                          setForceDelete(false);
                          setPendingDelete(img);
                        }}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
              onClick={() => pendingDelete && remove.mutate(pendingDelete)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p>
          确定删除镜像{" "}
          <span className="font-mono text-zinc-100">
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
          <Button
            variant="primary"
            disabled={running || !image.trim()}
            onClick={start}
          >
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
          className="mt-3 h-44 overflow-auto rounded-lg border border-edge bg-app p-2.5 font-mono text-[11px] leading-4 text-zinc-400"
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
