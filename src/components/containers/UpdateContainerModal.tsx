import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import type { ContainerUpdateSpec } from "../../types/docker";
import { Button, Input, Modal, Select, Spinner } from "../ui";

const RESTART_OPTIONS = [
  { value: "no", label: "不重启（no）" },
  { value: "always", label: "始终重启（always）" },
  { value: "unless-stopped", label: "除非手动停止（unless-stopped）" },
  { value: "on-failure", label: "失败时重启（on-failure）" },
];

/**
 * 在线更新容器配置（docker update）：重启策略、内存上限、CPU 核数。
 * 打开时经 container_spec 反解析读取当前值回填；留空表示保持不变。
 */
export function UpdateContainerModal({
  open,
  containerId,
  containerName,
  onClose,
}: {
  open: boolean;
  containerId: string;
  containerName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [restart, setRestart] = useState("no");
  const [memLimit, setMemLimit] = useState("");
  const [memUnit, setMemUnit] = useState<"MB" | "GB">("MB");
  const [cpuLimit, setCpuLimit] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 打开时读取当前配置回填
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .containerSpec(containerId)
      .then((spec) => {
        setRestart(spec.restart_policy ?? "no");
        if (spec.memory_mb && spec.memory_mb > 0) {
          if (spec.memory_mb % 1024 === 0 && spec.memory_mb >= 1024) {
            setMemUnit("GB");
            setMemLimit(String(spec.memory_mb / 1024));
          } else {
            setMemUnit("MB");
            setMemLimit(String(spec.memory_mb));
          }
        } else {
          setMemLimit("");
          setMemUnit("MB");
        }
        setCpuLimit(spec.cpus && spec.cpus > 0 ? String(spec.cpus) : "");
      })
      .catch((e) => toast.error(`读取容器配置失败: ${e instanceof Error ? e.message : e}`))
      .finally(() => setLoading(false));
  }, [open, containerId]);

  const submit = async () => {
    const memNum = Number(memLimit);
    let memory_mb: number | null = null;
    if (memLimit.trim() !== "") {
      if (!Number.isFinite(memNum) || memNum <= 0) {
        toast.error("内存上限必须是正数");
        return;
      }
      memory_mb = memUnit === "GB" ? memNum * 1024 : memNum;
    }
    let cpus: number | null = null;
    if (cpuLimit.trim() !== "") {
      const c = Number(cpuLimit);
      if (!Number.isFinite(c) || c <= 0) {
        toast.error("CPU 核数必须是正数");
        return;
      }
      cpus = c;
    }
    const spec: ContainerUpdateSpec = {
      restart_policy: restart,
      memory_mb,
      cpus,
    };
    setSubmitting(true);
    try {
      await api.updateContainerConfig(containerId, spec);
      toast.success("容器配置已更新");
      void qc.invalidateQueries({ queryKey: ["containers"] });
      void qc.invalidateQueries({ queryKey: ["containerHealth"] });
      onClose();
    } catch (e) {
      toast.error(`更新失败: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`更新配置 — ${containerName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={loading || submitting} onClick={() => void submit()}>
            {submitting ? "更新中…" : "应用更改"}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex h-28 items-center justify-center">
          <Spinner className="h-5 w-5" />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[12px] text-fg3">
            通过 docker update 在线生效，无需重建容器；留空表示保持不变。内存上限无法清除，且更新时 swap
            会按 Docker 默认比例同步为 2 倍内存（daemon 限制）。
          </p>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-fg2">重启策略</div>
            <Select value={restart} onChange={(e) => setRestart(e.target.value)} className="w-full">
              {RESTART_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-fg2">内存上限</div>
              <div className="flex gap-1.5">
                <Input
                  value={memLimit}
                  onChange={(e) => setMemLimit(e.target.value)}
                  placeholder="不限制"
                  type="number"
                  min={1}
                  className="w-full"
                />
                <Select
                  value={memUnit}
                  onChange={(e) => setMemUnit(e.target.value as "MB" | "GB")}
                  className="w-20 shrink-0"
                >
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </Select>
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-fg2">CPU 核数</div>
              <Input
                value={cpuLimit}
                onChange={(e) => setCpuLimit(e.target.value)}
                placeholder="不限制"
                type="number"
                min={0.1}
                step={0.1}
                className="w-full"
              />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
