import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  FileDown,
  FileUp,
  Image as ImageIcon,
  Play,
  RefreshCw,
  Tag,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import {
  formatBytes,
  imageGroup,
  imageGroupLabel,
  shortId,
  timeAgo,
} from "../lib/format";
import type { ImageDto } from "../types/docker";
import { CreateContainerModal } from "../components/containers/CreateContainerModal";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorNote,
  IconButton,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  Spinner,
} from "../components/ui";

const GRID =
  "grid grid-cols-[36px_minmax(200px,1.8fr)_130px_110px_110px_96px] items-center gap-x-3";

/** 保存对话框默认文件名：单镜像按标签生成（非法字符转 -），批量用日期 */
function defaultExportName(imgs: ImageDto[]): string {
  if (imgs.length === 1) {
    const base = (imgs[0].tags[0] || shortId(imgs[0].id))
      .replace(/^sha256:/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-");
    return `${base}.tar`;
  }
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `docker-images-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.tar`;
}

export function Images({
  search,
  onSearch,
}: {
  search: string;
  onSearch: (v: string) => void;
}) {
  const qc = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<ImageDto | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);
  const [runImage, setRunImage] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState("");
  const { data: settings } = useSettings();

  // ---- 批量选择（按镜像 ID 记忆，随刷新剔除已消失的镜像） ----
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ---- 打标签 / 标签管理 ----
  const [tagTarget, setTagTarget] = useState<ImageDto | null>(null);
  const [tagsView, setTagsView] = useState<ImageDto | null>(null);

  // ---- 导出（save）与导入（load）的运行态 ----
  const [exportState, setExportState] = useState<{
    label: string;
    total: number | null;
    dangling: boolean;
  } | null>(null);
  const [exportWritten, setExportWritten] = useState(0);
  const exportCancelRef = useRef<(() => void) | null>(null);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importLines, setImportLines] = useState<string[]>([]);
  const importCancelRef = useRef<(() => void) | null>(null);
  const importBoxRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: ["images"],
    queryFn: api.listImages,
    refetchInterval: (settings?.images_refresh_secs ?? 20) * 1000,
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

  // 列表刷新后同步勾选状态（镜像被删除/清理后从勾选中剔除）
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(list.map((i) => i.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [list]);

  // 按镜像地址前缀（registry/命名空间）归组，供来源筛选下拉使用
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const img of list) {
      const g = imageGroup(img.tags[0]);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return [...m.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }, [list]);

  const keyword = search.trim().toLowerCase();
  const filtered = list.filter((img) => {
    if (groupFilter && imageGroup(img.tags[0]) !== groupFilter) return false;
    if (!keyword) return true;
    return (
      img.tags.some((t) => t.toLowerCase().includes(keyword)) ||
      img.id.toLowerCase().includes(keyword)
    );
  });

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((i) => selected.has(i.id));
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filtered.forEach((i) => next.delete(i.id));
      else filtered.forEach((i) => next.add(i.id));
      return next;
    });
  };
  const selectedImages = list.filter((i) => selected.has(i.id));

  /** 导出（docker save）：选好保存路径后开始流式传输，进度在弹窗展示 */
  const startExport = async (imgs: ImageDto[]) => {
    if (imgs.length === 0 || exportState) return;
    let path: string | null;
    try {
      path = await save({
        title: "导出镜像",
        defaultPath: defaultExportName(imgs),
        filters: [{ name: "tar 归档", extensions: ["tar"] }],
      });
    } catch {
      return; // 非桌面环境（浏览器 mock）无保存对话框
    }
    if (!path) return;

    const refs = imgs.map((i) => i.tags[0] || i.id);
    setExportWritten(0);
    setExportState({
      label:
        imgs.length === 1
          ? imgs[0].tags[0] || shortId(imgs[0].id)
          : `${imgs.length} 个镜像`,
      // 批量导出因共享层去重，tar 总量小于大小之和，无法预估百分比
      total:
        imgs.length === 1 && imgs[0].tags.length > 0 ? imgs[0].size : null,
      dangling: imgs.some((i) => i.tags.length === 0),
    });
    exportCancelRef.current = api.exportImages(refs, path, (p) => {
      setExportWritten(p.written);
      if (p.done) {
        exportCancelRef.current = null;
        setExportState(null);
        if (p.cancelled) toast.info("导出已取消");
        else if (p.error) toast.error(`导出镜像失败: ${p.error}`);
        else toast.success(`镜像已导出到 ${path}`);
      }
    });
  };

  const cancelExport = () => {
    exportCancelRef.current?.();
    exportCancelRef.current = null;
    setExportState(null);
  };

  /** 导入（docker load）：选 tar 后开始上传，进度流式展示 */
  const startImport = async () => {
    if (importPath) return;
    let file: string | string[] | null;
    try {
      file = await open({
        multiple: false,
        filters: [{ name: "tar 归档", extensions: ["tar"] }],
      });
    } catch {
      return; // 非桌面环境（浏览器 mock）无文件对话框
    }
    if (typeof file !== "string" || !file) return;

    setImportLines([]);
    setImportPath(file);
    importCancelRef.current = api.importImage(file, (p) => {
      if (p.status || p.id || p.progress) {
        const text = [p.id, p.status, p.progress].filter(Boolean).join(" ");
        setImportLines((prev) => {
          const next = [...prev, text];
          return next.length > 300 ? next.slice(next.length - 300) : next;
        });
      }
      if (p.done) {
        importCancelRef.current = null;
        setImportPath(null);
        if (p.error === "已取消") toast.info("导入已取消");
        else if (p.error) toast.error(`导入镜像失败: ${p.error}`);
        else {
          toast.success("镜像导入完成");
          void qc.invalidateQueries({ queryKey: ["images"] });
          void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
        }
      }
    });
  };

  const closeImport = () => {
    importCancelRef.current?.();
    importCancelRef.current = null;
    setImportPath(null);
  };

  // 导入输出区跟随滚动到底部
  useEffect(() => {
    const el = importBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [importLines]);

  return (
    <>
      <PageHeader title="镜像" desc={`${list.length} 个本地镜像`}>
        <SearchInput value={search} onChange={onSearch} className="w-44" />
        <Select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="w-52"
          title="按镜像来源筛选"
        >
          <option value="">全部来源（{list.length}）</option>
          {groups.map(([g, count]) => (
            <option key={g} value={g}>
              {imageGroupLabel(g)}（{count}）
            </option>
          ))}
        </Select>
        <Button variant="outline" onClick={() => void startImport()}>
          <FileUp size={15} />
          导入镜像
        </Button>
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
          title={keyword || groupFilter ? "没有匹配的镜像" : "本地没有镜像"}
          desc={
            keyword || groupFilter
              ? "换个关键字或切换来源筛选试试"
              : "点击右上角「拉取镜像」获取一个镜像"
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-auto p-4 pt-2">
            <div className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
              <div
                className={`${GRID} h-8 border-b border-edge bg-panel2/60 px-4 text-[11px] font-medium text-fg3`}
              >
                <div>
                  <input
                    type="checkbox"
                    aria-label="全选"
                    title="全选"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                </div>
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
                    <div>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${main || shortId(img.id)}`}
                        checked={selected.has(img.id)}
                        onChange={() => toggleOne(img.id)}
                        className="h-3.5 w-3.5 accent-accent"
                      />
                    </div>
                    <div className="min-w-0">
                      <div
                        className="truncate font-mono text-[12px] text-fg"
                        title={main || "<none>:<none>"}
                      >
                        {main || "<none>:<none>"}
                      </div>
                      {rest.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setTagsView(img)}
                          title="查看并管理该镜像的全部标签"
                          className="text-left text-[11px] text-fg3 underline decoration-dotted underline-offset-2 transition-colors hover:text-fg2"
                        >
                          还有 {rest.length} 个标签
                        </button>
                      )}
                    </div>
                    <div className="font-mono text-[12px] text-fg3">{shortId(img.id)}</div>
                    <div className="font-mono text-[12px] text-fg2">
                      {formatBytes(img.size)}
                    </div>
                    <div className="text-[12px] text-fg3">{timeAgo(img.created)}</div>
                    <div className="flex items-center justify-end opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                      <IconButton
                        title={
                          img.tags.length === 0
                            ? "该镜像没有标签，无法按名运行"
                            : `用 ${main} 创建并运行容器`
                        }
                        disabled={img.tags.length === 0}
                        onClick={() => setRunImage(main)}
                      >
                        <Play size={14} />
                      </IconButton>
                      <IconButton
                        title={`为 ${main || shortId(img.id)} 添加标签`}
                        onClick={() => setTagTarget(img)}
                      >
                        <Tag size={14} />
                      </IconButton>
                      <IconButton
                        title={
                          img.tags.length === 0
                            ? "导出为无标签镜像归档"
                            : `导出 ${main} 为 tar 归档`
                        }
                        onClick={() => void startExport([img])}
                      >
                        <FileDown size={14} />
                      </IconButton>
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

          {selected.size > 0 && (
            <div
              className="flex shrink-0 items-center justify-between gap-3 border-t border-edge bg-panel px-4 py-2.5"
              data-no-drag
            >
              <span className="text-[12px] text-fg3">
                已选 {selected.size} 个镜像
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setSelected(new Set())}>
                  取消选择
                </Button>
                <Button
                  variant="primary"
                  disabled={exportState !== null}
                  onClick={() => void startExport(selectedImages)}
                >
                  <FileDown size={14} />
                  导出所选
                </Button>
              </div>
            </div>
          )}
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

      <Modal
        open={exportState !== null}
        title="导出镜像"
        onClose={cancelExport}
        footer={
          <Button variant="outline" onClick={cancelExport}>
            取消导出
          </Button>
        }
      >
        {exportState && (
          <div className="space-y-3">
            <div
              className="truncate font-mono text-[12px] text-fg"
              title={exportState.label}
            >
              {exportState.label}
            </div>
            {exportState.total != null && exportState.total > 0 ? (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-panel2">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-200"
                    style={{
                      width: `${Math.min(
                        100,
                        (exportWritten / exportState.total) * 100,
                      ).toFixed(1)}%`,
                    }}
                  />
                </div>
                <div className="text-[11px] tabular-nums text-fg3">
                  已写入 {formatBytes(exportWritten)} / {formatBytes(exportState.total)}
                </div>
              </>
            ) : (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-panel2">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
                </div>
                <div className="text-[11px] tabular-nums text-fg3">
                  已写入 {formatBytes(exportWritten)}
                </div>
              </>
            )}
            {exportState.dangling && (
              <div className="text-[11px] leading-4 text-warn">
                所选镜像中包含无标签镜像，导入后将显示为无标签（&lt;none&gt;）镜像
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={importPath !== null}
        title="导入镜像"
        onClose={closeImport}
        footer={
          <Button variant="outline" onClick={closeImport}>
            取消导入
          </Button>
        }
      >
        <div className="break-all font-mono text-[12px] text-fg2">{importPath}</div>
        <div
          ref={importBoxRef}
          className="mt-3 h-44 overflow-auto rounded-ctl border border-edge bg-panel2 p-2.5 font-mono text-[11px] leading-4 text-fg2"
        >
          {importLines.length === 0 ? (
            <div className="text-fg3">正在上传镜像归档…</div>
          ) : (
            importLines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {l}
              </div>
            ))
          )}
        </div>
      </Modal>

      {tagTarget && (
        <TagModal img={tagTarget} onClose={() => setTagTarget(null)} />
      )}
      {tagsView && <TagsModal img={tagsView} onClose={() => setTagsView(null)} />}

      <CreateContainerModal
        open={runImage !== null}
        initialImage={runImage ?? ""}
        onClose={() => setRunImage(null)}
      />
    </>
  );
}

/** 行内「打标签」弹窗：为镜像添加一个新引用，新旧标签指向同一镜像（docker tag） */
function TagModal({ img, onClose }: { img: ImageDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [reference, setReference] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const r = reference.trim();
    if (!r || pending) return;
    setPending(true);
    try {
      await api.tagImage(img.id, r);
      toast.success(`已添加标签 ${r}`);
      void qc.invalidateQueries({ queryKey: ["images"] });
      onClose();
    } catch (e) {
      toast.error(`打标签失败: ${e}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open
      title="添加标签"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={pending || !reference.trim()}
            onClick={() => void submit()}
          >
            {pending ? <Spinner className="h-3.5 w-3.5" /> : null}
            添加
          </Button>
        </>
      }
    >
      <p className="mb-3">
        为镜像{" "}
        <span className="font-mono text-fg">
          {img.tags[0] || shortId(img.id)}
        </span>{" "}
        添加一个新标签。
      </p>
      <Input
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="myrepo/myimage:v1（缺省 tag 为 latest）"
        className="w-full font-mono"
        spellCheck={false}
        autoFocus
      />
    </Modal>
  );
}

/** 标签管理弹窗：列出镜像全部标签，可逐个移除；最后一个标签移除即删除整个镜像 */
function TagsModal({ img, onClose }: { img: ImageDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [tags, setTags] = useState<string[]>(img.tags);
  const [pendingTag, setPendingTag] = useState<string | null>(null);
  const [confirmLast, setConfirmLast] = useState(false);

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
    </Modal>
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
