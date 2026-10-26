import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Eraser, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { NetworkDto, VolumeDto } from "../../types/docker";
import {
  Button,
  ErrorNote,
  IconButton,
  Modal,
  PageHeader,
  RefreshIcon,
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

const TABS: { key: StorageTab; labelKey: "st.tabVolumes" | "st.tabNetworks" | "st.tabUsage" }[] = [
  { key: "volumes", labelKey: "st.tabVolumes" },
  { key: "networks", labelKey: "st.tabNetworks" },
  { key: "usage", labelKey: "st.tabUsage" },
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
  const t = useT();
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
      toast.success(t("st.volumeDeleted", { name }));
      setPendingDeleteVol(null);
      setDetailVol(null);
      for (const key of ["volumes", "systemDf", "diskUsage"]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e) => toast.error(t("st.volumeDeleteFailed", { err: String(e) })),
  });

  const removeNetwork = useMutation({
    mutationFn: (name: string) => api.removeNetwork(name),
    onSuccess: (_, name) => {
      toast.success(t("st.networkDeleted", { name }));
      setPendingDeleteNet(null);
      setDetailNet(null);
      void qc.invalidateQueries({ queryKey: ["networks"] });
    },
    onError: (e) => toast.error(t("st.networkDeleteFailed", { err: String(e) })),
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
      ? t("st.volumesPageDesc", { n: vols.length, size: formatBytes(volSize) })
      : tab === "networks"
        ? t("st.networksPageDesc", { n: nets.length, custom: customNets })
        : dfd
          ? t("st.usagePageDesc", { size: formatBytes(totalUsage) })
          : t("st.usageLoading");

  const active =
    tab === "volumes" ? volumes : tab === "networks" ? networks : df;

  return (
    <>
      <PageHeader title={t("nav.storage")} desc={desc}>
        {tab !== "usage" && <SearchInput value={search} onChange={onSearch} className="w-44" />}
        {/* 三个 Tab 的主操作按钮统一固定宽度：切换时按钮槽位不动，仅文案变化 */}
        {tab === "volumes" && (
          <Button
            variant="primary"
            className="min-w-36"
            onClick={() => setCreateVolOpen(true)}
          >
            <Plus size={15} />
            {t("st.createVolume")}
          </Button>
        )}
        {tab === "networks" && (
          <Button
            variant="primary"
            className="min-w-36"
            onClick={() => setCreateNetOpen(true)}
          >
            <Plus size={15} />
            {t("st.createNetwork")}
          </Button>
        )}
        {tab === "usage" && (
          <Button
            variant="tinted"
            className="min-w-36"
            onClick={onOpenCleanup}
          >
            <Eraser size={14} />
            {t("st.goCleanup")}
            <ArrowRight size={13} />
          </Button>
        )}
        {/* 控件组整体右对齐，搜索框显隐 / 按钮文案宽度随 Tab 变化；
            Tab 切换器必须紧贴右侧固定宽度的刷新按钮，位置才不随切换跳动 */}
        <SegmentedControl
          options={TABS.map(({ key, labelKey }) => ({ key, label: t(labelKey) }))}
          value={tab}
          onChange={onTab}
        />
        <IconButton title={t("common.refresh")} onClick={() => void active.refetch()} className="h-8 w-8">
          <RefreshIcon spinning={active.isFetching} size={15} />
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
        title={t("st.deleteVolumeTitle")}
        onClose={() => setPendingDeleteVol(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDeleteVol(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={removeVolume.isPending}
              onClick={() => pendingDeleteVol && removeVolume.mutate(pendingDeleteVol.name)}
            >
              {t("containers.confirmDelete")}
            </Button>
          </>
        }
      >
        <p>
          {t("st.deleteVolumeConfirmBefore")}{" "}
          <span className="font-mono text-fg">{pendingDeleteVol?.name}</span>
          {t("st.deleteVolumeConfirmAfter")}
          {pendingDeleteVol && pendingDeleteVol.size > 0 && (
            <>
              {" "}
              （<span className="font-mono">{formatBytes(pendingDeleteVol.size)}</span>）{" "}
            </>
          )}
          {t("st.deleteVolumeDataNote")}
        </p>
        {pendingDeleteVol?.in_use && (
          <p className="mt-2 text-[12px] text-warn">
            {t("st.volumeInUse", { n: pendingDeleteVol.ref_count })}
          </p>
        )}
      </Modal>

      <Modal
        open={pendingDeleteNet !== null}
        title={t("st.deleteNetworkTitle")}
        onClose={() => setPendingDeleteNet(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingDeleteNet(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={removeNetwork.isPending}
              onClick={() => pendingDeleteNet && removeNetwork.mutate(pendingDeleteNet.name)}
            >
              {t("containers.confirmDelete")}
            </Button>
          </>
        }
      >
        <p>
          {t("st.deleteNetworkConfirmBefore")}{" "}
          <span className="font-mono text-fg">{pendingDeleteNet?.name}</span>
          {t("st.deleteNetworkConfirmAfter")}
        </p>
        {pendingDeleteNet && pendingDeleteNet.containers.length > 0 && (
          <p className="mt-2 text-[12px] text-warn">
            {t("st.networkInUse", { n: pendingDeleteNet.containers.length })}
          </p>
        )}
      </Modal>
    </>
  );
}
