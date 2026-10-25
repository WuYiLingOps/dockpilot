import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "../../lib/i18n";
import type { MsgKey } from "../../lib/i18n/zh";
import { api } from "../../lib/api";
import type { ContainerSpec, PortMappingSpec, VolumeMountSpec } from "../../types/docker";
import { Button, Checkbox, IconButton, Input, Modal, Select } from "../ui";

/** 表单行状态：字符串态，提交时统一校验转换 */
type PortRow = { host: string; container: string; proto: "tcp" | "udp" };
type VolumeRow = { host: string; container: string; readOnly: boolean };
type KVRow = { key: string; value: string };

const RESTART_OPTIONS: { value: string; labelKey: MsgKey }[] = [
  { value: "no", labelKey: "cc.policyNo" },
  { value: "always", labelKey: "cc.policyAlways" },
  { value: "unless-stopped", labelKey: "cc.policyUnlessStopped" },
  { value: "on-failure", labelKey: "cc.policyOnFailure" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[12px] font-medium text-fg2">{title}</div>
      {children}
    </div>
  );
}

const row =
  "grid items-center gap-1.5 [&>input]:w-full [&>select]:w-full [&_.text-fg2]:whitespace-nowrap";

/**
 * 创建并运行容器（对齐 Docker Desktop 的 Run 对话框）：
 * 镜像（本地不存在时自动拉取）、容器名、端口/卷/环境变量/标签映射，
 * 高级选项：命令覆盖、工作目录、网络、主机名、重启策略、自动移除、特权、TTY。
 * 支持两种回填来源：initialSpec（克隆容器）与粘贴 docker run 命令导入。
 */
export function CreateContainerModal({
  open,
  onClose,
  initialImage = "",
  initialSpec = null,
}: {
  open: boolean;
  onClose: () => void;
  /** 从镜像页「运行」进入时预填的镜像标签 */
  initialImage?: string;
  /** 克隆容器入口：以该规格全量回填表单（优先于 initialImage） */
  initialSpec?: ContainerSpec | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  const cancelPullRef = useRef<(() => void) | null>(null);

  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [ports, setPorts] = useState<PortRow[]>([]);
  const [volumes, setVolumes] = useState<VolumeRow[]>([]);
  const [env, setEnv] = useState<KVRow[]>([]);
  const [labels, setLabels] = useState<KVRow[]>([]);
  const [restart, setRestart] = useState("no");
  const [command, setCommand] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [network, setNetwork] = useState("");
  const [hostname, setHostname] = useState("");
  const [memLimit, setMemLimit] = useState("");
  const [memUnit, setMemUnit] = useState<"MB" | "GB">("MB");
  const [cpuLimit, setCpuLimit] = useState("");
  const [autoRemove, setAutoRemove] = useState(false);
  const [privileged, setPrivileged] = useState(false);
  const [tty, setTty] = useState(false);
  const [stdin, setStdin] = useState(false);
  const [pullStatus, setPullStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importCmd, setImportCmd] = useState("");
  const [importing, setImporting] = useState(false);

  /** 把规格回填到表单（克隆容器与 docker run 导入共用） */
  const applySpec = (s: ContainerSpec) => {
    setImage(s.image);
    setName(s.name ?? "");
    setPorts(
      s.ports.map((p) => ({
        host: String(p.host),
        container: String(p.container),
        proto: p.proto === "udp" ? ("udp" as const) : ("tcp" as const),
      })),
    );
    setVolumes(
      s.volumes.map((v) => ({ host: v.host, container: v.container, readOnly: v.read_only })),
    );
    const kvRows = (items: { key: string; value: string }[]) =>
      items.map((kv) => ({ key: kv.key, value: kv.value }));
    setEnv(kvRows(s.env));
    setLabels(kvRows(s.labels));
    setRestart(s.restart_policy ?? "no");
    setCommand(s.command ?? "");
    setWorkdir(s.workdir ?? "");
    setNetwork(s.network ?? "");
    setHostname(s.hostname ?? "");
    if (s.memory_mb && s.memory_mb > 0) {
      if (s.memory_mb % 1024 === 0 && s.memory_mb >= 1024) {
        setMemUnit("GB");
        setMemLimit(String(s.memory_mb / 1024));
      } else {
        setMemUnit("MB");
        setMemLimit(String(s.memory_mb));
      }
    } else {
      setMemLimit("");
      setMemUnit("MB");
    }
    setCpuLimit(s.cpus && s.cpus > 0 ? String(s.cpus) : "");
    setAutoRemove(s.auto_remove);
    setPrivileged(s.privileged);
    setTty(s.tty);
    setStdin(s.open_stdin);
  };

  // 每次打开重置；克隆入口全量回填、镜像页入口仅预填镜像
  useEffect(() => {
    if (open) {
      setPullStatus(null);
      setSubmitting(false);
      setImportOpen(false);
      setImportCmd("");
      if (initialSpec) {
        applySpec(initialSpec);
        return;
      }
      setImage(initialImage);
      setName("");
      setPorts([]);
      setVolumes([]);
      setEnv([]);
      setLabels([]);
      setRestart("no");
      setCommand("");
      setWorkdir("");
      setNetwork("");
      setHostname("");
      setMemLimit("");
      setMemUnit("MB");
      setCpuLimit("");
      setAutoRemove(false);
      setPrivileged(false);
      setTty(false);
      setStdin(false);
    }
    // applySpec 为组件内纯状态setter组合，不依赖外部可变量
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialImage, initialSpec]);

  /** 解析粘贴的 docker run 命令并回填 */
  const runImport = async () => {
    const cmd = importCmd.trim();
    if (!cmd) {
      toast.error(t("cc.pasteFirst"));
      return;
    }
    setImporting(true);
    try {
      const spec = await api.parseDockerRun(cmd);
      applySpec(spec);
      setImportOpen(false);
      setImportCmd("");
      toast.success(t("cc.imported"));
    } catch (e) {
      toast.error(t("cc.parseFailed", { err: e instanceof Error ? e.message : String(e) }));
    } finally {
      setImporting(false);
    }
  };

  const images = useQuery({
    queryKey: ["images"],
    queryFn: api.listImages,
    enabled: open,
  });
  const networks = useQuery({
    queryKey: ["networks"],
    queryFn: api.listNetworks,
    enabled: open,
    staleTime: 60_000,
  });

  /** 本地是否已有该镜像（无 tag 时按 repo 前缀匹配，模拟 docker 的 latest 解析） */
  const hasLocal = (img: string) => {
    const list = images.data ?? [];
    if (img.includes(":")) return list.some((i) => i.tags.includes(img));
    return list.some((i) => i.tags.some((t) => t === img || t.startsWith(`${img}:`)));
  };
  const imageMissing = image.trim() !== "" && images.data !== undefined && !hasLocal(image.trim());

  const close = () => {
    if (submitting) return;
    cancelPullRef.current?.();
    cancelPullRef.current = null;
    onClose();
  };

  const submit = async () => {
    const img = image.trim();
    if (!img) {
      toast.error(t("cc.imageRequired"));
      return;
    }
    if (autoRemove && restart !== "no") {
      toast.error(t("cc.autoRemoveConflict"));
      return;
    }
    // 资源限制：空 = 不限制
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
    // 行校验：全空行忽略，半填行报错
    const portRows = ports.filter((r) => r.host !== "" || r.container !== "");
    if (portRows.some((r) => r.host === "" || r.container === "")) {
      toast.error(t("cc.portRowsIncomplete"));
      return;
    }
    const badPort = portRows.some((r) => {
      const h = Number(r.host);
      const c = Number(r.container);
      return !Number.isInteger(h) || h < 1 || h > 65535 || !Number.isInteger(c) || c < 1 || c > 65535;
    });
    if (badPort) {
      toast.error(t("cc.portRange"));
      return;
    }
    const volumeRows = volumes.filter((r) => r.host.trim() !== "" || r.container.trim() !== "");
    if (volumeRows.some((r) => r.host.trim() === "" || r.container.trim() === "")) {
      toast.error(t("cc.volumeRowsIncomplete"));
      return;
    }
    const kv = (rows: KVRow[]) =>
      rows.filter((r) => r.key.trim() !== "").map((r) => ({ key: r.key.trim(), value: r.value }));

    const portSpecs: PortMappingSpec[] = portRows.map((r) => ({
      host: Number(r.host),
      container: Number(r.container),
      proto: r.proto,
    }));
    const volumeSpecs: VolumeMountSpec[] = volumeRows.map((r) => ({
      host: r.host.trim(),
      container: r.container.trim(),
      read_only: r.readOnly,
    }));
    const spec: ContainerSpec = {
      name: name.trim() || null,
      image: img,
      ports: portSpecs,
      volumes: volumeSpecs,
      env: kv(env),
      labels: kv(labels),
      restart_policy: restart === "no" ? null : restart,
      command: command.trim() || null,
      workdir: workdir.trim() || null,
      network: network.trim() || null,
      hostname: hostname.trim() || null,
      memory_mb,
      cpus,
      auto_remove: autoRemove,
      privileged,
      tty,
      open_stdin: stdin,
    };

    setSubmitting(true);
    try {
      // 与 Docker Desktop 一致：镜像不在本地时先拉取再运行
      if (imageMissing) {
        setPullStatus(t("cc.pulling", { image: img }));
        await new Promise<void>((resolve, reject) => {
          cancelPullRef.current = api.pullImage(img, (p) => {
            if (p.error) {
              reject(new Error(p.error));
              return;
            }
            if (p.done) {
              resolve();
              return;
            }
            const text = [p.id, p.status, p.progress].filter(Boolean).join(" ");
            if (text) setPullStatus(text);
          });
        });
        setPullStatus(null);
        cancelPullRef.current = null;
      }
      const newId = await api.createContainer(spec);
      // docker start 为异步语义：稍等复查，启动即失败时给出真实结论而非假成功
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const h = await api.containerHealth(newId);
        if (h.state === "exited" || h.state === "dead") {
          toast.warning(
            h.oom_killed
              ? t("cc.createdThenOOM")
              : t("cc.createdThenExited", { code: h.exit_code }),
            { duration: 10000 },
          );
        } else if (h.state === "restarting") {
          toast.warning(t("cc.restartLoop"), {
            duration: 10000,
          });
        } else {
          toast.success(t("cc.createdAndStarted"));
        }
      } catch {
        toast.success(t("cc.createdAndStarted"));
      }
      void qc.invalidateQueries({ queryKey: ["containers"] });
      void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
      onClose();
    } catch (e) {
      toast.error(t("cc.createFailed", { err: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSubmitting(false);
      setPullStatus(null);
    }
  };

  const inputCls = "w-full font-mono text-[12px]";
  const addBtn = (label: string, onClick: () => void) => (
    <Button variant="ghost" className="h-7 px-2 text-[12px]" onClick={onClick}>
      <Plus size={13} />
      {label}
    </Button>
  );
  const delBtn = (onClick: () => void) => (
    <IconButton
      title={t("cc.removeRow")}
      onClick={onClick}
      className="hover:bg-err/10 hover:text-err"
    >
      <Trash2 size={13} />
    </IconButton>
  );
  const patch = <T,>(rows: T[], i: number, part: Partial<T>) =>
    rows.map((r, j) => (j === i ? { ...r, ...part } : r));

  return (
    <Modal
      open={open}
      title={t("cc.title")}
      onClose={close}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={submitting || image.trim() === ""}
            onClick={() => void submit()}
          >
            {submitting ? t("cc.creating") : t("cc.createAndStart")}
          </Button>
        </>
      }
    >
      <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1">
        <Section title={t("cc.basics")}>
          <div className="grid grid-cols-[1.6fr_1fr] gap-2">
            <div>
              <Input
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder={t("cc.imagePlaceholder")}
                disabled={submitting}
                list="docker-local-images"
                className={inputCls}
              />
              <datalist id="docker-local-images">
                {(images.data ?? []).flatMap((i) => i.tags.slice(0, 3)).map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              {imageMissing && (
                <p className="mt-1 text-[11px] text-warn">{t("cc.imageMissingHint")}</p>
              )}
            </div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("cc.namePlaceholder")}
              disabled={submitting}
              className={inputCls}
            />
          </div>
          {importOpen ? (
            <div className="mt-2 space-y-1.5">
              <textarea
                value={importCmd}
                onChange={(e) => setImportCmd(e.target.value)}
                placeholder={t("cc.pastePlaceholder")}
                rows={3}
                disabled={importing}
                data-no-drag
                className="w-full rounded-ctl border border-edge-strong bg-panel px-2.5 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/25"
              />
              <div className="flex items-center gap-2">
                <Button variant="primary" className="h-7 px-2 text-[12px]" disabled={importing} onClick={() => void runImport()}>
                  {importing ? t("cc.parsing") : t("cc.parseAndFill")}
                </Button>
                <Button variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => setImportOpen(false)}>
                  {t("cc.collapse")}
                </Button>
                <span className="text-[11px] text-fg3">{t("cc.supportedFlags")}</span>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-no-drag
              onClick={() => setImportOpen(true)}
              className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-fg3 transition-colors hover:text-accent"
            >
              <ClipboardPaste size={12} />
              {t("cc.importFromRun")}
            </button>
          )}
        </Section>

        <Section title={t("cc.portsSection", { n: ports.length })}>
          <div className="space-y-1.5">
            {ports.map((r, i) => (
              <div key={i} className={`${row} grid-cols-[1fr_1fr_76px_28px]`}>
                <Input
                  value={r.host}
                  onChange={(e) => setPorts(patch(ports, i, { host: e.target.value }))}
                  placeholder={t("cc.hostPort")}
                  type="number"
                  min={1}
                  max={65535}
                  disabled={submitting}
                  className={inputCls}
                />
                <Input
                  value={r.container}
                  onChange={(e) => setPorts(patch(ports, i, { container: e.target.value }))}
                  placeholder={t("cc.containerPort")}
                  type="number"
                  min={1}
                  max={65535}
                  disabled={submitting}
                  className={inputCls}
                />
                <Select
                  value={r.proto}
                  onChange={(e) =>
                    setPorts(patch(ports, i, { proto: e.target.value as "tcp" | "udp" }))
                  }
                  disabled={submitting}
                  className="text-[12px]"
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </Select>
                {delBtn(() => setPorts(ports.filter((_, j) => j !== i)))}
              </div>
            ))}
            {addBtn(t("cc.addPort"), () =>
              setPorts([...ports, { host: "", container: "", proto: "tcp" }]),
            )}
          </div>
        </Section>

        <Section title={t("cc.volumesSection", { n: volumes.length })}>
          <div className="space-y-1.5">
            {volumes.map((r, i) => (
              <div key={i} className={`${row} grid-cols-[1.3fr_1fr_auto_28px]`}>
                <Input
                  value={r.host}
                  onChange={(e) => setVolumes(patch(volumes, i, { host: e.target.value }))}
                  placeholder={t("cc.hostPath")}
                  disabled={submitting}
                  className={inputCls}
                />
                <Input
                  value={r.container}
                  onChange={(e) => setVolumes(patch(volumes, i, { container: e.target.value }))}
                  placeholder={t("cc.containerPath")}
                  disabled={submitting}
                  className={inputCls}
                />
                <Checkbox
                  label={t("cc.readonly")}
                  checked={r.readOnly}
                  onChange={(v) => setVolumes(patch(volumes, i, { readOnly: v }))}
                />
                {delBtn(() => setVolumes(volumes.filter((_, j) => j !== i)))}
              </div>
            ))}
            {addBtn(t("cc.addVolume"), () =>
              setVolumes([...volumes, { host: "", container: "", readOnly: false }]),
            )}
          </div>
        </Section>

        <Section title={t("cc.envSection", { n: env.length })}>
          <div className="space-y-1.5">
            {env.map((r, i) => (
              <div key={i} className={`${row} grid-cols-[1fr_1.2fr_28px]`}>
                <Input
                  value={r.key}
                  onChange={(e) => setEnv(patch(env, i, { key: e.target.value }))}
                  placeholder="KEY"
                  disabled={submitting}
                  className={inputCls}
                />
                <Input
                  value={r.value}
                  onChange={(e) => setEnv(patch(env, i, { value: e.target.value }))}
                  placeholder="value"
                  disabled={submitting}
                  className={inputCls}
                />
                {delBtn(() => setEnv(env.filter((_, j) => j !== i)))}
              </div>
            ))}
            {addBtn(t("cc.addEnv"), () => setEnv([...env, { key: "", value: "" }]))}
          </div>
        </Section>

        <details className="rounded-ctl border border-edge bg-panel2/40 px-3 py-2">
          <summary className="cursor-pointer select-none text-[12px] font-medium text-fg2">
            {t("cc.advanced")}
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-[1.3fr_1fr] gap-2">
              <div className="flex gap-1.5">
                <Input
                  value={memLimit}
                  onChange={(e) => setMemLimit(e.target.value)}
                  placeholder={t("cc.memLimitPlaceholder")}
                  type="number"
                  min={4}
                  disabled={submitting}
                  className={inputCls}
                />
                <Select
                  value={memUnit}
                  onChange={(e) => setMemUnit(e.target.value as "MB" | "GB")}
                  disabled={submitting}
                  className="w-20 shrink-0 text-[12px]"
                  title={t("cc.memUnit")}
                >
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </Select>
              </div>
              <Input
                value={cpuLimit}
                onChange={(e) => setCpuLimit(e.target.value)}
                placeholder={t("cc.cpusPlaceholder")}
                type="number"
                step="0.1"
                min={0.1}
                disabled={submitting}
                className={inputCls}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={t('cc.cmdPlaceholder')}
                disabled={submitting}
                className={inputCls}
              />
              <Input
                value={workdir}
                onChange={(e) => setWorkdir(e.target.value)}
                placeholder={t("cc.workdirPlaceholder")}
                disabled={submitting}
                className={inputCls}
              />
              <Select
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
                disabled={submitting}
                className="text-[12px]"
                title={t("cc.networkTitle")}
              >
                <option value="">{t("cc.networkDefault")}</option>
                {(networks.data ?? []).map((n) => (
                  <option key={n.id} value={n.name}>
                    {n.name}（{n.driver}）
                  </option>
                ))}
              </Select>
              <Input
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder={t("cc.hostnamePlaceholder")}
                disabled={submitting}
                className={inputCls}
              />
            </div>

            <div>
              <div className="mb-1.5 text-[12px] font-medium text-fg2">
                {t("cc.labelsSection", { n: labels.length })}
              </div>
              <div className="space-y-1.5">
                {labels.map((r, i) => (
                  <div key={i} className={`${row} grid-cols-[1fr_1.2fr_28px]`}>
                    <Input
                      value={r.key}
                      onChange={(e) => setLabels(patch(labels, i, { key: e.target.value }))}
                      placeholder="key"
                      disabled={submitting}
                      className={inputCls}
                    />
                    <Input
                      value={r.value}
                      onChange={(e) => setLabels(patch(labels, i, { value: e.target.value }))}
                      placeholder="value"
                      disabled={submitting}
                      className={inputCls}
                    />
                    {delBtn(() => setLabels(labels.filter((_, j) => j !== i)))}
                  </div>
                ))}
                {addBtn(t("cc.addLabel"), () => setLabels([...labels, { key: "", value: "" }]))}
              </div>
            </div>

            <div className="grid grid-cols-[1fr_1.2fr] items-center gap-2">
              <Select
                value={restart}
                onChange={(e) => setRestart(e.target.value)}
                disabled={submitting || autoRemove}
                className="text-[12px]"
                title={autoRemove ? t("cc.autoRemovePolicyHint") : t("uc.restartPolicy")}
              >
                {RESTART_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.labelKey)}
                  </option>
                ))}
              </Select>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Checkbox
                  label={t("cc.autoRemove")}
                  checked={autoRemove}
                  onChange={(v) => {
                    setAutoRemove(v);
                    if (v) setRestart("no");
                  }}
                />
                <Checkbox label={t("cc.privileged")} checked={privileged} onChange={setPrivileged} />
                <Checkbox label="TTY" checked={tty} onChange={setTty} />
                <Checkbox label={t("cc.stdin")} checked={stdin} onChange={setStdin} />
              </div>
            </div>
          </div>
        </details>

        {pullStatus && (
          <div className="break-all rounded-ctl border border-edge bg-panel2 px-2.5 py-1.5 font-mono text-[11px] text-fg2">
            {pullStatus}
          </div>
        )}
      </div>
    </Modal>
  );
}
