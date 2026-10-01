import { Database, Trash2 } from "lucide-react";
import { formatBytes, rfc3339ToUnix, timeAgo } from "../../lib/format";
import type { VolumeDto } from "../../types/docker";
import { Badge, EmptyState, IconButton } from "../../components/ui";

const VOLUME_GRID =
  "grid grid-cols-[minmax(150px,1.25fr)_84px_92px_minmax(112px,0.9fr)_92px_minmax(150px,1fr)_52px] items-center gap-x-3";

export function VolumeList({
  vols,
  search,
  onOpen,
  onDelete,
}: {
  vols: VolumeDto[];
  search: string;
  onOpen: (name: string) => void;
  onDelete: (v: VolumeDto) => void;
}) {
  const keyword = search.trim().toLowerCase();
  const filtered = keyword
    ? vols.filter(
        (v) =>
          v.name.toLowerCase().includes(keyword) ||
          v.driver.toLowerCase().includes(keyword) ||
          v.used_by.some((c) => c.toLowerCase().includes(keyword)),
      )
    : vols;

  return filtered.length === 0 ? (
    <EmptyState
      icon={<Database size={40} strokeWidth={1.5} />}
      title={keyword ? "没有匹配的卷" : "还没有存储卷"}
      desc={keyword ? "换个关键字试试" : "创建卷或运行挂载卷的容器后这里会显示"}
    />
  ) : (
    <div className="flex-1 overflow-auto p-4 pt-2">
      <div className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
        <div
          className={`${VOLUME_GRID} h-8 border-b border-edge bg-panel2/60 px-4 text-[11px] font-medium text-fg3`}
        >
          <div>名称</div>
          <div>驱动</div>
          <div>大小</div>
          <div>引用</div>
          <div>创建时间</div>
          <div>挂载点</div>
          <div />
        </div>
        {filtered.map((v) => (
          <div
            key={v.name}
            onClick={() => onOpen(v.name)}
            className={`${VOLUME_GRID} group cursor-pointer border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-hover`}
          >
            <div className="min-w-0">
              <div className="truncate font-medium text-fg" title={v.name}>
                {v.name}
              </div>
            </div>
            <div className="truncate font-mono text-[12px] text-fg2">{v.driver}</div>
            <div className="truncate text-[12px] tabular-nums text-fg2">
              {formatBytes(v.size)}
            </div>
            <div>
              {v.in_use ? (
                <Badge tone="accent" >
                  <span title={v.used_by.join("、")}>{v.ref_count} 个容器</span>
                </Badge>
              ) : (
                <Badge tone="warn">未使用</Badge>
              )}
            </div>
            <div className="text-[12px] text-fg3">{timeAgo(rfc3339ToUnix(v.created))}</div>
            <div
              className="truncate font-mono text-[11px] text-fg3"
              title={v.mountpoint}
            >
              {v.mountpoint}
            </div>
            <div
              className="flex items-center justify-end opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
              data-no-drag
            >
              <IconButton
                title="删除"
                className="hover:bg-err/10 hover:text-err"
                onClick={() => onDelete(v)}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
