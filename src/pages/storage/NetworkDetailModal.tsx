import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Trash2, Unlink2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { NetworkDto } from "../../types/docker";
import { Button, IconButton, Modal, Select } from "../../components/ui";
import { formatDateTime, InfoRow } from "./shared";
import { useState } from "react";

export function NetworkDetailModal({
  net,
  onClose,
  onDelete,
}: {
  net: NetworkDto | null;
  onClose: () => void;
  onDelete: (n: NetworkDto) => void;
}) {
  const qc = useQueryClient();
  const t = useT();
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
      toast.success(t("st.containerConnected"));
      setConnectId("");
      void qc.invalidateQueries({ queryKey: ["networks"] });
    },
    onError: (e) => toast.error(t("st.connectFailed", { err: String(e) })),
  });

  const disconnect = useMutation({
    mutationFn: ({ network, container }: { network: string; container: string }) =>
      api.disconnectNetwork(network, container),
    onSuccess: () => {
      toast.success(t("st.containerDisconnected"));
      void qc.invalidateQueries({ queryKey: ["networks"] });
    },
    onError: (e) => toast.error(t("st.disconnectFailed", { err: String(e) })),
  });

  if (!net) return null;
  const running = (containers.data ?? []).filter(
    (c) => c.state === "running" && !net.containers.some((nc) => nc.name === c.name),
  );

  return (
    <Modal open size="lg" title={t("st.netDetailTitle")} onClose={onClose}
      footer={
        <>
          <Button
            variant="danger"
            className="mr-auto"
            disabled={net.built_in}
            title={net.built_in ? t("st.builtInNoDelete") : undefined}
            onClick={() => onDelete(net)}
          >
            <Trash2 size={14} />
            {t("st.deleteNetwork")}
          </Button>
          <Button variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="grid gap-x-8 md:grid-cols-2">
        <div className="space-y-1">
          <InfoRow label={t("st.name")} value={net.name} />
          <InfoRow label="ID" value={net.id || "-"} />
          <InfoRow label={t("st.driver")} value={net.driver} />
          <InfoRow label={t("st.thScope")} value={net.scope || "-"} />
        </div>
        <div className="space-y-1">
          <InfoRow label={t("st.subnet")} value={net.subnet ?? t("st.autoAssigned")} />
          <InfoRow label={t("st.gateway")} value={net.gateway ?? "-"} />
          <InfoRow
            label={t("st.props")}
            value={
              [
                net.internal && t("st.internalNetwork"),
                net.attachable && t("st.attachable"),
                net.enable_ipv6 && "IPv6",
              ]
                .filter(Boolean)
                .join(" / ") || "-"
            }
          />
          <InfoRow label={t("st.createdAt")} value={formatDateTime(net.created)} />
        </div>
      </div>
      {net.labels.length > 0 && (
        <div className="mt-1">
          <InfoRow
            label={t("st.thLabels")}
            value={net.labels.map((l) => `${l.key}=${l.value}`).join("  ")}
          />
        </div>
      )}

      <div className="mt-3 border-t border-edge/60 pt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12px] font-medium text-fg2">
            {t("st.connectedContainers", { n: net.containers.length })}
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
                  {running.length === 0
                    ? t("st.noAttachableContainers")
                    : t("st.selectRunningContainers")}
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
                {t("st.connect")}
              </Button>
            </div>
          )}
        </div>
        {net.containers.length === 0 ? (
          <p className="text-[12px] text-fg3">{t("st.noContainersConnected")}</p>
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
                    title={t("st.disconnect")}
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
