import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Gauge, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { useSettings, useUpdateSettings } from "../../lib/settings";
import { Badge, Button, IconButton, Input, Modal, Spinner } from "../ui";

/** 内置预设加速源（可用性随时间变化，测速后自行取舍；也可添加自定义源） */
const PRESETS: { url: string; name: string; note?: string }[] = [
  { url: "https://docker.m.daocloud.io", name: "DaoCloud 镜像站" },
  { url: "https://docker.1panel.live", name: "1Panel 镜像" },
  { url: "https://docker.1ms.run", name: "毫秒镜像" },
  { url: "https://dockerproxy.link", name: "Docker Proxy" },
  { url: "https://docker.nju.edu.cn", name: "南京大学", note: "教育网" },
  { url: "https://mirror.ccs.tencentyun.com", name: "腾讯云", note: "仅内网" },
];

type Latency = number | "testing" | "fail";

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function LatencyBadge({ v }: { v: Latency | undefined }) {
  if (v === undefined) return null;
  if (v === "testing") return <Spinner className="h-3 w-3" />;
  if (v === "fail") return <Badge tone="err">不可达</Badge>;
  return <Badge tone={v < 300 ? "ok" : v < 1000 ? "warn" : "neutral"}>{v} ms</Badge>;
}

/** 设置页 · 镜像加速分组：读写 /etc/docker/daemon.json（pkexec 提权）、测速、回退命令 */
export function MirrorSettings() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const cfg = useQuery({
    queryKey: ["daemonConfig"],
    queryFn: api.readDaemonConfig,
    retry: false,
  });

  const [draft, setDraft] = useState<string[]>([]);
  const [latency, setLatency] = useState<Record<string, Latency>>({});
  const [testing, setTesting] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [fallbackCmd, setFallbackCmd] = useState<string | null>(null);
  const [newCustom, setNewCustom] = useState("");
  const draftInit = useRef(false);

  // daemon.json 加载后以实际生效列表初始化草稿
  useEffect(() => {
    if (cfg.data && !draftInit.current) {
      draftInit.current = true;
      setDraft(cfg.data.registry_mirrors);
    }
  }, [cfg.data]);

  if (!settings) return null;
  const custom: string[] = settings.mirror_custom;

  const dirty =
    cfg.data != null && JSON.stringify(draft.map(normalize)) !== JSON.stringify(cfg.data.registry_mirrors.map(normalize));
  const candidates = [...PRESETS.map((p) => p.url), ...custom.filter((u) => !PRESETS.some((p) => p.url === u))];

  const toggle = (url: string) =>
    setDraft((d) => (d.includes(url) ? d.filter((x) => x !== url) : [...d, url]));

  const addCustom = () => {
    const url = normalize(newCustom);
    if (!url) return;
    if (custom.includes(url) || PRESETS.some((p) => p.url === url)) {
      toast.info("该加速源已在列表中");
      return;
    }
    updateSettings.mutate({ ...settings, mirror_custom: [...custom, url] });
    setDraft((d) => (d.includes(url) ? d : [...d, url]));
    setNewCustom("");
  };

  const removeCustom = (url: string) => {
    updateSettings.mutate({ ...settings, mirror_custom: custom.filter((u) => u !== url) });
    setDraft((d) => d.filter((u) => u !== url));
  };

  const testAll = async () => {
    if (testing) return;
    setTesting(true);
    setLatency(Object.fromEntries(candidates.map((u) => [u, "testing" as const])));
    await Promise.all(
      candidates.map(async (url) => {
        try {
          const ms = await api.testMirror(url);
          setLatency((p) => ({ ...p, [url]: ms }));
        } catch {
          setLatency((p) => ({ ...p, [url]: "fail" }));
        }
      }),
    );
    setTesting(false);
  };

  const invalidateAll = () => {
    for (const key of ["daemonConfig", "dockerInfo", "containers", "images"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const apply = useMutation({
    mutationFn: async (restart: boolean) => {
      await api.applyMirrors(draft);
      if (restart) await api.restartDocker();
    },
    onSuccess: (_d, restart) => {
      setApplyOpen(false);
      invalidateAll();
      toast.success(
        restart ? "配置已写入，Docker 已重启" : "配置已写入 daemon.json，重启 Docker 后生效",
      );
    },
    onError: (e, restart) => {
      const msg = String(e);
      if (restart) {
        // 写入成功但重启失败：配置已生效，提示手动重启即可
        toast.error(`${msg}（配置已写入，可稍后在终端执行 sudo systemctl restart docker）`);
        setApplyOpen(false);
        invalidateAll();
        return;
      }
      if (msg.includes("取消")) {
        toast.info(msg);
        setApplyOpen(false);
        return;
      }
      // 写入失败（无 polkit / 授权失败等）：给出手动命令
      void api
        .generateMirrorsCommand(draft)
        .then(setFallbackCmd)
        .catch(() => {});
      toast.error(msg);
    },
  });

  const restartPending = apply.isPending && apply.variables === true;

  const row = (url: string, name: string, note?: string, onRemove?: () => void) => (
    <div
      key={url}
      className="group flex items-center gap-2.5 px-4 py-2 transition-colors hover:bg-hover"
    >
      <input
        type="checkbox"
        checked={draft.includes(url)}
        onChange={() => toggle(url)}
        className="h-3.5 w-3.5 shrink-0 accent-accent"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] text-fg">
          {name}
          {note && <span className="text-[11px] text-fg3">（{note}）</span>}
        </div>
        <div className="truncate font-mono text-[11px] text-fg3" title={url}>
          {url}
        </div>
      </div>
      <LatencyBadge v={latency[url]} />
      {onRemove && (
        <IconButton
          title="删除"
          className="opacity-0 transition-opacity group-hover:opacity-100 hover:bg-err/10 hover:text-err"
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </IconButton>
      )}
    </div>
  );

  return (
    <section className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
      <div className="flex items-center justify-between border-b border-edge/60 bg-panel2/40 px-4 py-2.5">
        <div className="text-[13px] font-semibold text-fg">镜像加速</div>
        {cfg.data && (
          <div className="flex items-center gap-1.5">
            {cfg.data.live_restore ? (
              <Badge tone="ok">live-restore 已开启</Badge>
            ) : (
              <Badge tone="warn">live-restore 未开启</Badge>
            )}
            {!cfg.data.exists && <Badge tone="neutral">未找到 daemon.json</Badge>}
          </div>
        )}
      </div>

      {/* 当前生效的加速源 */}
      <div className="flex items-start gap-3 border-b border-edge/60 px-4 py-2.5">
        <div className="shrink-0 pt-0.5 text-[12px] text-fg3">当前生效</div>
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {cfg.isLoading ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : cfg.data && cfg.data.registry_mirrors.length > 0 ? (
            cfg.data.registry_mirrors.map((m) => (
              <Badge key={m} tone="accent">
                <span className="font-mono">{m}</span>
              </Badge>
            ))
          ) : (
            <span className="text-[12px] text-fg3">未配置加速源（直连 Docker Hub）</span>
          )}
        </div>
      </div>

      <div className="divide-y divide-edge/60">
        {PRESETS.map((p) => row(p.url, p.name, p.note))}
        {custom.map((u) => row(u, "自定义加速源", undefined, () => removeCustom(u)))}
      </div>

      {/* 添加自定义源 */}
      <div className="flex items-center gap-2 border-b border-edge/60 px-4 py-2.5">
        <Input
          value={newCustom}
          onChange={(e) => setNewCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCustom()}
          placeholder="添加自定义加速源，如 https://docker.example.com"
          className="h-7 flex-1 font-mono text-[12px]"
          spellCheck={false}
        />
        <Button variant="outline" className="h-7" disabled={!newCustom.trim()} onClick={addCustom}>
          <Plus size={13} />
          添加
        </Button>
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-[11px] text-fg3">
          应用配置需管理员授权，写入前自动备份为 daemon.json.dockpilot.bak
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => void testAll()} disabled={testing}>
            {testing ? <Spinner className="h-3.5 w-3.5" /> : <Gauge size={14} />}
            测速
          </Button>
          <Button variant="primary" disabled={!dirty || apply.isPending} onClick={() => setApplyOpen(true)}>
            应用配置
          </Button>
        </div>
      </div>

      {/* 应用确认 */}
      <Modal
        open={applyOpen}
        title="应用镜像加速配置"
        onClose={() => setApplyOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setApplyOpen(false)}>
              取消
            </Button>
            <Button variant="outline" disabled={apply.isPending} onClick={() => apply.mutate(false)}>
              仅写入配置
            </Button>
            <Button
              variant="primary"
              disabled={apply.isPending}
              onClick={() => apply.mutate(true)}
            >
              {restartPending ? <Spinner className="h-3.5 w-3.5" /> : null}
              写入并重启 Docker
            </Button>
          </>
        }
      >
        <p>
          将把以下 <span className="font-semibold text-fg">{draft.length}</span> 个加速源写入{" "}
          <span className="font-mono">/etc/docker/daemon.json</span>：
        </p>
        <div className="mt-2 max-h-28 overflow-auto rounded-ctl border border-edge bg-panel2 p-2 font-mono text-[11px] leading-4 text-fg2">
          {draft.length === 0 ? (
            <div className="text-fg3">（空 — 将移除 registry-mirrors 配置，恢复直连）</div>
          ) : (
            draft.map((m) => <div key={m}>{m}</div>)
          )}
        </div>
        {cfg.data && (
          <div className="mt-3 space-y-1 text-[12px] text-fg2">
            <p>
              重启 Docker 后生效。
              {cfg.data.live_restore
                ? "已开启 live-restore，重启不会中断运行中的容器。"
                : `当前有 ${
                    qc.getQueryData<{ running: number }>(["dockerInfo"])?.running ?? "?"
                  } 个运行中的容器，重启期间会短暂中断。`}
            </p>
            {cfg.data.other_keys.length > 0 && (
              <p>
                daemon.json 中的其他配置（{cfg.data.other_keys.join("、")}）将原样保留。
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* pkexec 不可用时的回退：复制手动命令 */}
      <Modal
        open={fallbackCmd !== null}
        title="改用终端命令执行"
        onClose={() => setFallbackCmd(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setFallbackCmd(null)}>
              关闭
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                const ok = await copyText(fallbackCmd ?? "");
                toast[ok ? "success" : "error"](ok ? "命令已复制到剪贴板" : "复制失败，请手动选择复制");
              }}
            >
              <Copy size={14} />
              复制命令
            </Button>
          </>
        }
      >
        <p className="mb-2">
          应用内写入失败，可复制以下命令到终端手动执行（配置内容已与现有 daemon.json 合并）：
        </p>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-ctl border border-edge bg-panel2 p-2.5 font-mono text-[11px] leading-4 text-fg2">
          {fallbackCmd}
        </pre>
      </Modal>
    </section>
  );
}
