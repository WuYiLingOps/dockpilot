/**
 * SSH 凭证（钥匙串）设置：跨连接复用的两类实体管理。
 * - 钥匙串私钥：PEM/口令存本机 secret_store（钥匙串优先，回退加密文件），
 *   支持文件导入与粘贴导入，导入时校验有效性并推导公钥；
 * - 身份：用户名 + 密码（+ 可选关联钥匙串私钥），跨连接复用。
 * 被连接引用的条目由后端拒绝删除。
 */
import { useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { timeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSettings } from "../../lib/settings";
import type { SshIdentity, SshKeyEntry } from "../../types/settings";
import { Badge, Button, IconButton, Input, Modal, Select, Spinner } from "../ui";

interface KeyDraft {
  /** null = 导入新条目；非空 = 重命名 / 替换 PEM */
  id: string | null;
  label: string;
  /** 私钥文件路径（与粘贴内容二选一；编辑留空 = 不替换 PEM） */
  path: string;
  /** 粘贴的私钥内容（与文件路径二选一） */
  pemText: string;
  /** 口令（可选；编辑时留空 = 保持不变） */
  passphrase: string;
}

interface IdentityDraft {
  /** null = 新建身份 */
  id: string | null;
  label: string;
  username: string;
  /** 密码（编辑时留空 = 保持不变） */
  password: string;
  /** 可选关联的钥匙串私钥条目 id（"" = 不关联；编辑时 "" = 保持不变） */
  keyId: string;
}

export function SshKeySettings() {
  const qc = useQueryClient();
  const t = useT();
  const { data: settings } = useSettings();
  const sshKeys = settings?.ssh_keys ?? [];
  const sshIdentities = settings?.ssh_identities ?? [];
  const connections = settings?.connections ?? [];
  const keyRefCount = (id: string) =>
    connections.filter((c) => c.kind === "ssh" && c.key_id === id).length;
  const identityRefCount = (id: string) =>
    connections.filter((c) => c.kind === "ssh" && c.identity_id === id).length;
  const keyLabel = (id: string) => sshKeys.find((k) => k.id === id)?.label ?? "";

  const [keyDraft, setKeyDraft] = useState<KeyDraft | null>(null);
  const [keySaving, setKeySaving] = useState(false);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<SshKeyEntry | null>(null);

  const [identityDraft, setIdentityDraft] = useState<IdentityDraft | null>(null);
  const [identitySaving, setIdentitySaving] = useState(false);
  const [confirmDeleteIdentity, setConfirmDeleteIdentity] = useState<SshIdentity | null>(null);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["settings"] });
  };

  const pickKeyFile = async () => {
    try {
      const f = await open({ multiple: false });
      if (typeof f === "string") setKeyDraft((d) => (d ? { ...d, path: f, pemText: "" } : d));
    } catch {
      // 非桌面环境（浏览器 mock）无文件对话框
    }
  };

  const saveKeyDraft = async () => {
    if (!keyDraft) return;
    if (!keyDraft.label.trim()) {
      toast.error(t("ssh.labelRequired"));
      return;
    }
    if (!keyDraft.id && !keyDraft.path.trim() && !keyDraft.pemText.trim()) {
      toast.error(t("ssh.keyMaterialRequired"));
      return;
    }
    setKeySaving(true);
    try {
      const pem = keyDraft.path.trim()
        ? await api.readPrivateKeyFile(keyDraft.path)
        : keyDraft.pemText.trim() || null;
      const entry = await api.saveSshKeyEntry(
        keyDraft.id,
        keyDraft.label.trim(),
        pem,
        keyDraft.passphrase || null,
      );
      await refresh();
      toast.success(
        t("ssh.keySaved", {
          label: entry.label,
          fp: entry.fingerprint ? `（${entry.fingerprint}）` : "",
        }),
      );
      setKeyDraft(null);
    } catch (e) {
      toast.error(t("ssh.keySaveFailed", { err: String(e) }));
    } finally {
      setKeySaving(false);
    }
  };

  const removeKey = async (entry: SshKeyEntry) => {
    try {
      await api.deleteSshKeyEntry(entry.id);
      await refresh();
      toast.success(t("ssh.deleted", { label: entry.label }));
    } catch (e) {
      toast.error(t("ssh.deleteFailed", { err: String(e) }));
    } finally {
      setConfirmDeleteKey(null);
    }
  };

  const saveIdentityDraft = async () => {
    if (!identityDraft) return;
    if (!identityDraft.label.trim()) {
      toast.error(t("ssh.identityLabelRequired"));
      return;
    }
    if (!identityDraft.username.trim()) {
      toast.error(t("ssh.usernameRequired"));
      return;
    }
    setIdentitySaving(true);
    try {
      const entry = await api.saveSshIdentity(
        identityDraft.id,
        identityDraft.label.trim(),
        identityDraft.username.trim(),
        identityDraft.password || null,
        identityDraft.keyId || null,
      );
      await refresh();
      toast.success(t("ssh.identitySaved", { label: entry.label }));
      setIdentityDraft(null);
    } catch (e) {
      toast.error(t("ssh.identitySaveFailed", { err: String(e) }));
    } finally {
      setIdentitySaving(false);
    }
  };

  const removeIdentity = async (entry: SshIdentity) => {
    try {
      await api.deleteSshIdentity(entry.id);
      await refresh();
      toast.success(t("ssh.identityDeleted", { label: entry.label }));
    } catch (e) {
      toast.error(t("ssh.deleteFailed", { err: String(e) }));
    } finally {
      setConfirmDeleteIdentity(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
      <div className="flex items-center justify-between border-b border-edge/60 bg-panel2/40 px-4 py-2.5">
        <div className="text-[13px] font-semibold text-fg">{t("settings.catSshKeys")}</div>
        <span className="text-[11px] text-fg3">
          {t("ssh.sectionDesc")}
        </span>
      </div>

      {/* ------------------------------------------------ 钥匙串私钥 */}
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-[12px] font-medium text-fg2">{t("ssh.keysSection")}</span>
        <Button
          variant="outline"
          onClick={() =>
            setKeyDraft({ id: null, label: "", path: "", pemText: "", passphrase: "" })
          }
        >
          <Plus size={13} />
          {t("ssh.importKey")}
        </Button>
      </div>
      {sshKeys.length === 0 ? (
        <div className="px-4 pb-3 pt-1 text-[12px] text-fg3">
          {t("ssh.keysEmpty")}
        </div>
      ) : (
        <div className="divide-y divide-edge/60 px-4 pb-2">
          {sshKeys.map((k) => {
            const refs = keyRefCount(k.id);
            return (
              <div key={k.id} className="group flex items-center gap-3 py-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
                  <KeyRound size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-fg">{k.label}</span>
                    {refs > 0 ? (
                      <Badge tone="accent">{t("ssh.nRefs", { n: refs })}</Badge>
                    ) : (
                      <Badge tone="neutral">{t("st.unused")}</Badge>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11px] text-fg3">
                    {k.fingerprint || t("ssh.noFingerprint")}
                  </div>
                </div>
                <span className="hidden shrink-0 text-[11px] text-fg3 xl:inline">
                  {timeAgo(k.created_at)}
                </span>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  {k.public_key && (
                    <IconButton
                      title={t("ssh.copyPubKeyTitle")}
                      onClick={() => {
                        void copyText(k.public_key).then(() => toast.success(t("ssh.pubKeyCopied")));
                      }}
                    >
                      <Copy size={13} />
                    </IconButton>
                  )}
                  <IconButton
                    title={t("ssh.renameKeyTitle")}
                    onClick={() =>
                      setKeyDraft({
                        id: k.id,
                        label: k.label,
                        path: "",
                        pemText: "",
                        passphrase: "",
                      })
                    }
                  >
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton title={t("containers.actRemove")} onClick={() => setConfirmDeleteKey(k)}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ------------------------------------------------ 身份 */}
      <div className="flex items-center justify-between border-t border-edge/60 px-4 pb-1 pt-3">
        <span className="text-[12px] font-medium text-fg2">{t("ssh.identitiesSection")}</span>
        <Button
          variant="outline"
          onClick={() =>
            setIdentityDraft({ id: null, label: "", username: "", password: "", keyId: "" })
          }
        >
          <Plus size={13} />
          {t("ssh.newIdentity")}
        </Button>
      </div>
      {sshIdentities.length === 0 ? (
        <div className="px-4 pb-3 pt-1 text-[12px] text-fg3">
          {t("ssh.identitiesEmpty")}
        </div>
      ) : (
        <div className="divide-y divide-edge/60 px-4 pb-2">
          {sshIdentities.map((i) => {
            const refs = identityRefCount(i.id);
            return (
              <div key={i.id} className="group flex items-center gap-3 py-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
                  <UserRound size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-fg">{i.label}</span>
                    {refs > 0 ? (
                      <Badge tone="accent">{t("ssh.nRefs", { n: refs })}</Badge>
                    ) : (
                      <Badge tone="neutral">{t("st.unused")}</Badge>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-fg3">
                    {i.username} ·{" "}
                    {i.key_id
                      ? t("ssh.usesKey", { key: keyLabel(i.key_id) || t("ssh.keyDeleted") })
                      : t("ssh.passwordAuth")}
                  </div>
                </div>
                <span className="hidden shrink-0 text-[11px] text-fg3 xl:inline">
                  {timeAgo(i.created_at)}
                </span>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <IconButton
                    title={t("reg.edit")}
                    onClick={() =>
                      setIdentityDraft({
                        id: i.id,
                        label: i.label,
                        username: i.username,
                        password: "",
                        keyId: "",
                      })
                    }
                  >
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton title={t("containers.actRemove")} onClick={() => setConfirmDeleteIdentity(i)}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="border-t border-edge/60 px-4 py-3 text-[11px] leading-4 text-fg3">
        {t("ssh.footerNote")}
      </div>

      {/* ------------------------------------------------ 导入 / 编辑私钥 */}
      <Modal
        open={keyDraft !== null}
        title={keyDraft?.id ? t("ssh.editKeyTitle") : t("ssh.importKeyTitle")}
        onClose={() => setKeyDraft(null)}
        footer={
          <>
            <div className="flex-1" />
            <Button variant="outline" onClick={() => setKeyDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void saveKeyDraft()}
              disabled={keySaving || !keyDraft}
            >
              {keySaving ? <Spinner className="h-3.5 w-3.5" /> : null}
              {keyDraft?.id ? t("common.save") : t("ssh.import")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg3">{t("st.name")}</span>
            <Input
              value={keyDraft?.label ?? ""}
              onChange={(e) => setKeyDraft((d) => (d ? { ...d, label: e.target.value } : d))}
              placeholder={t("ssh.keyNamePlaceholder")}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg3">{t("ssh.keyFileLabel")}</span>
            <div className="flex gap-2">
              <Input
                value={keyDraft?.path ?? ""}
                onChange={(e) =>
                  setKeyDraft((d) => (d ? { ...d, path: e.target.value, pemText: "" } : d))
                }
                placeholder={t("ssh.keyPathPlaceholder")}
                className="flex-1 font-mono"
                spellCheck={false}
              />
              <Button variant="outline" onClick={() => void pickKeyFile()}>
                {t("compose.chooseFile")}
              </Button>
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg3">{t("ssh.pastePemLabel")}</span>
            <textarea
              value={keyDraft?.pemText ?? ""}
              onChange={(e) =>
                setKeyDraft((d) => (d ? { ...d, pemText: e.target.value, path: "" } : d))
              }
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              rows={4}
              className="w-full resize-y rounded-btn border border-edge bg-panel px-2.5 py-2 font-mono text-[12px] text-fg placeholder:text-fg3/60 focus:border-accent/60 focus:outline-none"
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg3">{t("ssh.passphraseLabel")}</span>
            <Input
              type="password"
              value={keyDraft?.passphrase ?? ""}
              onChange={(e) => setKeyDraft((d) => (d ? { ...d, passphrase: e.target.value } : d))}
              placeholder={keyDraft?.id ? t("ssh.passphraseKeep") : t("ssh.passphraseIfAny")}
              autoComplete="off"
            />
          </label>
          <div className="rounded-ctl border border-edge bg-panel2/50 px-2.5 py-2 text-[11px] leading-4 text-fg3">
            {t("ssh.importNote")}
          </div>
        </div>
      </Modal>

      {/* 删除私钥确认 */}
      <Modal
        open={confirmDeleteKey !== null}
        title={t("ssh.deleteKeyTitle")}
        onClose={() => setConfirmDeleteKey(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDeleteKey(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDeleteKey) void removeKey(confirmDeleteKey);
              }}
            >
              {t("containers.actRemove")}
            </Button>
          </>
        }
      >
        <p className="text-[12px] leading-5 text-fg2">
          {t("ssh.deleteKeyBefore")}
          <span className="font-semibold text-fg">{confirmDeleteKey?.label}</span>
          {t("ssh.deleteKeyAfter", {
            fp: confirmDeleteKey?.fingerprint || t("ssh.noFingerprint"),
          })}
          {confirmDeleteKey && keyRefCount(confirmDeleteKey.id) > 0 && (
            <span className="text-err">
              {" "}
              {t("ssh.deleteKeyRefused", { n: keyRefCount(confirmDeleteKey.id) })}
            </span>
          )}
        </p>
      </Modal>

      {/* ------------------------------------------------ 新建 / 编辑身份 */}
      <Modal
        open={identityDraft !== null}
        title={identityDraft?.id ? t("ssh.editIdentityTitle") : t("ssh.newIdentityTitle")}
        onClose={() => setIdentityDraft(null)}
        footer={
          <>
            <div className="flex-1" />
            <Button variant="outline" onClick={() => setIdentityDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void saveIdentityDraft()}
              disabled={identitySaving || !identityDraft}
            >
              {identitySaving ? <Spinner className="h-3.5 w-3.5" /> : null}
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg3">{t("st.name")}</span>
            <Input
              value={identityDraft?.label ?? ""}
              onChange={(e) => setIdentityDraft((d) => (d ? { ...d, label: e.target.value } : d))}
              placeholder={t("ssh.identityNamePlaceholder")}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg3">{t("push.username")}</span>
            <Input
              value={identityDraft?.username ?? ""}
              onChange={(e) =>
                setIdentityDraft((d) => (d ? { ...d, username: e.target.value } : d))
              }
              placeholder={t("ssh.usernamePlaceholder")}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg3">{t("reg.authPassword")}</span>
            <Input
              type="password"
              value={identityDraft?.password ?? ""}
              onChange={(e) =>
                setIdentityDraft((d) => (d ? { ...d, password: e.target.value } : d))
              }
              placeholder={identityDraft?.id ? t("ssh.passwordKeepWithKey") : t("ssh.passwordNeedsKey")}
              autoComplete="off"
            />
          </label>
          {sshKeys.length > 0 && (
            <label className="block">
              <span className="mb-1 block text-[12px] text-fg3">{t("ssh.linkKeyLabel")}</span>
              <Select
                value={identityDraft?.keyId ?? ""}
                onChange={(e) => setIdentityDraft((d) => (d ? { ...d, keyId: e.target.value } : d))}
                className="w-full"
              >
                <option value="">{t("ssh.linkKeyNone")}</option>
                {sshKeys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </Select>
              <span className="mt-1 block text-[11px] text-fg3">
                {t("ssh.linkKeyNote")}
              </span>
            </label>
          )}
        </div>
      </Modal>

      {/* 删除身份确认 */}
      <Modal
        open={confirmDeleteIdentity !== null}
        title={t("ssh.deleteIdentityTitle")}
        onClose={() => setConfirmDeleteIdentity(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDeleteIdentity(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDeleteIdentity) void removeIdentity(confirmDeleteIdentity);
              }}
            >
              {t("containers.actRemove")}
            </Button>
          </>
        }
      >
        <p className="text-[12px] leading-5 text-fg2">
          {t("ssh.deleteIdentityBefore")}
          <span className="font-semibold text-fg">{confirmDeleteIdentity?.label}</span>
          {t("ssh.deleteIdentityAfter", { username: confirmDeleteIdentity?.username ?? "" })}
          {confirmDeleteIdentity && identityRefCount(confirmDeleteIdentity.id) > 0 && (
            <span className="text-err">
              {" "}
              {t("ssh.deleteIdentityRefused", { n: identityRefCount(confirmDeleteIdentity.id) })}
            </span>
          )}
        </p>
      </Modal>
    </section>
  );
}
