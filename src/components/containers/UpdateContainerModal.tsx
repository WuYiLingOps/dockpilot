import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "../../lib/i18n";
import type { MsgKey } from "../../lib/i18n/zh";
import { api } from "../../lib/api";
import type { ContainerUpdateSpec } from "../../types/docker";
import { Button, Input, Modal, Select, Spinner } from "../ui";

const RESTART_OPTIONS: { value: string; labelKey: MsgKey }[] = [
  { value: "no", labelKey: "uc.policyNo" },
  { value: "always", labelKey: "uc.policyAlways" },
  { value: "unless-stopped", labelKey: "uc.policyUnlessStopped" },
  { value: "on-failure", labelKey: "uc.policyOnFailure" },
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
  const t = useT();
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
      .catch((e) =>
        toast.error(t("containers.readSpecFailed", { err: e instanceof Error ? e.message : String(e) })),
      )
      .finally(() => setLoading(false));
  }, [open, containerId]);

  const submit = async () => {
    const memNum = Number(memLimit);
    let memory_mb: number | null = null;
    if (memLimit.trim() !== "") {
      if (!Number.isFinite(memNum) || memNum <= 0) {
        toast.error(t("uc.memPositive"));
        return;
      }
      memory_mb = memUnit === "GB" ? memNum * 1024 : memNum;
    }
    let cpus: number | null = null;
    if (cpuLimit.trim() !== "") {
      const c = Number(cpuLimit);
      if (!Number.isFinite(c) || c <= 0) {
        toast.error(t("uc.cpuPositive"));
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
      toast.success(t("uc.updated"));
      void qc.invalidateQueries({ queryKey: ["containers"] });
      void qc.invalidateQueries({ queryKey: ["containerHealth"] });
      onClose();
    } catch (e) {
      toast.error(t("uc.updateFailed", { err: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("uc.title", { name: containerName })}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={loading || submitting} onClick={() => void submit()}>
            {submitting ? t("uc.updating") : t("uc.apply")}
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
            {t("uc.hint")}
          </p>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-fg2">
              {t("uc.restartPolicy")}
            </div>
            <Select value={restart} onChange={(e) => setRestart(e.target.value)} className="w-full">
              {RESTART_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-fg2">
              {t("uc.memLimit")}
            </div>
              <div className="flex gap-1.5">
                <Input
                  value={memLimit}
                  onChange={(e) => setMemLimit(e.target.value)}
                  placeholder={t("uc.unlimited")}
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
              <div className="mb-1.5 text-[12px] font-medium text-fg2">
              {t("uc.cpuCores")}
            </div>
              <Input
                value={cpuLimit}
                onChange={(e) => setCpuLimit(e.target.value)}
                placeholder={t("uc.unlimited")}
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
