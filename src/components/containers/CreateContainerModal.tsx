import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import type { ContainerSpec, PortMappingSpec, VolumeMountSpec } from "../../types/docker";
import { Button, Checkbox, IconButton, Input, Modal, Select } from "../ui";

/** 表单行状态：字符串态，提交时统一校验转换 */
type PortRow = { host: string; container: string; proto: "tcp" | "udp" };
type VolumeRow = { host: string; container: string; readOnly: boolean };
type KVRow = { key: string; value: string };

const RESTART_OPTIONS = [
  { value: "no", label: "不重启" },
  { value: "always", label: "始终重启（always）" },
  { value: "unless-stopped", label: "除非手动停止（unless-stopped）" },
  { value: "on-failure", label: "失败时重启（on-failure）" },
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
      toast.error("请先粘贴 docker run 命令");
      return;
    }
    setImporting(true);
    try {
      const spec = await api.parseDockerRun(cmd);
      applySpec(spec);
      setImportOpen(false);
      setImportCmd("");
      toast.success("已导入命令参数，请确认后创建");
    } catch (e) {
      toast.error(`解析失败: ${e instanceof Error ? e.message : e}`);
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
      toast.error("请填写镜像名");
      return;
    }
    if (autoRemove && restart !== "no") {
      toast.error("自动移除与重启策略不能同时启用");
      return;
    }
    // 资源限制：空 = 不限制
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
    // 行校验：全空行忽略，半填行报错
    const portRows = ports.filter((r) => r.host !== "" || r.container !== "");
    if (portRows.some((r) => r.host === "" || r.container === "")) {
      toast.error("端口映射存在未填写完整的行");
      return;
    }
    const badPort = portRows.some((r) => {
      const h = Number(r.host);
      const c = Number(r.container);
      return !Number.isInteger(h) || h < 1 || h > 65535 || !Number.isInteger(c) || c < 1 || c > 65535;
    });
    if (badPort) {
      toast.error("端口必须是 1-65535 的数字");
      return;
    }
    const volumeRows = volumes.filter((r) => r.host.trim() !== "" || r.container.trim() !== "");
    if (volumeRows.some((r) => r.host.trim() === "" || r.container.trim() === "")) {
      toast.error("卷挂载存在未填写完整的行");
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
        setPullStatus(`本地没有 ${img}，正在拉取…`);
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
              ? "容器已创建但随即因内存不足（OOM）退出，请查看容器日志与资源限制"
              : `容器已创建但随即退出（退出码 ${h.exit_code}），请到容器详情查看日志排查`,
            { duration: 10000 },
          );
        } else if (h.state === "restarting") {
          toast.warning("容器已创建但陷入重启循环（启动即失败），建议停止后排查配置", {
            duration: 10000,
          });
        } else {
          toast.success("容器已创建并启动");
        }
      } catch {
        toast.success("容器已创建并启动");
      }
      void qc.invalidateQueries({ queryKey: ["containers"] });
      void qc.invalidateQueries({ queryKey: ["dockerInfo"] });
      onClose();
    } catch (e) {
      toast.error(`创建容器失败: ${e instanceof Error ? e.message : e}`);
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
    <IconButton title="移除此行" onClick={onClick} className="hover:bg-err/10 hover:text-err">
      <Trash2 size={13} />
    </IconButton>
  );
  const patch = <T,>(rows: T[], i: number, part: Partial<T>) =>
    rows.map((r, j) => (j === i ? { ...r, ...part } : r));

  return (
    <Modal
      open={open}
      title="创建并运行容器"
      onClose={close}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={submitting || image.trim() === ""}
            onClick={() => void submit()}
          >
            {submitting ? "创建中…" : "创建并启动"}
          </Button>
        </>
      }
    >
      <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1">
        <Section title="基础">
          <div className="grid grid-cols-[1.6fr_1fr] gap-2">
            <div>
              <Input
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="镜像，如 nginx:latest"
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
                <p className="mt-1 text-[11px] text-warn">该镜像不在本地，提交时将自动拉取</p>
              )}
            </div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="容器名（可选，留空自动生成）"
              disabled={submitting}
              className={inputCls}
            />
          </div>
          {importOpen ? (
            <div className="mt-2 space-y-1.5">
              <textarea
                value={importCmd}
                onChange={(e) => setImportCmd(e.target.value)}
                placeholder="粘贴完整命令，如：docker run -d -p 8080:80 --name web nginx:latest"
                rows={3}
                disabled={importing}
                data-no-drag
                className="w-full rounded-ctl border border-edge-strong bg-panel px-2.5 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/25"
              />
              <div className="flex items-center gap-2">
                <Button variant="primary" className="h-7 px-2 text-[12px]" disabled={importing} onClick={() => void runImport()}>
                  {importing ? "解析中…" : "解析并填充"}
                </Button>
                <Button variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => setImportOpen(false)}>
                  收起
                </Button>
                <span className="text-[11px] text-fg3">支持 -p/-v/-e/-l/--name/--restart/--memory/--cpus 等常用选项</span>
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
              从 docker run 命令导入
            </button>
          )}
        </Section>

        <Section title={`端口映射（${ports.length}）`}>
          <div className="space-y-1.5">
            {ports.map((r, i) => (
              <div key={i} className={`${row} grid-cols-[1fr_1fr_76px_28px]`}>
                <Input
                  value={r.host}
                  onChange={(e) => setPorts(patch(ports, i, { host: e.target.value }))}
                  placeholder="宿主机端口"
                  type="number"
                  min={1}
                  max={65535}
                  disabled={submitting}
                  className={inputCls}
                />
                <Input
                  value={r.container}
                  onChange={(e) => setPorts(patch(ports, i, { container: e.target.value }))}
                  placeholder="容器端口"
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
            {addBtn("添加端口映射", () =>
              setPorts([...ports, { host: "", container: "", proto: "tcp" }]),
            )}
          </div>
        </Section>

        <Section title={`卷挂载（${volumes.length}）`}>
          <div className="space-y-1.5">
            {volumes.map((r, i) => (
              <div key={i} className={`${row} grid-cols-[1.3fr_1fr_auto_28px]`}>
                <Input
                  value={r.host}
                  onChange={(e) => setVolumes(patch(volumes, i, { host: e.target.value }))}
                  placeholder="宿主路径，如 /srv/data"
                  disabled={submitting}
                  className={inputCls}
                />
                <Input
                  value={r.container}
                  onChange={(e) => setVolumes(patch(volumes, i, { container: e.target.value }))}
                  placeholder="容器路径，如 /var/www"
                  disabled={submitting}
                  className={inputCls}
                />
                <Checkbox
                  label="只读"
                  checked={r.readOnly}
                  onChange={(v) => setVolumes(patch(volumes, i, { readOnly: v }))}
                />
                {delBtn(() => setVolumes(volumes.filter((_, j) => j !== i)))}
              </div>
            ))}
            {addBtn("添加卷挂载", () =>
              setVolumes([...volumes, { host: "", container: "", readOnly: false }]),
            )}
          </div>
        </Section>

        <Section title={`环境变量（${env.length}）`}>
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
            {addBtn("添加环境变量", () => setEnv([...env, { key: "", value: "" }]))}
          </div>
        </Section>

        <details className="rounded-ctl border border-edge bg-panel2/40 px-3 py-2">
          <summary className="cursor-pointer select-none text-[12px] font-medium text-fg2">
            高级选项
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-[1.3fr_1fr] gap-2">
              <div className="flex gap-1.5">
                <Input
                  value={memLimit}
                  onChange={(e) => setMemLimit(e.target.value)}
                  placeholder="内存上限（可选）"
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
                  title="内存单位"
                >
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </Select>
              </div>
              <Input
                value={cpuLimit}
                onChange={(e) => setCpuLimit(e.target.value)}
                placeholder="CPU 核数（可选），如 1.5"
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
                placeholder='命令覆盖（可选），如 sh -c "sleep 5"'
                disabled={submitting}
                className={inputCls}
              />
              <Input
                value={workdir}
                onChange={(e) => setWorkdir(e.target.value)}
                placeholder="工作目录（可选），如 /app"
                disabled={submitting}
                className={inputCls}
              />
              <Select
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
                disabled={submitting}
                className="text-[12px]"
                title="容器接入的网络"
              >
                <option value="">网络（默认 bridge）</option>
                {(networks.data ?? []).map((n) => (
                  <option key={n.id} value={n.name}>
                    {n.name}（{n.driver}）
                  </option>
                ))}
              </Select>
              <Input
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder="主机名（可选）"
                disabled={submitting}
                className={inputCls}
              />
            </div>

            <div>
              <div className="mb-1.5 text-[12px] font-medium text-fg2">
                标签（{labels.length}）
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
                {addBtn("添加标签", () => setLabels([...labels, { key: "", value: "" }]))}
              </div>
            </div>

            <div className="grid grid-cols-[1fr_1.2fr] items-center gap-2">
              <Select
                value={restart}
                onChange={(e) => setRestart(e.target.value)}
                disabled={submitting || autoRemove}
                className="text-[12px]"
                title={autoRemove ? "自动移除模式下不可配置重启策略" : "重启策略"}
              >
                {RESTART_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Checkbox
                  label="自动移除"
                  checked={autoRemove}
                  onChange={(v) => {
                    setAutoRemove(v);
                    if (v) setRestart("no");
                  }}
                />
                <Checkbox label="特权模式" checked={privileged} onChange={setPrivileged} />
                <Checkbox label="TTY" checked={tty} onChange={setTty} />
                <Checkbox label="保持标准输入" checked={stdin} onChange={setStdin} />
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
