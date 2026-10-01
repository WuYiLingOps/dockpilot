import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import type { KeyValueSpec } from "../../types/docker";
import { Button, Checkbox, Input, Modal, Select } from "../../components/ui";
import { KVEditor, NAME_RE } from "./shared";

const NETWORK_DRIVERS = ["bridge", "overlay", "macvlan", "ipvlan"];

export function CreateNetworkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
