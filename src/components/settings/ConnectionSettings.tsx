import { useQueryClient } from "@tanstack/react-query";
import {
  Gauge,
  House,
  KeyRound,
  Network,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { firstLine } from "../../lib/format";
import { useIsWindows } from "../../lib/platform";
import { useSettings, useSwitchConnection, useUpdateSettings } from "../../lib/settings";
import { parseHostKeyChange, type HostKeyChange } from "../../lib/ssh";
import {
  CONNECTION_AUTHS,
  CONNECTION_KINDS,
  connectionKindLabel,
  type ConnectionAuth,
  type ConnectionKind,
  type ConnectionProfile,
  type ConnectionTestResult,
} from "../../types/settings";
import { Badge, Button, IconButton, Input, Modal, SegmentedControl, Spinner } from "../ui";

/** 连接类型的图标与 Badge 色调（TCP 明文给警示色） */
const KIND_META: Record<ConnectionKind, { icon: typeof House; tone: "accent" | "ok" | "warn" | "neutral" }> = {
  local: { icon: House, tone: "neutral" },
  ssh: { icon: KeyRound, tone: "accent" },
  tls: { icon: ShieldCheck, tone: "ok" },
  tcp: { icon: Network, tone: "warn" },
};

type TestState =
  | { status: "testing" }
  | { status: "ok"; ms: number; version: string }
  | { status: "fail"; error: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : String(error);
  } catch {
    return String(error);
  }
}

function displayUrl(p: ConnectionProfile): string {
  switch (p.kind) {
    case "local":
      return `unix://${p.socket_path || "/var/run/docker.sock"}`;
    case "tcp":
      return `tcp://${p.host}`;
    case "tls":
      return `https://${p.host}`;
    case "ssh":
      return `ssh://${p.host}`;
    default:
      return p.host;
  }
}

/** 连接地址合法性：远程类型必须给出地址 */
function validateDraft(p: ConnectionProfile): string | null {
  if (!p.name.trim()) return "请填写连接名称";
  if (p.kind === "tcp" && !p.host.trim()) return "请填写主机地址";
  if (p.kind === "tls") {
    if (!p.host.trim()) return "请填写主机地址";
    if (!p.cert_path.trim()) return "请选择证书目录";
  }
  if (p.kind === "ssh") {
    if (!p.host.trim()) return "请填写 SSH 地址";
    if (!p.host.includes("@")) return "SSH 地址需为 user@host 形式（密码认证同样需要用户名）";
    if (p.auth !== "password" && p.key_path.trim().toLowerCase().endsWith(".pub")) {
      return "请选择私钥文件，不要选择 .pub 公钥文件（例如 id_rsa.pub）";
    }
  }
  return null;
}

/** 空白连接草稿（新增用） */
function emptyDraft(kind: ConnectionKind = "local"): ConnectionProfile {
  return {
    id: crypto.randomUUID(),
    name: "",
    kind,
    socket_path: "",
    host: "",
    cert_path: "",
    key_path: "",
    remote_socket: "",
    auth: "key",
    secret_backend: "",
  };
}

/** SSH 连接要求说明，按认证方式逐条列出。首次部署公钥的指引按平台给出：
 * Windows 的 OpenSSH 不带 ssh-copy-id，用 PowerShell 管道把公钥追加到远程（远程均为 Linux） */
function sshConnectionNotes(auth: ConnectionAuth | "", isWindows: boolean): string[] {
  if (auth === "password") {
    return [
      "密码仅保存在本机（系统钥匙串，无钥匙串环境回退加密文件），不会上传或同步",
      "SSH 地址需含用户名（user@host），远程用户需已加入 docker 组",
      "服务器若禁用密码认证（PasswordAuthentication no），请改用私钥",
      "数据经 SSH 加密隧道传输",
    ];
  }
  const deploy = isWindows
    ? '首次使用需先部署公钥（输入一次密码，无密钥先 ssh-keygen -t ed25519）：在 PowerShell 执行 type $env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh user@ip "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"'
    : "首次使用需先部署公钥（输入一次密码）：在终端执行 ssh-copy-id user@ip";
  return [
    "内置 SSH 引擎连接，无需本机安装 ssh 客户端；远程用户需已加入 docker 组",
    "支持显式私钥（含口令）、ssh-agent（Windows 版暂不支持 agent，请指定私钥路径）或默认私钥（~/.ssh/id_*）",
    `${deploy}，否则会报 Permission denied`,
    "数据经 SSH 加密隧道传输",
  ];
}

/** 设置页 · Docker 连接分组：多连接配置的增删改、连通性测试与切换 */
export function ConnectionSettings() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const switchConn = useSwitchConnection();
  // Windows 版不支持本地 Docker，隐藏「本地」连接类型
  const isWindows = useIsWindows();

  const [draft, setDraft] = useState<ConnectionProfile | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ConnectionProfile | null>(null);
  const [testing, setTesting] = useState<Record<string, TestState>>({});
  /** ssh 瞬态密码/口令（仅对话框内存，保存时经 set_ssh_secret 加密落盘） */
  const [draftPassword, setDraftPassword] = useState("");
  const [draftPassphrase, setDraftPassphrase] = useState("");
  /** 主机指纹变更确认（确认后自动重试触发它的动作） */
  const [hostKey, setHostKey] = useState<{ change: HostKeyChange; retry: () => Promise<void> } | null>(
    null,
  );

  if (!settings) return null;
  const connections = settings.connections;
  const activeId = settings.active_connection_id;

  const openDraft = (p: ConnectionProfile, isNewDraft: boolean) => {
    setDraft({ ...p });
    setIsNew(isNewDraft);
    setDraftPassword("");
    setDraftPassphrase("");
  };

  /** 持久化草稿的 ssh 瞬态密钥；空值跳过（保持原密钥） */
  const persistSshSecrets = async (p: ConnectionProfile) => {
    if (p.kind !== "ssh") return;
    if (p.auth === "password" && draftPassword) {
      await api.setSshSecret(p.id, "password", draftPassword);
    }
    if (p.auth !== "password" && draftPassphrase) {
      await api.setSshSecret(p.id, "key_passphrase", draftPassphrase);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    const err = validateDraft(draft);
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    // 先落盘配置；若编辑的是当前活跃连接，再让后端按新配置重建连接
    const exists = connections.some((c) => c.id === draft.id);
    const nextConnections = exists
      ? connections.map((c) => (c.id === draft.id ? draft : c))
      : [...connections, draft];
    try {
      await api.setSettings({ ...settings, connections: nextConnections });
      await persistSshSecrets(draft);
    } catch (e) {
      toast.error(`保存设置失败: ${e}`);
      setSaving(false);
      return;
    }
    setSaving(false);
    const wasActive = draft.id === activeId;
    setDraft(null);
    if (wasActive) {
      try {
        await api.switchConnection(draft.id);
        toast.success("连接配置已保存并重新连接");
      } catch (e) {
        const message = String(e);
        const change = parseHostKeyChange(message);
        if (change) {
          // 指纹变更：确认后重试切换
          setHostKey({ change, retry: async () => {
            try {
              await api.switchConnection(draft.id);
              toast.success("连接配置已保存并重新连接");
              void qc.invalidateQueries();
            } catch (err) {
              toast.error(`配置已保存，但按新配置连接失败，已保持原连接：${firstLine(String(err))}`);
            }
          } });
          return;
        }
        toast.error(`配置已保存，但按新配置连接失败，已保持原连接：${firstLine(message)}`);
      }
    } else {
      toast.success("连接配置已保存");
    }
    void qc.invalidateQueries();
  };

  /** 执行一次连通性测试；主机指纹变更时弹确认框并在确认后自动重试 */
  const runTest = async (p: ConnectionProfile, transient?: { password?: string; passphrase?: string }) => {
    setTesting((t) => ({ ...t, [p.id]: { status: "testing" } }));
    try {
      const r: ConnectionTestResult = await api.testConnection(
        p,
        transient?.password,
        transient?.passphrase,
      );
      if (!r.ok && p.kind === "ssh") {
        const change = parseHostKeyChange(r.error);
        if (change) {
          setHostKey({ change, retry: () => runTest(p) });
          setTesting((t) => ({ ...t, [p.id]: { status: "fail", error: "主机指纹已变更，等待确认" } }));
          return;
        }
      }
      setTesting((t) =>
        r.ok
          ? { ...t, [p.id]: { status: "ok", ms: r.latency_ms ?? 0, version: r.version } }
          : { ...t, [p.id]: { status: "fail", error: r.error || "连接失败" } },
      );
    } catch (e) {
      const message = errorMessage(e);
      setTesting((t) => ({ ...t, [p.id]: { status: "fail", error: message } }));
      throw e instanceof Error ? e : new Error(message);
    }
  };

  const testDraft = async () => {
    if (!draft || testing[draft.id]?.status === "testing") return;
    const err = validateDraft(draft);
    if (err) {
      setTesting((t) => ({ ...t, [draft.id]: { status: "fail", error: err } }));
      toast.error(err);
      return;
    }
    try {
      await runTest(draft, { password: draftPassword, passphrase: draftPassphrase });
    } catch {
      // 失败状态已写入 testing
    }
  };

  const testRow = async (p: ConnectionProfile) => {
    if (testing[p.id]?.status === "testing") return;
    try {
      await runTest(p);
    } catch (e) {
      toast.error(`测试「${p.name}」失败: ${firstLine(errorMessage(e))}`);
    }
  };

  const removeProfile = (p: ConnectionProfile) => {
    if (p.id === activeId) {
      toast.info("不能删除当前连接，请先切换到其他连接");
      return;
    }
    if (connections.length <= 1) {
      toast.info("至少保留一个连接配置");
      return;
    }
    update.mutate(
      { ...settings, connections: connections.filter((c) => c.id !== p.id) },
      { onSuccess: () => toast.success("连接配置已删除") },
    );
  };

  const pickCertDir = async () => {
    try {
      const dir = await open({ directory: true });
      if (typeof dir === "string" && draft) setDraft({ ...draft, cert_path: dir });
    } catch {
      // 非桌面环境（浏览器 mock）无文件对话框
    }
  };

  const pickKeyFile = async () => {
    try {
      const f = await open({
        multiple: false,
      });
      if (typeof f === "string" && draft) setDraft({ ...draft, key_path: f });
    } catch {
      // 非桌面环境（浏览器 mock）无文件对话框
    }
  };

  const draftTest = draft ? testing[draft.id] : undefined;

  return (
    <section className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
      <div className="flex items-center justify-between border-b border-edge/60 bg-panel2/40 px-4 py-2.5">
        <div className="text-[13px] font-semibold text-fg">Docker 连接</div>
        {connections.map((c) =>
          c.id === activeId ? (
            <span key="active" className="flex items-center gap-1.5 text-[11px] text-fg3">
              当前：
              <span className="max-w-40 truncate font-mono text-fg2">{c.name}</span>
            </span>
          ) : null,
        )}
      </div>

      <div className="divide-y divide-edge/60">
        {connections.map((c) => {
          const meta = KIND_META[c.kind] ?? KIND_META.local;
          const Icon = meta.icon;
          const t = testing[c.id];
          const isActive = c.id === activeId;
          return (
            <div
              key={c.id}
              title={isActive ? "当前连接" : "点击切换到此连接"}
              onClick={() => !isActive && switchConn.mutate(c.id)}
              className={`group flex items-center gap-2.5 px-4 py-2.5 transition-colors ${
                isActive ? "bg-accent/5" : "cursor-pointer hover:bg-hover"
              }`}
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
                {switchConn.isPending && switchConn.variables === c.id ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  <Icon size={14} />
                )}
              </div>
              <div data-no-drag className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] text-fg">
                  <span className="truncate">{c.name}</span>
                  {isActive && <Badge tone="accent">当前</Badge>}
                </div>
                <div className="truncate font-mono text-[11px] text-fg3" title={displayUrl(c)}>
                  {displayUrl(c)}
                </div>
              </div>
              <Badge tone={meta.tone}>{connectionKindLabel(c.kind)}</Badge>
              {t?.status === "testing" && <Spinner className="h-3.5 w-3.5" />}
              {t?.status === "ok" && (
                <Badge tone={t.ms < 300 ? "ok" : t.ms < 1000 ? "warn" : "neutral"}>
                  {t.ms} ms{t.version ? ` · ${t.version}` : ""}
                </Badge>
              )}
              {t?.status === "fail" && (
                <span title={t.error || "连接失败"}>
                  <Badge tone="err">不可达</Badge>
                </span>
              )}
              <div
                data-no-drag
                className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
              >
                <IconButton
                  title="测试连接"
                  onClick={(e) => {
                    e.stopPropagation();
                    void testRow(c);
                  }}
                >
                  <Gauge size={13} />
                </IconButton>
                <IconButton
                  title="编辑"
                  onClick={(e) => {
                    e.stopPropagation();
                    openDraft(c, false);
                  }}
                >
                  <Pencil size={13} />
                </IconButton>
                <IconButton
                  title={isActive ? "当前连接不可删除" : "删除"}
                  className={isActive ? "opacity-30" : "hover:bg-err/10 hover:text-err"}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(c);
                  }}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-[11px] text-fg3">
          点击列表项切换连接，切换后自动刷新数据；远程连接失败时可在列表重试或修改配置
        </span>
        <Button
          variant="outline"
          className="shrink-0"
          onClick={() => {
            openDraft(emptyDraft(isWindows ? "ssh" : "local"), true);
          }}
        >
          <Plus size={13} />
          添加连接
        </Button>
      </div>

      {/* 添加 / 编辑连接 */}
      <Modal
        open={draft !== null}
        title={isNew ? "添加连接" : "编辑连接"}
        onClose={() => setDraft(null)}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => void testDraft()} disabled={!draft}>
              {draftTest?.status === "testing" ? <Spinner className="h-3.5 w-3.5" /> : <Gauge size={14} />}
              测试连接
            </Button>
            <div className="flex-1" />
            <Button variant="outline" onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void saveDraft()} disabled={saving || !draft}>
              {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
              {isNew ? "添加" : "保存"}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3.5">
            <div>
              <div className="mb-1.5 text-[12px] text-fg3">连接类型</div>
              <SegmentedControl
                options={CONNECTION_KINDS.filter((k) => !(isWindows && k.key === "local"))}
                value={draft.kind}
                onChange={(k) => setDraft({ ...draft, kind: k })}
              />
              {draft.kind === "tcp" && (
                <div className="mt-2">
                  <Badge tone="warn">明文传输不安全，流量未加密，建议改用 SSH 或 TLS</Badge>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-1 block">
                <span className="mb-1 block text-[12px] text-fg3">名称</span>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={`我的 ${connectionKindLabel(draft.kind)}连接`}
                  spellCheck={false}
                />
              </label>

              {draft.kind === "local" && (
                <label className="col-span-1 block">
                  <span className="mb-1 block text-[12px] text-fg3">Socket 路径</span>
                  <Input
                    value={draft.socket_path}
                    onChange={(e) => setDraft({ ...draft, socket_path: e.target.value })}
                    placeholder="/var/run/docker.sock"
                    className="font-mono"
                    spellCheck={false}
                  />
                </label>
              )}

              {(draft.kind === "tcp" || draft.kind === "tls") && (
                <label className="col-span-1 block">
                  <span className="mb-1 block text-[12px] text-fg3">主机地址</span>
                  <Input
                    value={draft.host}
                    onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                    placeholder={draft.kind === "tls" ? "192.168.1.10:2376" : "192.168.1.10:2375"}
                    className="font-mono"
                    spellCheck={false}
                  />
                </label>
              )}

              {draft.kind === "ssh" && (
                <label className="col-span-1 block">
                  <span className="mb-1 block text-[12px] text-fg3">SSH 地址</span>
                  <Input
                    value={draft.host}
                    onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                    placeholder="user@ip 或 user@ip:port"
                    className="font-mono"
                    spellCheck={false}
                  />
                </label>
              )}
            </div>

            {draft.kind === "tls" && (
              <label className="block">
                <span className="mb-1 block text-[12px] text-fg3">证书目录</span>
                <div className="flex gap-2">
                  <Input
                    value={draft.cert_path}
                    onChange={(e) => setDraft({ ...draft, cert_path: e.target.value })}
                    placeholder="/etc/docker/certs"
                    className="flex-1 font-mono"
                    spellCheck={false}
                  />
                  <Button variant="outline" onClick={() => void pickCertDir()}>
                    选择目录
                  </Button>
                </div>
                <span className="mt-1 block text-[11px] text-fg3">
                  目录下需包含 ca.pem、cert.pem、key.pem（服务端需开启 TLS 验证，默认端口 2376）
                </span>
              </label>
            )}

            {draft.kind === "ssh" && (
              <>
                <div>
                  <div className="mb-1.5 text-[12px] text-fg3">认证方式</div>
                  <SegmentedControl
                    options={CONNECTION_AUTHS}
                    value={draft.auth || "key"}
                    onChange={(k: ConnectionAuth) => {
                      // 切换认证方式时清掉另一侧的瞬态输入，避免误存
                      if (k === "password") setDraftPassphrase("");
                      else setDraftPassword("");
                      setDraft({ ...draft, auth: k });
                    }}
                  />
                </div>

                {draft.auth === "password" ? (
                  <label className="block">
                    <span className="mb-1 block text-[12px] text-fg3">密码</span>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        value={draftPassword}
                        onChange={(e) => setDraftPassword(e.target.value)}
                        placeholder={draft.secret_backend ? "已保存，留空保持不变" : "远程用户的 SSH 登录密码"}
                        className="flex-1"
                        autoComplete="off"
                      />
                      {draft.secret_backend && (
                        <Button
                          variant="outline"
                          onClick={() => {
                            void api
                              .setSshSecret(draft.id, "password", "")
                              .then(() => {
                                setDraft({ ...draft, secret_backend: "" });
                                toast.success("已清除保存的密码");
                              })
                              .catch((e) => toast.error(`清除密码失败: ${e}`));
                          }}
                        >
                          清除已保存
                        </Button>
                      )}
                    </div>
                    <span className="mt-1 block text-[11px] text-fg3">
                      密码保存在本机系统钥匙串（无钥匙串环境回退加密文件），不写入配置文件、不上传
                    </span>
                  </label>
                ) : (
                  <label className="block">
                    <span className="mb-1 block text-[12px] text-fg3">私钥路径（可选）</span>
                    <div className="flex gap-2">
                      <Input
                        value={draft.key_path}
                        onChange={(e) => setDraft({ ...draft, key_path: e.target.value })}
                        placeholder={
                          isWindows
                            ? "建议指定私钥路径（Windows 版暂不支持 ssh-agent），留空则尝试默认私钥"
                            : "留空则依次尝试 ssh-agent 与默认私钥（~/.ssh/id_*）"
                        }
                        className="flex-1 font-mono"
                        spellCheck={false}
                      />
                      <Button variant="outline" onClick={() => void pickKeyFile()}>
                        选择文件
                      </Button>
                    </div>
                    {draft.key_path.trim() && (
                      <div className="mt-2">
                        <span className="mb-1 block text-[12px] text-fg3">私钥口令（可选）</span>
                        <div className="flex gap-2">
                          <Input
                            type="password"
                            value={draftPassphrase}
                            onChange={(e) => setDraftPassphrase(e.target.value)}
                            placeholder={draft.secret_backend ? "已保存，留空保持不变" : "私钥有口令时填写"}
                            className="flex-1"
                            autoComplete="off"
                          />
                          {draft.secret_backend && (
                            <Button
                              variant="outline"
                              onClick={() => {
                                void api
                                  .setSshSecret(draft.id, "key_passphrase", "")
                                  .then(() => {
                                    setDraft({ ...draft, secret_backend: "" });
                                    toast.success("已清除保存的口令");
                                  })
                                  .catch((e) => toast.error(`清除口令失败: ${e}`));
                              }}
                            >
                              清除已保存
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </label>
                )}

                <label className="block">
                  <span className="mb-1 block text-[12px] text-fg3">远程 Socket 路径（可选）</span>
                  <Input
                    value={draft.remote_socket}
                    onChange={(e) => setDraft({ ...draft, remote_socket: e.target.value })}
                    placeholder="/var/run/docker.sock"
                    className="font-mono"
                    spellCheck={false}
                  />
                  <span className="mt-1 block text-[11px] text-fg3">
                    {"rootless Docker 填 /run/user/<uid>/docker.sock"}
                  </span>
                </label>
                <div className="rounded-ctl border border-edge bg-panel2 p-2.5 text-[11px] leading-4 text-fg3">
                  <span className="mb-1 block font-medium text-fg2">连接要求</span>
                  <ul className="list-disc space-y-1 pl-4">
                    {sshConnectionNotes(draft.auth, isWindows).map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            {draftTest?.status === "ok" && (
              <div
                role="status"
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-ctl border border-ok/20 bg-ok/5 px-2.5 py-2 text-[12px]"
              >
                <Badge tone="ok">连接成功</Badge>
                <span className="shrink-0 tabular-nums text-fg2">
                  {draftTest.ms} ms
                </span>
                {draftTest.version && (
                  <span
                    className="min-w-0 max-w-full truncate font-mono text-[11px] text-fg3"
                    title={draftTest.version}
                  >
                    Docker {draftTest.version}
                  </span>
                )}
              </div>
            )}
            {draftTest?.status === "fail" && (
              <div
                role="alert"
                className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-ctl border border-err/20 bg-err/5 px-2.5 py-2 text-[12px] leading-4 text-err"
              >
                {draftTest.error || "连接失败"}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 主机指纹变更确认（TOFU） */}
      <Modal
        open={hostKey !== null}
        title="主机指纹已变更"
        onClose={() => setHostKey(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setHostKey(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!hostKey) return;
                const { change, retry } = hostKey;
                setHostKey(null);
                void api
                  .acceptHostKey(change.dest, change.new, change.algo)
                  .then(retry)
                  .catch((e) => toast.error(`保存主机指纹失败: ${e}`));
              }}
            >
              确认变更并重连
            </Button>
          </>
        }
      >
        <div className="space-y-2.5">
          <p className="flex items-start gap-1.5">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warn" />
            <span>
              主机 <span className="font-mono font-semibold">{hostKey?.change.dest}</span> 的密钥指纹
              （{hostKey?.change.algo}）与上次记录不一致。这通常发生在系统重装或 sshd 重新生成主机密钥后，
              但也可能是中间人攻击的信号。
            </span>
          </p>
          <div className="rounded-ctl border border-edge bg-panel2 p-2.5 font-mono text-[11px] leading-4">
            <div className="text-fg3">
              原指纹：<span className="break-all text-fg2">{hostKey?.change.stored}</span>
            </div>
            <div className="text-fg3">
              新指纹：<span className="break-all text-warn">{hostKey?.change.new}</span>
            </div>
          </div>
          <p className="text-[11px] text-fg3">
            可在服务器上执行 ssh-keygen -lf /etc/ssh/ssh_host_*.pub.pub 对照（文件名随算法不同略有差异）。
            确认无误后接受新指纹；如无法确认来源，请取消并核查网络环境。
          </p>
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={confirmDelete !== null}
        title="删除连接配置"
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDelete) removeProfile(confirmDelete);
                setConfirmDelete(null);
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p>
          将删除连接「<span className="font-semibold text-fg">{confirmDelete?.name}</span>」的配置，
          仅移除本应用中的记录，不影响远程主机上的 Docker。
        </p>
      </Modal>
    </section>
  );
}
