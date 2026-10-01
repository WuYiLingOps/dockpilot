import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CloudUpload,
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
import { api } from "../../lib/api";
import { useSettings } from "../../lib/settings";
import {
  formatBytes,
  imageGroup,
  imageGroupLabel,
  shortId,
  timeAgo,
} from "../../lib/format";
import type { ImageDto } from "../../types/docker";
import { CreateContainerModal } from "../../components/containers/CreateContainerModal";
import { BatchPushModal } from "../../components/images/BatchPushModal";
import {
  Button,
  CheckDot,
  Checkbox,
  EmptyState,
  ErrorNote,
  IconButton,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  Spinner,
} from "../../components/ui";
import { defaultExportName } from "./shared";
import { TagModal } from "./TagModal";
import { PushModal } from "./PushModal";
import { TagsModal } from "./TagsModal";
import { PullModal } from "./PullModal";

const GRID =
  "grid grid-cols-[36px_minmax(200px,1.8fr)_130px_110px_110px_96px] items-center gap-x-3";

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

  // ---- 推送 ----
  const [pushTarget, setPushTarget] = useState<ImageDto | null>(null);
  const [pushList, setPushList] = useState<ImageDto[]>([]);
  const [batchPushOpen, setBatchPushOpen] = useState(false);

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
                  <CheckDot checked={allVisibleSelected} onClick={toggleAll} title="全选" />
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
                    className={`${GRID} group border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 ${
                      selected.has(img.id) ? "bg-accent/5 hover:bg-accent/10" : "hover:bg-hover"
                    }`}
                  >
                    <div>
                      <CheckDot
                        checked={selected.has(img.id)}
                        onClick={() => toggleOne(img.id)}
                        title={`选择 ${main || shortId(img.id)}`}
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
                            ? "该镜像没有标签，无法推送"
                            : `推送 ${main} 到镜像仓库`
                        }
                        disabled={img.tags.length === 0}
                        onClick={() => setPushTarget(img)}
                      >
                        <CloudUpload size={14} />
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
                  variant="outline"
                  disabled={exportState !== null}
                  onClick={() => {
                    const tagged = selectedImages.filter((i) => i.tags.length > 0);
                    const skipped = selectedImages.length - tagged.length;
                    if (tagged.length === 0) {
                      toast.error("所选镜像均无标签，无法推送（可先在标签管理中打标签）");
                      return;
                    }
                    if (skipped > 0) {
                      toast.info(`${skipped} 个无标签镜像已跳过`);
                    }
                    setPushList(tagged);
                    setBatchPushOpen(true);
                  }}
                >
                  <CloudUpload size={14} />
                  推送所选
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
      {pushTarget && (
        <PushModal img={pushTarget} onClose={() => setPushTarget(null)} />
      )}
      {batchPushOpen && (
        <BatchPushModal imgs={pushList} onClose={() => setBatchPushOpen(false)} />
      )}

      <CreateContainerModal
        open={runImage !== null}
        initialImage={runImage ?? ""}
        onClose={() => setRunImage(null)}
      />
    </>
  );
}
