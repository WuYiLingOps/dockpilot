import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Eraser, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import type { NetworkDto, VolumeDto } from "../../types/docker";
import {
  Button,
  ErrorNote,
  IconButton,
  Modal,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Spinner,
} from "../../components/ui";
import { VolumeList } from "./VolumeList";
import { VolumeDetailModal } from "./VolumeDetailModal";
import { NetworkList } from "./NetworkList";
import { NetworkDetailModal } from "./NetworkDetailModal";
import { CreateVolumeModal } from "./CreateVolumeModal";
import { CreateNetworkModal } from "./CreateNetworkModal";
import { UsageTab } from "./UsageTab";

export type StorageTab = "volumes" | "networks" | "usage";

const TABS: { key: StorageTab; label: string }[] = [
  { key: "volumes", label: "存储卷" },
  { key: "networks", label: "网络" },
  { key: "usage", label: "磁盘用量" },
];

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
        {tab !== "usage" && <SearchInput value={search} onChange={onSearch} className="w-44" />}
        {/* 三个 Tab 的主操作按钮统一固定宽度：切换时按钮槽位不动，仅文案变化 */}
        {tab === "volumes" && (
          <Button
            variant="primary"
            className="min-w-36"
            onClick={() => setCreateVolOpen(true)}
          >
            <Plus size={15} />
            创建卷
          </Button>
        )}
        {tab === "networks" && (
          <Button
            variant="primary"
            className="min-w-36"
            onClick={() => setCreateNetOpen(true)}
          >
            <Plus size={15} />
            创建网络
          </Button>
        )}
        {tab === "usage" && (
          <Button
            variant="tinted"
            className="min-w-36"
            onClick={onOpenCleanup}
          >
            <Eraser size={14} />
            前往空间清理
            <ArrowRight size={13} />
          </Button>
        )}
        {/* 控件组整体右对齐，搜索框显隐 / 按钮文案宽度随 Tab 变化；
            Tab 切换器必须紧贴右侧固定宽度的刷新按钮，位置才不随切换跳动 */}
        <SegmentedControl options={TABS} value={tab} onChange={onTab} />
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
