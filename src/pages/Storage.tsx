import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Database,
  Eraser,
  Link2,
  Network,
  Plus,
  RefreshCw,
  Trash2,
  Unlink2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { formatBytes, rfc3339ToUnix, shortId, timeAgo } from "../lib/format";
import type {
  KeyValueSpec,
  NetworkDto,
  VolumeDto,
} from "../types/docker";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorNote,
  IconButton,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  Spinner,
  cn,
} from "../components/ui";
import { CHART_COLORS, Treemap } from "../components/overview/Charts";

export type StorageTab = "volumes" | "networks" | "usage";

const TABS: { key: StorageTab; label: string }[] = [
  { key: "volumes", label: "存储卷" },
  { key: "networks", label: "网络" },
  { key: "usage", label: "磁盘用量" },
];

const VOLUME_GRID =
  "grid grid-cols-[minmax(150px,1.25fr)_84px_92px_minmax(112px,0.9fr)_92px_minmax(150px,1fr)_52px] items-center gap-x-3";
const NETWORK_GRID =
  "grid grid-cols-[minmax(150px,1.2fr)_84px_64px_minmax(170px,1fr)_76px_minmax(130px,0.9fr)_52px] items-center gap-x-3";

/** 卷/网络名称约束，与后端 conn.rs 的校验一致 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function formatDateTime(s: string | null): string {
  if (!s) return "-";
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? s : t.toLocaleString();
}

/* ---------------------------------------------------------------- */
/* 页内小组件（与 Overview 的 Card/InfoRow/StatCell 同风格）            */
/* ---------------------------------------------------------------- */

function Panel({
  icon: Icon,
  title,
  extra,
  className,
  children,
}: {
  icon: typeof Database;
  title: string;
  extra?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge/60 px-4 py-2.5 text-[12px] font-medium text-fg2">
        <Icon size={13} className="text-fg3" />
        {title}
        {extra && <div className="ml-auto flex items-center gap-2">{extra}</div>}
      </div>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-[3px]">
      <span className="w-20 shrink-0 text-right text-[12px] text-fg3">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-[12px] text-fg">{value}</span>
    </div>
  );
}

function StatCell({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[12px] text-fg3">
        {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
        {label}
      </div>
      <div className="mt-0.5 truncate text-[16px] font-semibold tabular-nums text-fg">{value}</div>
      {sub && <div className="truncate text-[11px] text-fg3">{sub}</div>}
    </div>
  );
}

/** 标签键值对编辑行（与容器创建弹窗的交互一致） */
function KVEditor({
  rows,
  onChange,
}: {
  rows: KeyValueSpec[];
  onChange: (rows: KeyValueSpec[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            className="h-7 flex-1 font-mono text-[12px]"
            placeholder="键"
            value={r.key}
            onChange={(e) =>
              onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
            }
          />
          <Input
            className="h-7 flex-1 font-mono text-[12px]"
            placeholder="值"
            value={r.value}
            onChange={(e) =>
              onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
            }
          />
          <IconButton
            title="移除标签"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X size={13} />
          </IconButton>
        </div>
      ))}
      <Button
        variant="ghost"
        className="h-7 px-2 text-[12px]"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus size={13} />
        添加标签
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 页面                                                               */
/* ---------------------------------------------------------------- */

export function Storage({
  tab,
  onTab,
  search,
  onSearch,
  onOpenCleanup,
}: {
  tab: StorageTab;
  onTab: (t: StorageTab) => void;
  search: string;
  onSearch: (v: string) => void;
  onOpenCleanup: () => void;
}) {
  const qc = useQueryClient();
  const volumes = useQuery({
    queryKey: ["volumes"],
    queryFn: api.listVolumes,
    refetchInterval: 30000,
  });
  const networks = useQuery({
    queryKey: ["networks"],
    queryFn: api.listNetworks,
    refetchInterval: 30000,
  });
  const df = useQuery({
    queryKey: ["systemDf"],
    queryFn: api.systemDf,
    refetchInterval: 30000,
  });

  const [detailVol, setDetailVol] = useState<string | null>(null);
  const [detailNet, setDetailNet] = useState<string | null>(null);
  const [pendingDeleteVol, setPendingDeleteVol] = useState<VolumeDto | null>(null);
  const [pendingDeleteNet, setPendingDeleteNet] = useState<NetworkDto | null>(null);
  const [createVolOpen, setCreateVolOpen] = useState(false);
  const [createNetOpen, setCreateNetOpen] = useState(false);

  // 详情从列表数据实时取，弹窗随列表刷新（删除/断开后自动反映变化）
  const vol = detailVol ? (volumes.data?.find((v) => v.name === detailVol) ?? null) : null;
  const net = detailNet ? (networks.data?.find((n) => n.name === detailNet) ?? null) : null;

  const removeVolume = useMutation({
    mutationFn: (name: string) => api.removeVolume(name),
    onSuccess: (_, name) => {
      toast.success(`卷 ${name} 已删除`);
      setPendingDeleteVol(null);
      setDetailVol(null);
      for (const key of ["volumes", "systemDf", "diskUsage"]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e) => toast.error(`删除卷失败: ${e}`),
  });

  const removeNetwork = useMutation({
    mutationFn: (name: string) => api.removeNetwork(name),
    onSuccess: (_, name) => {
      toast.success(`网络 ${name} 已删除`);
      setPendingDeleteNet(null);
      setDetailNet(null);
      void qc.invalidateQueries({ queryKey: ["networks"] });
    },
    onError: (e) => toast.error(`删除网络失败: ${e}`),
  });

  const vols = volumes.data ?? [];
  const nets = networks.data ?? [];
  const dfd = df.data;
  const volSize = vols.reduce((s, v) => s + v.size, 0);
  const customNets = nets.filter((n) => !n.built_in).length;
  const totalUsage = dfd
    ? dfd.images_size + dfd.containers_size + dfd.volumes_size + dfd.build_cache_size
    : 0;

  const desc =
    tab === "volumes"
      ? `${vols.length} 个卷 · 占用 ${formatBytes(volSize)} · 点击行查看详情`
      : tab === "networks"
        ? `${nets.length} 个网络 · ${customNets} 个自定义 · 点击行查看详情`
        : dfd
          ? `Docker 总占用约 ${formatBytes(totalUsage)}`
          : "统计 Docker 磁盘占用中";

  const active =
    tab === "volumes" ? volumes : tab === "networks" ? networks : df;

  return (
    <>
      <PageHeader title="存储和网络" desc={desc}>
        <SegmentedControl options={TABS} value={tab} onChange={onTab} />
        {tab !== "usage" && <SearchInput value={search} onChange={onSearch} className="w-44" />}
        {tab === "volumes" && (
          <Button variant="primary" onClick={() => setCreateVolOpen(true)}>
            <Plus size={15} />
            创建卷
          </Button>
        )}
        {tab === "networks" && (
          <Button variant="primary" onClick={() => setCreateNetOpen(true)}>
            <Plus size={15} />
            创建网络
          </Button>
        )}
        {tab === "usage" && (
          <Button variant="tinted" onClick={onOpenCleanup}>
            <Eraser size={14} />
            前往空间清理
            <ArrowRight size={13} />
          </Button>
        )}
        <IconButton title="刷新" onClick={() => void active.refetch()} className="h-8 w-8">
          <RefreshCw size={15} className={active.isFetching ? "animate-spin" : ""} />
        </IconButton>
      </PageHeader>

      {tab === "volumes" && (
        <>
          {volumes.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="h-6 w-6" />
            </div>
          ) : volumes.isError ? (
            <ErrorNote
              message={String(volumes.error)}
              onRetry={() => void volumes.refetch()}
            />
          ) : (
            <VolumeList
              vols={vols}
              search={search}
              onOpen={setDetailVol}
              onDelete={setPendingDeleteVol}
            />
          )}
        </>
      )}

      {tab === "networks" && (
        <>
          {networks.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="h-6 w-6" />
            </div>
          ) : networks.isError ? (
            <ErrorNote
              message={String(networks.error)}
              onRetry={() => void networks.refetch()}
            />
          ) : (
            <NetworkList
              nets={nets}
              search={search}
              onOpen={setDetailNet}
              onDelete={setPendingDeleteNet}
            />
          )}
        </>
      )}

      {tab === "usage" && <UsageTab dfd={dfd} dfError={df.isError ? String(df.error) : null} onRetry={() => void df.refetch()} />}

      {/* ---- 详情弹窗 ---- */}
      <VolumeDetailModal
        vol={vol}
        onClose={() => setDetailVol(null)}
        onDelete={(v) => {
          setDetailVol(null);
          setPendingDeleteVol(v);
        }}
      />
      <NetworkDetailModal
        net={net}
        onClose={() => setDetailNet(null)}
        onDelete={(n) => {
          setDetailNet(null);
          setPendingDeleteNet(n);
        }}
      />

      {/* ---- 创建弹窗 ---- */}
      <CreateVolumeModal
        open={createVolOpen}
        onClose={() => setCreateVolOpen(false)}
      />
      <CreateNetworkModal
        open={createNetOpen}
        onClose={() => setCreateNetOpen(false)}
      />

      {/* ---- 删除确认 ---- */}
      <Modal
        open={pendingDeleteVol !== null}
        title="删除存储卷"
        onClose={() => setPendingDeleteVol(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDeleteVol(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={removeVolume.isPending}
              onClick={() => pendingDeleteVol && removeVolume.mutate(pendingDeleteVol.name)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p>
          确定删除卷 <span className="font-mono text-fg">{pendingDeleteVol?.name}</span> 吗？卷内
          {pendingDeleteVol && pendingDeleteVol.size > 0 && (
            <>
              {" "}
              （<span className="font-mono">{formatBytes(pendingDeleteVol.size)}</span>）{" "}
            </>
          )}
          数据将一并删除，此操作不可恢复。
        </p>
        {pendingDeleteVol?.in_use && (
          <p className="mt-2 text-[12px] text-warn">
            该卷正在被 {pendingDeleteVol.ref_count} 个容器使用，需先卸载相关容器后才能删除。
          </p>
        )}
      </Modal>

      <Modal
        open={pendingDeleteNet !== null}
        title="删除网络"
        onClose={() => setPendingDeleteNet(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDeleteNet(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={removeNetwork.isPending}
              onClick={() => pendingDeleteNet && removeNetwork.mutate(pendingDeleteNet.name)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p>
          确定删除网络{" "}
          <span className="font-mono text-fg">{pendingDeleteNet?.name}</span> 吗？
        </p>
        {pendingDeleteNet && pendingDeleteNet.containers.length > 0 && (
          <p className="mt-2 text-[12px] text-warn">
            该网络仍连接着 {pendingDeleteNet.containers.length} 个容器，需先断开连接后才能删除。
          </p>
        )}
      </Modal>
    </>
  );
}

/* ---------------------------------------------------------------- */
/* 存储卷列表                                                          */
/* ---------------------------------------------------------------- */

function VolumeList({
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

function VolumeDetailModal({
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

/* ---------------------------------------------------------------- */
/* 网络列表                                                            */
/* ---------------------------------------------------------------- */

function NetworkList({
  nets,
  search,
  onOpen,
  onDelete,
}: {
  nets: NetworkDto[];
  search: string;
  onOpen: (name: string) => void;
  onDelete: (n: NetworkDto) => void;
}) {
  const keyword = search.trim().toLowerCase();
  const filtered = keyword
    ? nets.filter(
        (n) =>
          n.name.toLowerCase().includes(keyword) ||
          n.driver.toLowerCase().includes(keyword) ||
          (n.subnet ?? "").includes(keyword),
      )
    : nets;

  return filtered.length === 0 ? (
    <EmptyState
      icon={<Network size={40} strokeWidth={1.5} />}
      title="没有匹配的网络"
      desc="换个关键字试试"
    />
  ) : (
    <div className="flex-1 overflow-auto p-4 pt-2">
      <div className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
        <div
          className={`${NETWORK_GRID} h-8 border-b border-edge bg-panel2/60 px-4 text-[11px] font-medium text-fg3`}
        >
          <div>名称</div>
          <div>驱动</div>
          <div>范围</div>
          <div>子网 / 网关</div>
          <div>已连接</div>
          <div>标记</div>
          <div />
        </div>
        {filtered.map((n) => (
          <div
            key={n.id || n.name}
            onClick={() => onOpen(n.name)}
            className={`${NETWORK_GRID} group cursor-pointer border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-hover`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-fg" title={n.name}>
                  {n.name}
                </span>
                {n.internal && <Badge tone="warn">内部</Badge>}
              </div>
              <div className="truncate font-mono text-[11px] text-fg3">{shortId(n.id)}</div>
            </div>
            <div className="truncate font-mono text-[12px] text-fg2">{n.driver}</div>
            <div className="text-[12px] text-fg2">{n.scope || "-"}</div>
            <div className="min-w-0">
              {n.subnet || n.gateway ? (
                <>
                  <div className="truncate font-mono text-[11px] text-fg2" title={n.subnet ?? ""}>
                    {n.subnet ?? "-"}
                  </div>
                  <div className="truncate font-mono text-[11px] text-fg3" title={n.gateway ?? ""}>
                    {n.gateway ?? "-"}
                  </div>
                </>
              ) : (
                <span className="text-[12px] text-fg3">自动分配</span>
              )}
            </div>
            <div className="text-[12px] tabular-nums text-fg2">
              {n.containers.length > 0 ? `${n.containers.length} 个` : "0"}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {n.built_in && <Badge>内置</Badge>}
              {n.enable_ipv6 && <Badge tone="accent">IPv6</Badge>}
              {!n.built_in && !n.enable_ipv6 && <span className="text-fg3">—</span>}
            </div>
            <div
              className="flex items-center justify-end opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
              data-no-drag
            >
              <IconButton
                title={n.built_in ? "内置网络不可删除" : "删除"}
                disabled={n.built_in}
                className="hover:bg-err/10 hover:text-err"
                onClick={() => onDelete(n)}
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

function NetworkDetailModal({
  net,
  onClose,
  onDelete,
}: {
  net: NetworkDto | null;
  onClose: () => void;
  onDelete: (n: NetworkDto) => void;
}) {
  const qc = useQueryClient();
  const [connectId, setConnectId] = useState("");
  // 详情打开时才拉运行中容器，供"连接容器"下拉选择
  const containers = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.listContainers(true),
    enabled: net !== null,
  });

  const connect = useMutation({
    mutationFn: ({ network, container }: { network: string; container: string }) =>
      api.connectNetwork(network, container),
    onSuccess: () => {
      toast.success("容器已接入网络");
      setConnectId("");
      void qc.invalidateQueries({ queryKey: ["networks"] });
    },
    onError: (e) => toast.error(`连接网络失败: ${e}`),
  });

  const disconnect = useMutation({
    mutationFn: ({ network, container }: { network: string; container: string }) =>
      api.disconnectNetwork(network, container),
    onSuccess: () => {
      toast.success("容器已从网络断开");
      void qc.invalidateQueries({ queryKey: ["networks"] });
    },
    onError: (e) => toast.error(`断开网络失败: ${e}`),
  });

  if (!net) return null;
  const running = (containers.data ?? []).filter(
    (c) => c.state === "running" && !net.containers.some((nc) => nc.name === c.name),
  );

  return (
    <Modal open size="lg" title="网络详情" onClose={onClose}
      footer={
        <>
          <Button
            variant="danger"
            className="mr-auto"
            disabled={net.built_in}
            title={net.built_in ? "内置网络不可删除" : undefined}
            onClick={() => onDelete(net)}
          >
            <Trash2 size={14} />
            删除网络
          </Button>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <div className="grid gap-x-8 md:grid-cols-2">
        <div className="space-y-1">
          <InfoRow label="名称" value={net.name} />
          <InfoRow label="ID" value={net.id || "-"} />
          <InfoRow label="驱动" value={net.driver} />
          <InfoRow label="范围" value={net.scope || "-"} />
        </div>
        <div className="space-y-1">
          <InfoRow label="子网" value={net.subnet ?? "自动分配"} />
          <InfoRow label="网关" value={net.gateway ?? "-"} />
          <InfoRow
            label="属性"
            value={
              [
                net.internal && "内部网络",
                net.attachable && "可连接",
                net.enable_ipv6 && "IPv6",
              ]
                .filter(Boolean)
                .join(" / ") || "-"
            }
          />
          <InfoRow label="创建时间" value={formatDateTime(net.created)} />
        </div>
      </div>
      {net.labels.length > 0 && (
        <div className="mt-1">
          <InfoRow
            label="标签"
            value={net.labels.map((l) => `${l.key}=${l.value}`).join("  ")}
          />
        </div>
      )}

      <div className="mt-3 border-t border-edge/60 pt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12px] font-medium text-fg2">
            已连接容器（{net.containers.length}）
          </span>
          {!net.built_in && (
            <div className="flex items-center gap-1.5">
              <Select
                className="w-44"
                value={connectId}
                onChange={(e) => setConnectId(e.target.value)}
                disabled={connect.isPending || running.length === 0}
              >
                <option value="">
                  {running.length === 0 ? "没有可接入的容器" : "选择运行中的容器"}
                </option>
                {running.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Button
                variant="tinted"
                disabled={!connectId || connect.isPending}
                onClick={() =>
                  connectId && connect.mutate({ network: net.name, container: connectId })
                }
              >
                <Link2 size={13} />
                连接
              </Button>
            </div>
          )}
        </div>
        {net.containers.length === 0 ? (
          <p className="text-[12px] text-fg3">暂无容器连接该网络</p>
        ) : (
          <div className="space-y-1">
            {net.containers.map((c) => (
              <div
                key={c.id}
                className="group/row flex items-center gap-3 rounded-btn bg-panel2 px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                  {c.name}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-fg3" title={c.ipv4}>
                  {c.ipv4 || "-"}
                </span>
                {!net.built_in && (
                  <IconButton
                    title="断开连接"
                    disabled={disconnect.isPending}
                    className="hover:bg-err/10 hover:text-err"
                    onClick={() => disconnect.mutate({ network: net.name, container: c.name })}
                  >
                    <Unlink2 size={13} />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- */
/* 创建弹窗                                                            */
/* ---------------------------------------------------------------- */

function CreateVolumeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ["dockerInfo"],
    queryFn: api.dockerInfo,
    retry: false,
    refetchInterval: 15000,
  });
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("local");
  const [labels, setLabels] = useState<KeyValueSpec[]>([]);

  const create = useMutation({
    mutationFn: () =>
      api.createVolume({
        name: name.trim(),
        driver: driver.trim() || null,
        labels: labels.filter((r) => r.key.trim() !== ""),
      }),
    onSuccess: () => {
      toast.success(`卷 ${name.trim()} 已创建`);
      onClose();
      setName("");
      setDriver("local");
      setLabels([]);
      for (const key of ["volumes", "systemDf"]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e) => toast.error(`创建卷失败: ${e}`),
  });

  const submit = () => {
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      toast.error("卷名称只能包含字母、数字、下划线、点和中划线，且以字母或数字开头");
      return;
    }
    create.mutate();
  };

  const drivers = Array.from(
    new Set(["local", ...(info.data?.plugins_volume ?? [])]),
  );

  return (
    <Modal
      open={open}
      title="创建存储卷"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={create.isPending} onClick={submit}>
            创建
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">名称</div>
          <Input
            autoFocus
            className="w-full font-mono text-[12px]"
            placeholder="例如 app-data"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">驱动</div>
          <Select className="w-full" value={driver} onChange={(e) => setDriver(e.target.value)}>
            {drivers.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">标签（{labels.length}）</div>
          <KVEditor rows={labels} onChange={setLabels} />
        </div>
      </div>
    </Modal>
  );
}

const NETWORK_DRIVERS = ["bridge", "overlay", "macvlan", "ipvlan"];

function CreateNetworkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("bridge");
  const [subnet, setSubnet] = useState("");
  const [gateway, setGateway] = useState("");
  const [internal, setInternal] = useState(false);
  const [attachable, setAttachable] = useState(true);
  const [enableIpv6, setEnableIpv6] = useState(false);
  const [labels, setLabels] = useState<KeyValueSpec[]>([]);

  const create = useMutation({
    mutationFn: () =>
      api.createNetwork({
        name: name.trim(),
        driver: driver.trim() || null,
        subnet: subnet.trim() || null,
        gateway: gateway.trim() || null,
        internal,
        attachable,
        enable_ipv6: enableIpv6,
        labels: labels.filter((r) => r.key.trim() !== ""),
      }),
    onSuccess: () => {
      toast.success(`网络 ${name.trim()} 已创建`);
      onClose();
      setName("");
      setDriver("bridge");
      setSubnet("");
      setGateway("");
      setInternal(false);
      setAttachable(true);
      setEnableIpv6(false);
      setLabels([]);
      void qc.invalidateQueries({ queryKey: ["networks"] });
    },
    onError: (e) => toast.error(`创建网络失败: ${e}`),
  });

  const submit = () => {
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      toast.error("网络名称只能包含字母、数字、下划线、点和中划线，且以字母或数字开头");
      return;
    }
    const s = subnet.trim();
    if (s && !s.includes("/")) {
      toast.error("子网需为 CIDR 格式，例如 172.30.0.0/16");
      return;
    }
    create.mutate();
  };

  return (
    <Modal
      open={open}
      size="lg"
      title="创建网络"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={create.isPending} onClick={submit}>
            创建
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] font-medium text-fg2">名称</div>
            <Input
              autoFocus
              className="w-full font-mono text-[12px]"
              placeholder="例如 my-net"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-fg2">驱动</div>
            <Select className="w-full" value={driver} onChange={(e) => setDriver(e.target.value)}>
              {NETWORK_DRIVERS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-fg2">子网（选填）</div>
            <Input
              className="w-full font-mono text-[12px]"
              placeholder="172.30.0.0/16"
              value={subnet}
              onChange={(e) => setSubnet(e.target.value)}
            />
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-fg2">网关（选填）</div>
            <Input
              className="w-full font-mono text-[12px]"
              placeholder="172.30.0.1"
              value={gateway}
              onChange={(e) => setGateway(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          <Checkbox label="内部网络（不提供外部访问）" checked={internal} onChange={setInternal} />
          <Checkbox label="允许手动接入容器" checked={attachable} onChange={setAttachable} />
          <Checkbox label="启用 IPv6" checked={enableIpv6} onChange={setEnableIpv6} />
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">标签（{labels.length}）</div>
          <KVEditor rows={labels} onChange={setLabels} />
        </div>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- */
/* 磁盘用量 Tab                                                        */
/* ---------------------------------------------------------------- */

type UsageScope = "all" | "containers" | "images" | "volumes" | "cache";

const USAGE_SCOPES: { key: UsageScope; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "images", label: "镜像" },
  { key: "containers", label: "容器" },
  { key: "volumes", label: "存储卷" },
  { key: "cache", label: "构建缓存" },
];

function UsageTab({
  dfd,
  dfError,
  onRetry,
}: {
  dfd: import("../types/docker").SystemDfDto | undefined;
  dfError: string | null;
  onRetry: () => void;
}) {
  const [scope, setScope] = useState<UsageScope>("all");

  const treemapItems = useMemo(() => {
    if (!dfd) return [];
    if (scope === "containers") return dfd.containers;
    if (scope === "images") return dfd.images;
    if (scope === "volumes") return dfd.volumes;
    if (scope === "cache")
      return dfd.build_cache.map((b) => ({
        name: b.description || shortId(b.id),
        size: b.size,
      }));
    return [...dfd.images, ...dfd.containers, ...dfd.volumes].sort(
      (a, b) => b.size - a.size,
    );
  }, [dfd, scope]);

  if (dfError) {
    return <ErrorNote message={dfError} onRetry={onRetry} />;
  }
  if (!dfd) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-3 overflow-auto p-4 pt-2">
      <Panel
        icon={Eraser}
        title="占用分布"
        extra={<SegmentedControl options={USAGE_SCOPES} value={scope} onChange={setScope} />}
      >
        <Treemap items={treemapItems} height={250} />
        <div className="mt-4 grid grid-cols-2 content-start gap-x-8 gap-y-5 sm:grid-cols-4">
          <StatCell
            label="镜像"
            value={formatBytes(dfd.images_size)}
            sub={`${dfd.images_count} 个`}
            color={CHART_COLORS[0]}
          />
          <StatCell
            label="容器"
            value={formatBytes(dfd.containers_size)}
            sub={`${dfd.containers_count} 个`}
            color={CHART_COLORS[1]}
          />
          <StatCell
            label="存储卷"
            value={formatBytes(dfd.volumes_size)}
            sub={`${dfd.volumes_count} 个 · 不含挂载目录`}
            color={CHART_COLORS[2]}
          />
          <StatCell
            label="构建缓存"
            value={formatBytes(dfd.build_cache_size)}
            sub={`${dfd.build_cache.length} 条`}
            color={CHART_COLORS[3]}
          />
        </div>
      </Panel>

      <Panel
        icon={Database}
        title="构建缓存明细"
        extra={
          <span className="text-[11px] text-fg3">
            共 {dfd.build_cache.length} 条 · {formatBytes(dfd.build_cache_size)}
          </span>
        }
      >
        {dfd.build_cache.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-fg3">暂无构建缓存</p>
        ) : (
          <div className="space-y-1">
            {dfd.build_cache.map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-3 rounded-btn px-2 py-1.5 transition-colors hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg2" title={b.description || b.id}>
                  {b.description || shortId(b.id)}
                </span>
                <Badge>{b.typ || "cache"}</Badge>
                {b.shared && <Badge tone="accent">共享</Badge>}
                {b.in_use ? <Badge tone="ok">使用中</Badge> : <Badge tone="warn">未使用</Badge>}
                <span className="w-16 shrink-0 text-right text-[11px] text-fg3">
                  {timeAgo(rfc3339ToUnix(b.created_at))}
                </span>
                <span className="w-20 shrink-0 text-right text-[12px] tabular-nums text-fg2">
                  {formatBytes(b.size)}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 border-t border-edge/60 pt-3 text-[11px] text-fg3">
          可在「空间清理」页回收未使用的构建缓存与镜像。
        </div>
      </Panel>
    </div>
  );
}
