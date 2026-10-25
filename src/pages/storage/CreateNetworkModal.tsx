import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { KeyValueSpec } from "../../types/docker";
import { Button, Checkbox, Input, Modal, Select } from "../../components/ui";
import { KVEditor, NAME_RE } from "./shared";

const NETWORK_DRIVERS = ["bridge", "overlay", "macvlan", "ipvlan"];

export function CreateNetworkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const t = useT();
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
      toast.success(t("st.networkCreated", { name: name.trim() }));
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
    onError: (e) => toast.error(t("st.networkCreateFailed", { err: String(e) })),
  });

  const submit = () => {
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      toast.error(t("st.invalidName"));
      return;
    }
    const s = subnet.trim();
    if (s && !s.includes("/")) {
      toast.error(t("st.invalidCidr"));
      return;
    }
    create.mutate();
  };

  return (
    <Modal
      open={open}
      size="lg"
      title={t("st.createNetwork")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={create.isPending} onClick={submit}>
            {t("st.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] font-medium text-fg2">{t("st.name")}</div>
            <Input
              autoFocus
              className="w-full font-mono text-[12px]"
              placeholder="my-net"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-fg2">{t("st.driver")}</div>
            <Select className="w-full" value={driver} onChange={(e) => setDriver(e.target.value)}>
              {NETWORK_DRIVERS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-fg2">{t("st.subnetOptional")}</div>
            <Input
              className="w-full font-mono text-[12px]"
              placeholder="172.30.0.0/16"
              value={subnet}
              onChange={(e) => setSubnet(e.target.value)}
            />
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-fg2">{t("st.gatewayOptional")}</div>
            <Input
              className="w-full font-mono text-[12px]"
              placeholder="172.30.0.1"
              value={gateway}
              onChange={(e) => setGateway(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          <Checkbox label={t("st.internalCheckbox")} checked={internal} onChange={setInternal} />
          <Checkbox label={t("st.attachableCheckbox")} checked={attachable} onChange={setAttachable} />
          <Checkbox label={t("st.ipv6Checkbox")} checked={enableIpv6} onChange={setEnableIpv6} />
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">
            {t("st.labels", { n: labels.length })}
          </div>
          <KVEditor rows={labels} onChange={setLabels} />
        </div>
      </div>
    </Modal>
  );
}
