import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Gauge, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { activeConnection, useSettings } from "../../lib/settings";
import type { DaemonValidationDto } from "../../types/daemon";
import { Badge, Button, Input, Modal, Spinner, Switch } from "../ui";

/** 内置预设加速源（可用性随时间变化，测速后自行取舍；也可在编辑器里直接增删任意源） */
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

/** 解析编辑器文本：合法且顶层为对象时返回该对象，否则 null */
function parseDraft(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function LatencyBadge({ v }: { v: Latency | undefined }) {
  if (v === undefined) return null;
  if (v === "testing") return <Spinner className="h-3 w-3" />;
  if (v === "fail") return <Badge tone="err">不可达</Badge>;
  return <Badge tone={v < 300 ? "ok" : v < 1000 ? "warn" : "neutral"}>{v} ms</Badge>;
}

/** 设置页 · 镜像加速分组：Docker Desktop 式直接编辑 /etc/docker/daemon.json（pkexec 提权写入）、校验、测速、回退命令 */
export function MirrorSettings() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const cfg = useQuery({
    queryKey: ["daemonConfig"],
    queryFn: api.readDaemonConfig,
    retry: false,
  });

  // 编辑器草稿 = daemon.json 原文，是唯一事实来源；null 表示尚未从后端加载
  const [draft, setDraft] = useState<string | null>(null);
  const [latency, setLatency] = useState<Record<string, Latency>>({});
  const [testing, setTesting] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [fallbackCmd, setFallbackCmd] = useState<string | null>(null);
  const [newCustom, setNewCustom] = useState("");
  const [validation, setValidation] = useState<DaemonValidationDto | null>(null);
  const [validating, setValidating] = useState(false);
  const validateSeq = useRef(0);

  // 首次加载后以磁盘原文初始化草稿；之后 invalidate 不得覆盖用户正在编辑的内容
  useEffect(() => {
    if (cfg.data && draft === null) {
      setDraft(cfg.data.exists ? cfg.data.raw : "{}\n");
    }
  }, [cfg.data, draft]);

  // 即时语法检查（与后端一致的严格 JSON + 顶层对象约束）
  const syntaxError = useMemo(() => {
    if (draft === null) return null;
    const obj = parseDraft(draft);
    if (obj) return null;
    try {
      JSON.parse(draft);
      return "顶层必须是 JSON 对象（{...}）";
    } catch (e) {
      return e instanceof Error ? e.message.replace(/^SyntaxError: /, "") : String(e);
    }
  }, [draft]);

  // 草稿中的加速源；语法错误或 registry-mirrors 类型异常时为 null（快捷开关随之禁用）
  const draftMirrors = useMemo(() => {
    const obj = syntaxError ? null : parseDraft(draft ?? "");
    const m = obj?.["registry-mirrors"];
    return Array.isArray(m) && m.every((x) => typeof x === "string") ? (m as string[]) : null;
  }, [draft, syntaxError]);

  // 防抖调用后端权威校验（语义 + dockerd 深度校验）；seq 防止乱序返回覆盖新结果
  useEffect(() => {
    if (draft === null || syntaxError) {
      setValidation(null);
      return;
    }
    const seq = ++validateSeq.current;
    const timer = setTimeout(() => {
      setValidating(true);
      api
        .validateDaemonJson(draft)
        .then((v) => {
          if (seq === validateSeq.current) setValidation(v);
        })
        .catch(() => {
          if (seq === validateSeq.current) setValidation(null);
        })
        .finally(() => {
          if (seq === validateSeq.current) setValidating(false);
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, syntaxError]);

  const apply = useMutation({
    mutationFn: async (restart: boolean) => {
      await api.writeDaemonJson(draft ?? "");
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
        .generateDaemonCommand(draft ?? "")
        .then(setFallbackCmd)
        .catch(() => {});
      toast.error(msg);
    },
  });

  const restartPending = apply.isPending && apply.variables === true;

  // 当前文件里有、编辑器里没有的键：整体替换后会丢失，弹窗中明确提醒
  const missingKeys = useMemo(() => {
    const obj = parseDraft(draft ?? "");
    if (!cfg.data || !obj) return [];
    return cfg.data.other_keys.filter((k) => !(k in obj));
  }, [cfg.data, draft]);

  const showValidation =
    syntaxError != null ||
    validating ||
    (validation?.errors.length ?? 0) > 0 ||
    (validation?.warnings.length ?? 0) > 0;

  if (!settings) return null;
  const remote = activeConnection(settings).kind !== "local";

  const dirty = cfg.data != null && draft !== null && draft.trim() !== cfg.data.raw.trim();
  const canApply = dirty && !syntaxError && !validation?.errors.length && !apply.isPending;

  const setMirrors = (next: string[]) => {
    const obj = parseDraft(draft ?? "");
    if (!obj) return;
    if (next.length > 0) obj["registry-mirrors"] = next;
    else delete obj["registry-mirrors"];
    setDraft(JSON.stringify(obj, null, 2) + "\n");
  };

  const togglePreset = (url: string) => {
    if (!draftMirrors) return;
    setMirrors(
      draftMirrors.includes(url) ? draftMirrors.filter((x) => x !== url) : [...draftMirrors, url],
    );
  };

  const addCustom = () => {
    const url = normalize(newCustom);
    if (!url) return;
    if (draftMirrors?.includes(url) || PRESETS.some((p) => p.url === url)) {
      toast.info("该加速源已在列表中");
      return;
    }
    if (!draftMirrors) {
      toast.error("daemon.json 内容有误，请先修正后再添加");
      return;
    }
    setMirrors([...draftMirrors, url]);
    setNewCustom("");
  };

  const testAll = async () => {
    if (testing) return;
    setTesting(true);
    const candidates = [...new Set([...PRESETS.map((p) => p.url), ...(draftMirrors ?? [])])];
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

  const row = (url: string, name: string, note?: string) => (
    <div
      key={url}
      className="group flex items-center gap-2.5 px-4 py-2 transition-colors hover:bg-hover"
    >
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
      <Switch
        checked={draftMirrors?.includes(url) ?? false}
        disabled={!draftMirrors}
        onChange={() => togglePreset(url)}
      />
    </div>
  );

  return (
    <section className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
      <div className="flex items-center justify-between border-b border-edge/60 bg-panel2/40 px-4 py-2.5">
        <div className="text-[13px] font-semibold text-fg">镜像加速</div>
        {remote && <Badge tone="warn">当前为远程连接，此配置仅作用于本机 daemon</Badge>}
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

      {/* daemon.json 编辑器（整体编辑，应用时自动备份原文件） */}
      <div className="border-b border-edge/60 px-4 py-3">
        {draft === null ? (
          <div className="flex justify-center py-8">
            <Spinner className="h-5 w-5" />
          </div>
        ) : (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                  e.preventDefault();
                  if (canApply) setApplyOpen(true);
                }
              }}
              spellCheck={false}
              aria-label="编辑 /etc/docker/daemon.json"
              className="h-64 w-full resize-y rounded-ctl border border-edge-strong bg-canvas p-3 font-mono text-[11.5px] leading-5 text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/25"
            />
            {showValidation && (
              <div className="mt-2 space-y-1">
                {syntaxError ? (
                  <div className="text-[12px] text-err">✗ {syntaxError}</div>
                ) : (
                  <>
                    {validation?.errors.map((e) => (
                      <div key={e} className="text-[12px] text-err">
                        ✗ {e}
                      </div>
                    ))}
                    {validation?.warnings.map((w) => (
                      <div key={w} className="text-[12px] text-warn">
                        ⚠ {w}
                      </div>
                    ))}
                    {validating && (
                      <div className="flex items-center gap-1.5 text-[12px] text-fg3">
                        <Spinner className="h-3 w-3" />
                        校验中…
                      </div>
                    )}
                    {!validating && validation?.deep_checked && !validation.errors.length && (
                      <div className="text-[12px] text-ok">✓ dockerd 校验通过</div>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* 快捷开关：改写编辑器中的 registry-mirrors，语法有误时自动禁用 */}
      <div className="px-4 pt-2.5 pb-1 text-[12px] text-fg3">
        快捷开关（修改编辑器中的 registry-mirrors；内容有误时不可用）
      </div>
      <div className="divide-y divide-edge/60">
        {PRESETS.map((p) => row(p.url, p.name, p.note))}
        {(draftMirrors ?? [])
          .filter((u) => !PRESETS.some((p) => p.url === u))
          .map((u) => row(u, "自定义加速源"))}
      </div>

      {/* 添加自定义源：直接写入编辑器草稿，随 daemon.json 持久化 */}
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
          应用配置需管理员授权，写入前自动备份为 daemon.json.dockpilot.bak（Ctrl+S 快速应用）
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => void testAll()} disabled={testing}>
            {testing ? <Spinner className="h-3.5 w-3.5" /> : <Gauge size={14} />}
            测速
          </Button>
          <Button variant="primary" disabled={!canApply} onClick={() => setApplyOpen(true)}>
            应用配置
          </Button>
        </div>
      </div>

      {/* 应用确认 */}
      <Modal
        open={applyOpen}
        title="应用 daemon.json"
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
          将用编辑器内容<span className="font-semibold text-fg">整体替换</span>{" "}
          <span className="font-mono">/etc/docker/daemon.json</span>，原文件自动备份为{" "}
          <span className="font-mono">daemon.json.dockpilot.bak</span>。
        </p>
        {draftMirrors && (
          <div className="mt-2">
            <div className="text-[12px] text-fg2">加速源（{draftMirrors.length} 个）：</div>
            <div className="mt-1 max-h-28 overflow-auto rounded-ctl border border-edge bg-panel2 p-2 font-mono text-[11px] leading-4 text-fg2">
              {draftMirrors.length === 0 ? (
                <div className="text-fg3">（无 — 恢复直连 Docker Hub）</div>
              ) : (
                draftMirrors.map((m) => <div key={m}>{m}</div>)
              )}
            </div>
          </div>
        )}
        {missingKeys.length > 0 && (
          <p className="mt-2 text-[12px] text-warn">
            ⚠ 当前文件中的 {missingKeys.join("、")} 未出现在编辑器内容里，应用后将被移除。
          </p>
        )}
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
          应用内写入失败，可复制以下命令到终端手动执行（先写临时文件并经 dockerd 校验，通过后才替换
          daemon.json 并重启）：
        </p>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-ctl border border-edge bg-panel2 p-2.5 font-mono text-[11px] leading-4 text-fg2">
          {fallbackCmd}
        </pre>
      </Modal>
    </section>
  );
}
