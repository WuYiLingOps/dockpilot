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
import { t, useT } from "../../lib/i18n";
import { useIsWindows } from "../../lib/platform";
import {
  displayConnName,
  useSettings,
  useSwitchConnection,
  useUpdateSettings,
} from "../../lib/settings";
import { parseHostKeyChange, type HostKeyChange } from "../../lib/ssh";
import {
  CONNECTION_AUTHS,
  CONNECTION_KINDS,
  connectionAuthLabel,
  connectionKindLabel,
  type ConnectionAuth,
  type ConnectionKind,
  type ConnectionProfile,
  type ConnectionTestResult,
} from "../../types/settings";
import { Badge, Button, IconButton, Input, Modal, SegmentedControl, Select, Spinner } from "../ui";

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
  if (!p.name.trim()) return t("conn.nameRequired");
  if (p.kind === "tcp" && !p.host.trim()) return t("conn.hostRequired");
  if (p.kind === "tls") {
    if (!p.host.trim()) return t("conn.hostRequired");
    if (!p.cert_path.trim()) return t("conn.certRequired");
  }
  if (p.kind === "ssh") {
    if (!p.host.trim()) return t("conn.sshAddrRequired");
    // 使用 SSH 身份时用户名来自身份，host 可只写 host[:port]
    if (p.identity_id === "" && !p.host.includes("@")) {
      return t("conn.sshAddrFormat");
    }
    if (p.auth !== "password" && p.key_path.trim().toLowerCase().endsWith(".pub")) {
      return t("conn.pubKeySelected");
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
    key_id: "",
  identity_id: "",
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
      t("conn.notePwdLocal"),
      t("conn.notePwdUserInDockerGroup"),
      t("conn.notePwdDisabled"),
      t("conn.noteEncrypted"),
    ];
  }
  const deploy = isWindows ? t("conn.deployKeyWindows") : t("conn.deployKey");
  return [
    t("conn.noteBuiltInEngine"),
    t("conn.noteKeySources"),
    `${deploy}${t("conn.deployKeySuffix")}`,
    t("conn.noteEncrypted"),
  ];
}

/** 设置页 · Docker 连接分组：多连接配置的增删改、连通性测试与切换 */
export function ConnectionSettings() {
  const qc = useQueryClient();
  const t = useT();
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
  const sshKeys = settings.ssh_keys;
  const sshIdentities = settings.ssh_identities;

  const openDraft = (p: ConnectionProfile, isNewDraft: boolean) => {
    setDraft({ ...p });
    setIsNew(isNewDraft);
    setDraftPassword("");
    setDraftPassphrase("");
  };

  /** 持久化草稿的连接侧密钥；空值跳过（保持原密钥）；钥匙串私钥由「SSH 凭证」页管理 */
  const persistSshSecrets = async (p: ConnectionProfile) => {
    if (p.kind !== "ssh") return;
    if (p.auth === "password" && draftPassword) {
      await api.setSshSecret(p.id, "password", draftPassword);
    }
    if (p.auth !== "password" && p.auth === "key" && p.key_id === "" && draftPassphrase) {
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
      toast.error(t("settings.saveFailed", { err: String(e) }));
      setSaving(false);
      return;
    }
    setSaving(false);
    const wasActive = draft.id === activeId;
    setDraft(null);
    if (wasActive) {
      try {
        await api.switchConnection(draft.id);
        toast.success(t("conn.savedAndReconnected"));
      } catch (e) {
        const message = String(e);
        const change = parseHostKeyChange(message);
        if (change) {
          // 指纹变更：确认后重试切换
          setHostKey({ change, retry: async () => {
            try {
              await api.switchConnection(draft.id);
              toast.success(t("conn.savedAndReconnected"));
              void qc.invalidateQueries();
            } catch (err) {
              toast.error(
                t("conn.savedButReconnectFailed", { err: firstLine(String(err)) }),
              );
            }
          } });
          return;
        }
        toast.error(t("conn.savedButReconnectFailed", { err: firstLine(message) }));
      }
    } else {
      toast.success(t("conn.saved"));
    }
    void qc.invalidateQueries();
  };

  /** 执行一次连通性测试；主机指纹变更时弹确认框并在确认后自动重试 */
  const runTest = async (p: ConnectionProfile, transient?: { password?: string; passphrase?: string }) => {
    setTesting((prev) => ({ ...prev, [p.id]: { status: "testing" } }));
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
          setTesting((prev) => ({
            ...prev,
            [p.id]: { status: "fail", error: t("conn.hostKeyAwaitingConfirm") },
          }));
          return;
        }
      }
      setTesting((prev) =>
        r.ok
          ? { ...prev, [p.id]: { status: "ok", ms: r.latency_ms ?? 0, version: r.version } }
          : { ...prev, [p.id]: { status: "fail", error: r.error || t("conn.connectFailed") } },
      );
    } catch (e) {
      const message = errorMessage(e);
      setTesting((prev) => ({ ...prev, [p.id]: { status: "fail", error: message } }));
      throw e instanceof Error ? e : new Error(message);
    }
  };

  const testDraft = async () => {
    if (!draft || testing[draft.id]?.status === "testing") return;
    const err = validateDraft(draft);
    if (err) {
      setTesting((prev) => ({ ...prev, [draft.id]: { status: "fail", error: err } }));
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
      toast.error(t("reg.testFailedNamed", { name: p.name, err: firstLine(errorMessage(e)) }));
    }
  };

  const removeProfile = (p: ConnectionProfile) => {
    if (p.id === activeId) {
      toast.info(t("conn.cannotDeleteActive"));
      return;
    }
    if (connections.length <= 1) {
      toast.info(t("conn.keepAtLeastOne"));
      return;
    }
    update.mutate(
      { ...settings, connections: connections.filter((c) => c.id !== p.id) },
      { onSuccess: () => toast.success(t("conn.deleted")) },
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
        <div className="text-[13px] font-semibold text-fg">{t("conn.sectionTitle")}</div>
        {connections.map((c) =>
          c.id === activeId ? (
            <span key="active" className="flex items-center gap-1.5 text-[11px] text-fg3">
              {t("conn.currentPrefix")}
              <span className="max-w-40 truncate font-mono text-fg2">{c.name}</span>
            </span>
          ) : null,
        )}
      </div>

      <div className="divide-y divide-edge/60">
        {connections.map((c) => {
          const meta = KIND_META[c.kind] ?? KIND_META.local;
          const Icon = meta.icon;
          const ts = testing[c.id];
          const isActive = c.id === activeId;
          return (
            <div
              key={c.id}
              title={isActive ? t("sidebar.currentConnection") : t("conn.clickToSwitch")}
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
                  <span className="truncate">{displayConnName(c.name)}</span>
                  {isActive && <Badge tone="accent">{t("conn.currentBadge")}</Badge>}
                </div>
                <div className="truncate font-mono text-[11px] text-fg3" title={displayUrl(c)}>
                  {displayUrl(c)}
                </div>
              </div>
              <Badge tone={meta.tone}>{connectionKindLabel(c.kind)}</Badge>
              {ts?.status === "testing" && <Spinner className="h-3.5 w-3.5" />}
              {ts?.status === "ok" && (
                <Badge tone={ts.ms < 300 ? "ok" : ts.ms < 1000 ? "warn" : "neutral"}>
                  {ts.ms} ms{ts.version ? ` · ${ts.version}` : ""}
                </Badge>
              )}
              {ts?.status === "fail" && (
                <span title={ts.error || t("conn.connectFailed")}>
                  <Badge tone="err">{t("mir.unreachable")}</Badge>
                </span>
              )}
              <div
                data-no-drag
                className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
              >
                <IconButton
                  title={t("reg.testConnection")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void testRow(c);
                  }}
                >
                  <Gauge size={13} />
                </IconButton>
                <IconButton
                  title={t("reg.edit")}
                  onClick={(e) => {
                    e.stopPropagation();
                    openDraft(c, false);
                  }}
                >
                  <Pencil size={13} />
                </IconButton>
                <IconButton
                  title={isActive ? t("conn.activeNoDelete") : t("containers.actRemove")}
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
        <span className="text-[11px] text-fg3">{t("conn.listHint")}</span>
        <Button
          variant="outline"
          className="shrink-0"
          onClick={() => {
            openDraft(emptyDraft(isWindows ? "ssh" : "local"), true);
          }}
        >
          <Plus size={13} />
          {t("conn.addConnection")}
        </Button>
      </div>

      {/* 添加 / 编辑连接 */}
      <Modal
        open={draft !== null}
        title={isNew ? t("conn.addTitle") : t("conn.editTitle")}
        onClose={() => setDraft(null)}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => void testDraft()} disabled={!draft}>
              {draftTest?.status === "testing" ? <Spinner className="h-3.5 w-3.5" /> : <Gauge size={14} />}
              {t("reg.testConnection")}
            </Button>
            <div className="flex-1" />
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void saveDraft()} disabled={saving || !draft}>
              {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
              {isNew ? t("img.add") : t("common.save")}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3.5">
            <div>
              <div className="mb-1.5 text-[12px] text-fg3">{t("conn.kindLabel")}</div>
              <SegmentedControl
                options={CONNECTION_KINDS.filter((k) => !(isWindows && k.key === "local")).map(
                  ({ key }) => ({ key, label: connectionKindLabel(key) }),
                )}
                value={draft.kind}
                onChange={(k) => setDraft({ ...draft, kind: k })}
              />
              {draft.kind === "tcp" && (
                <div className="mt-2">
                  <Badge tone="warn">{t("conn.tcpPlaintextWarning")}</Badge>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-1 block">
                <span className="mb-1 block text-[12px] text-fg3">{t("st.name")}</span>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t("conn.namePlaceholder", { kind: connectionKindLabel(draft.kind) })}
                  spellCheck={false}
                />
              </label>

              {draft.kind === "local" && (
                <label className="col-span-1 block">
                  <span className="mb-1 block text-[12px] text-fg3">{t("conn.socketPath")}</span>
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
                  <span className="mb-1 block text-[12px] text-fg3">{t("conn.hostLabel")}</span>
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
                  <span className="mb-1 block text-[12px] text-fg3">{t("conn.sshAddrLabel")}</span>
                  <Input
                    value={draft.host}
                    onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                    placeholder={
                      draft.identity_id
                        ? t("conn.sshAddrPhWithIdentity")
                        : t("conn.sshAddrPh")
                    }
                    className="font-mono"
                    spellCheck={false}
                  />
                </label>
              )}
            </div>

            {draft.kind === "tls" && (
              <label className="block">
                <span className="mb-1 block text-[12px] text-fg3">{t("conn.certDirLabel")}</span>
                <div className="flex gap-2">
                  <Input
                    value={draft.cert_path}
                    onChange={(e) => setDraft({ ...draft, cert_path: e.target.value })}
                    placeholder="/etc/docker/certs"
                    className="flex-1 font-mono"
                    spellCheck={false}
                  />
                  <Button variant="outline" onClick={() => void pickCertDir()}>
                    {t("compose.chooseDir")}
                  </Button>
                </div>
                <span className="mt-1 block text-[11px] text-fg3">{t("conn.certDirHint")}</span>
              </label>
            )}

            {draft.kind === "ssh" && (
              <>
                <div>
                  <div className="mb-1.5 text-[12px] text-fg3">{t("conn.identityLabel")}</div>
                  <Select
                    value={draft.identity_id || ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      // 切换身份时清掉瞬态输入，避免误存
                      setDraftPassword("");
                      setDraftPassphrase("");
                      setDraft({ ...draft, identity_id: v });
                    }}
                    className="w-full"
                  >
                    <option value="">{t("conn.identityNone")}</option>
                    {sshIdentities.map((i) => (
                      <option key={i.id} value={i.id}>
                        {displayConnName(i.label)}（{i.username}
                        {i.key_id ? t("conn.identityUsesKey") : t("conn.identityUsesPassword")}）
                      </option>
                    ))}
                  </Select>
                </div>

                {draft.identity_id !== "" && (
                  <div className="rounded-ctl border border-edge bg-panel2/50 px-2.5 py-2 text-[11px] leading-4 text-fg3">
                    {t("conn.identityInUseNote")}
                  </div>
                )}

                {draft.identity_id === "" && (
                <>
                <div>
                  <div className="mb-1.5 text-[12px] text-fg3">{t("conn.authMethod")}</div>
                  <SegmentedControl
                    options={CONNECTION_AUTHS.map(({ key }) => ({
                      key,
                      label: connectionAuthLabel(key),
                    }))}
                    value={draft.auth || "key"}
                    onChange={(k: ConnectionAuth) => {
                      // 切换认证方式时清掉另一侧的瞬态输入，避免误存
                      if (k === "password") setDraftPassphrase("");
                      else setDraftPassword("");
                      setDraft({ ...draft, auth: k });
                    }}                  />
                </div>

                {draft.auth === "password" ? (
                  <label className="block">
                    <span className="mb-1 block text-[12px] text-fg3">{t("reg.authPassword")}</span>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        value={draftPassword}
                        onChange={(e) => setDraftPassword(e.target.value)}
                        placeholder={
                          draft.secret_backend
                            ? t("ssh.passphraseKeep")
                            : t("conn.passwordPlaceholder")
                        }
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
                                toast.success(t("conn.passwordCleared"));
                              })
                              .catch((e) =>
                                toast.error(t("conn.passwordClearFailed", { err: String(e) })),
                              );
                          }}
                        >
                          {t("conn.clearSaved")}
                        </Button>
                      )}
                    </div>
                    <span className="mt-1 block text-[11px] text-fg3">
                      {t("conn.passwordStorageNote")}
                    </span>
                  </label>
                ) : (
                  <label className="block">
                    {sshKeys.length > 0 && (
                      <>
                        <span className="mb-1 block text-[12px] text-fg3">{t("conn.keySource")}</span>
                        <Select
                          value={draft.key_id ? `key:${draft.key_id}` : "path"}
                          onChange={(e) => {
                            const v = e.target.value;
                            setDraft({ ...draft, key_id: v.startsWith("key:") ? v.slice(4) : "" });
                          }}
                          className="w-full"
                        >
                          <option value="path">{t("conn.keySourcePath")}</option>
                          {sshKeys.map((k) => (
                            <option key={k.id} value={`key:${k.id}`}>
                              {t("ssh.usesKey", { key: k.label })}
                            </option>
                          ))}
                        </Select>
                      </>
                    )}
                    {draft.key_id === "" && (
                      <div className="mt-2 flex flex-col gap-2">
                        <div className="flex gap-2">
                          <Input
                            value={draft.key_path}
                            onChange={(e) => setDraft({ ...draft, key_path: e.target.value })}
                            placeholder={
                              isWindows
                                ? t("conn.keyPathPhWindows")
                                : t("conn.keyPathPh")
                            }
                            className="flex-1 font-mono"
                            spellCheck={false}
                          />
                          <Button variant="outline" onClick={() => void pickKeyFile()}>
                            {t("compose.chooseFile")}
                          </Button>
                        </div>
                        {draft.key_path.trim() && (
                          <div className="mt-1">
                            <span className="mb-1 block text-[12px] text-fg3">
                              {t("ssh.passphraseLabel")}
                            </span>
                            <div className="flex gap-2">
                              <Input
                                type="password"
                                value={draftPassphrase}
                                onChange={(e) => setDraftPassphrase(e.target.value)}
                                placeholder={
                                  draft.secret_backend
                                    ? t("ssh.passphraseKeep")
                                    : t("ssh.passphraseIfAny")
                                }
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
                                        toast.success(t("conn.passphraseCleared"));
                                      })
                                      .catch((e) =>
                                        toast.error(
                                          t("conn.passphraseClearFailed", { err: String(e) }),
                                        ),
                                      );
                                  }}
                                >
                                  {t("conn.clearSaved")}
                                </Button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {draft.key_id !== "" && (
                      <div className="mt-1.5 rounded-btn bg-panel2/50 px-2.5 py-1.5 text-[11px] leading-4 text-fg3">
                        {t("conn.keychainKeyNote")}
                      </div>
                    )}
                    <span className="mt-1.5 block text-[11px] text-fg3">
                      {sshKeys.length === 0
                        ? t("conn.keychainEmptyHint")
                        : t("conn.keychainCountHint", { n: sshKeys.length })}
                    </span>
                  </label>
                )}
                </>
                )}

                <label className="block">
                  <span className="mb-1 block text-[12px] text-fg3">
                    {t("conn.remoteSocketLabel")}
                  </span>
                  <Input
                    value={draft.remote_socket}
                    onChange={(e) => setDraft({ ...draft, remote_socket: e.target.value })}
                    placeholder="/var/run/docker.sock"
                    className="font-mono"
                    spellCheck={false}
                  />
                  <span className="mt-1 block text-[11px] text-fg3">
                    {t("conn.remoteSocketHint")}
                  </span>
                </label>
                <div className="rounded-ctl border border-edge bg-panel2 p-2.5 text-[11px] leading-4 text-fg3">
                  <span className="mb-1 block font-medium text-fg2">{t("conn.requirements")}</span>
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
                <Badge tone="ok">{t("conn.testOk")}</Badge>
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
                {draftTest.error || t("conn.connectFailed")}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 主机指纹变更确认（TOFU） */}
      <Modal
        open={hostKey !== null}
        title={t("conn.hostKeyChangedTitle")}
        onClose={() => setHostKey(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setHostKey(null)}>
              {t("common.cancel")}
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
                  .catch((e) =>
                    toast.error(t("conn.hostKeySaveFailed", { err: String(e) })),
                  );
              }}
            >
              {t("conn.hostKeyAccept")}
            </Button>
          </>
        }
      >
        <div className="space-y-2.5">
          <p className="flex items-start gap-1.5">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warn" />
            <span>
              {t("conn.hostKeyChangedDesc", { dest: hostKey?.change.dest ?? "", algo: hostKey?.change.algo ?? "" })}
            </span>
          </p>
          <div className="rounded-ctl border border-edge bg-panel2 p-2.5 font-mono text-[11px] leading-4">
            <div className="text-fg3">
              {t("conn.fingerprintOld")}
              <span className="break-all text-fg2">{hostKey?.change.stored}</span>
            </div>
            <div className="text-fg3">
              {t("conn.fingerprintNew")}
              <span className="break-all text-warn">{hostKey?.change.new}</span>
            </div>
          </div>
          <p className="text-[11px] text-fg3">{t("conn.hostKeyVerifyHint")}</p>
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={confirmDelete !== null}
        title={t("conn.deleteTitle")}
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDelete) removeProfile(confirmDelete);
                setConfirmDelete(null);
              }}
            >
              {t("containers.actRemove")}
            </Button>
          </>
        }
      >
        <p>
          {t("conn.deleteConfirmBefore")}
          <span className="font-semibold text-fg">{confirmDelete?.name}</span>
          {t("conn.deleteConfirmAfter")}
        </p>
      </Modal>
    </section>
  );
}
