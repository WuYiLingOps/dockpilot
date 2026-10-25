import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { KeyValueSpec } from "../../types/docker";
import { Button, Input, Modal, Select } from "../../components/ui";
import { KVEditor, NAME_RE } from "./shared";

export function CreateVolumeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const t = useT();
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
      toast.success(t("st.volumeCreated", { name: name.trim() }));
      onClose();
      setName("");
      setDriver("local");
      setLabels([]);
      for (const key of ["volumes", "systemDf"]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e) => toast.error(t("st.volumeCreateFailed", { err: String(e) })),
  });

  const submit = () => {
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      toast.error(t("st.invalidName"));
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
      title={t("st.createVolumeTitle")}
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
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">{t("st.name")}</div>
          <Input
            autoFocus
            className="w-full font-mono text-[12px]"
            placeholder={t("st.namePlaceholderVol")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-fg2">{t("st.driver")}</div>
          <Select className="w-full" value={driver} onChange={(e) => setDriver(e.target.value)}>
            {drivers.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
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
