import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  CornerLeftUp,
  File as FileIcon,
  FileDown,
  Folder,
  FolderOpen,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useState, useRef } from "react";
import { open as openFileDialog, save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import type { FileEntry } from "../../types/docker";
import { Button, EmptyState, ErrorNote, IconButton, Spinner } from "../ui";

/** 路径拼接（绝对路径语义）："/var/log" + "app" → "/var/log/app" */
function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** 面包屑分段："/var/log" → [{label:"/",path:"/"},{label:"var",path:"/var"},…] */
function crumbs(path: string): { label: string; path: string }[] {
  const out = [{ label: "/", path: "/" }];
  let acc = "";
  for (const seg of path.split("/").filter(Boolean)) {
    acc += `/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

/**
 * 容器文件浏览器：列表（ls）、上传/下载（archive API）、删除（exec rm）。
 * 目录列表与删除要求容器运行中；上传下载对已停止容器也可用。
 */
export function FileBrowserView({ id, running }: { id: string; running: boolean }) {
  const qc = useQueryClient();
  const [path, setPath] = useState("/");
  const [transfer, setTransfer] = useState<{ label: string; written: number } | null>(null);
  const transferCancelRef = useRef<(() => void) | null>(null);

  const query = useQuery({
    queryKey: ["containerFiles", id, path],
    queryFn: () => api.containerListFiles(id, path),
    enabled: running,
  });

  const remove = useMutation({
    mutationFn: (e: FileEntry) =>
      api.containerDeleteFile(id, joinPath(path, e.name), e.is_dir),
    onSuccess: () => {
      toast.success("已删除");
      void qc.invalidateQueries({ queryKey: ["containerFiles", id, path] });
    },
    onError: (e) => toast.error(`删除失败: ${e}`),
  });

  // 上传：选文件/目录后开始传输
  const upload = async () => {
    let picked: string[] | string | null;
    try {
      picked = (await openFileDialog({
        title: "上传文件",
        multiple: true,
      })) as string[] | string | null;
    } catch {
      return; // 非桌面环境（浏览器 mock）无文件对话框
    }
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    const label =
      paths.length === 1
        ? paths[0].split(/[\\/]/).pop() || paths[0]
        : `${paths.length} 项`;
    setTransfer({ label, written: 0 });
    transferCancelRef.current = api.containerUploadFile(id, path, paths, (p) => {
      setTransfer({ label, written: p.written });
      if (p.done) {
        transferCancelRef.current = null;
        setTransfer(null);
        if (p.cancelled) toast.info("上传已取消");
        else if (p.error) toast.error(`上传失败: ${p.error}`);
        else {
          toast.success("上传完成");
          void qc.invalidateQueries({ queryKey: ["containerFiles", id, path] });
        }
      }
    });
  };

  // 下载：文件选保存路径；目录选目标文件夹（docker cp 语义：其下生成同名子目录）
  const download = async (e: FileEntry) => {
    const src = joinPath(path, e.name);
    try {
      if (e.is_dir) {
        const dir = (await openFileDialog({
          title: `下载目录 ${e.name}（保留原名）`,
          directory: true,
        })) as string | null;
        if (!dir) return;
        startDownload(src, dir, e);
      } else {
        const dest = await save({ title: "下载文件", defaultPath: e.name });
        if (!dest) return;
        startDownload(src, dest, e);
      }
    } catch {
      return; // 非桌面环境（浏览器 mock）无对话框
    }
  };

  const startDownload = (src: string, dest: string, e: FileEntry) => {
    setTransfer({ label: e.name, written: 0 });
    transferCancelRef.current = api.containerDownloadFile(id, src, dest, (p) => {
      setTransfer({ label: e.name, written: p.written });
      if (p.done) {
        transferCancelRef.current = null;
        setTransfer(null);
        if (p.cancelled) toast.info("下载已取消");
        else if (p.error) toast.error(`下载失败: ${p.error}`);
        else toast.success(`已保存到 ${dest}`);
      }
    });
  };

  if (!running) {
    return (
      <EmptyState
        icon={<FolderOpen size={28} />}
        title="容器未运行"
        desc="浏览与删除需要容器内可执行命令（ls/rm），上传下载亦依赖列表定位路径；启动容器后自动可用。"
      />
    );
  }

  const entries = query.data ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏：面包屑 + 操作 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 py-2" data-no-drag>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-[12px]">
          {crumbs(path).map((c, i, arr) => (
            <span key={c.path} className="flex shrink-0 items-center">
              {i > 0 && <ChevronRight size={12} className="mx-0.5 text-fg3" />}
              <button
                type="button"
                onClick={() => setPath(c.path)}
                className={`rounded px-1 py-0.5 font-mono transition-colors hover:bg-hover ${
                  i === arr.length - 1 ? "font-medium text-fg" : "text-fg3 hover:text-fg"
                }`}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
        {path !== "/" && (
          <IconButton
            title="上一级"
            className="h-7 w-7"
            onClick={() => setPath(path.replace(/\/[^/]+$/, "") || "/")}
          >
            <CornerLeftUp size={13} />
          </IconButton>
        )}
        <IconButton
          title="刷新"
          className="h-7 w-7"
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={13} className={query.isFetching ? "animate-spin" : ""} />
        </IconButton>
        <Button variant="outline" className="h-7 px-2 text-[12px]" disabled={transfer !== null} onClick={() => void upload()}>
          <Upload size={13} />
          上传
        </Button>
      </div>

      {/* 传输进度条 */}
      {transfer && (
        <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-accent/5 px-4 py-1.5 text-[11.5px] text-fg2">
          <Spinner className="h-3 w-3" />
          <span className="truncate">
            {transfer.label} · 已传 {formatBytes(transfer.written)}
          </span>
          <button
            type="button"
            data-no-drag
            className="ml-auto shrink-0 text-fg3 underline-offset-2 hover:text-err hover:underline"
            onClick={() => transferCancelRef.current?.()}
          >
            取消
          </button>
        </div>
      )}

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-3">
        {query.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Spinner className="h-5 w-5" />
          </div>
        ) : query.isError ? (
          <ErrorNote message={String(query.error)} onRetry={() => void query.refetch()} />
        ) : entries.length === 0 ? (
          <EmptyState icon={<FolderOpen size={28} />} title="空目录" />
        ) : (
          <div className="overflow-hidden rounded-card border border-edge bg-panel">
            {entries.map((e) => (
              <div
                key={e.name}
                onClick={() => e.is_dir && setPath(joinPath(path, e.name))}
                className={`grid grid-cols-[minmax(160px,2fr)_110px_100px_130px_68px] items-center gap-x-3 border-b border-edge/60 px-3 py-2 text-[12.5px] transition-colors last:border-0 hover:bg-hover ${
                  e.is_dir ? "cursor-pointer" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {e.is_dir ? (
                    <Folder size={14} className="shrink-0 text-accent" />
                  ) : (
                    <FileIcon size={14} className="shrink-0 text-fg3" />
                  )}
                  <span className="truncate font-mono text-fg" title={e.name}>
                    {e.name}
                  </span>
                </div>
                <div className="text-[11.5px] text-fg3">
                  {e.is_dir ? "目录" : formatBytes(e.size)}
                </div>
                <div className="truncate font-mono text-[11px] text-fg3" title={e.mode}>
                  {e.mode}
                </div>
                <div className="truncate text-[11.5px] text-fg3">{e.date}</div>
                <div className="flex items-center justify-end gap-0.5" data-no-drag>
                  <IconButton
                    title={e.is_dir ? "下载目录（保留原名）" : "下载文件"}
                    className="h-7 w-7"
                    onClick={() => void download(e)}
                  >
                    <FileDown size={13} />
                  </IconButton>
                  <IconButton
                    title={e.is_dir ? "删除目录" : "删除文件"}
                    className="h-7 w-7 hover:bg-err/10 hover:text-err"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(e)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="shrink-0 px-4 pb-2 text-[11px] text-fg3">
        目录列表与删除经容器内命令执行（需运行中）；上传/下载等同 docker cp，可能受镜像内工具差异影响。
      </p>
    </div>
  );
}
