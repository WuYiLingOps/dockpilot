/**
 * 设置页 · 云同步卡片：GitHub 连接（Device Flow）、同步密码（设/解锁/修改）、
 * 自动同步开关、同步状态与手动同步、冲突/阻塞横幅。
 * 空库恢复对话框挂载在 App 级（SyncBanners），保证任意页面可见。
 */

import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Cloud, Download, ExternalLink, History, KeyRound, Lock, Pencil, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { cn, Badge, Button, IconButton, Input, Modal, Spinner, Switch } from "../ui";
import { copyText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import type { MsgKey } from "../../lib/i18n/zh";
import { formatLastSync, SYNC_CONSTANTS, type DeviceFlowStart, type SecurityState, type SyncEntityType, type SyncState } from "../../types/sync";
import { useSettings, useUpdateSettings } from "../../lib/settings";
import * as engine from "../../lib/sync/engine";
import { useCloudSyncState, useSyncActions } from "../../hooks/useCloudSync";

const SYNC_STATE_META: Record<SyncState, { labelKey: MsgKey; tone: "neutral" | "accent" | "ok" | "warn" | "err" }> = {
  IDLE: { labelKey: "sync.stateIdle", tone: "neutral" },
  SYNCING: { labelKey: "sync.stateSyncing", tone: "accent" },
  CONFLICT: { labelKey: "sync.stateConflict", tone: "warn" },
  BLOCKED: { labelKey: "sync.stateBlocked", tone: "err" },
  ERROR: { labelKey: "sync.stateError", tone: "err" },
};

const SECURITY_STATE_META: Record<SecurityState, { labelKey: MsgKey; tone: "neutral" | "accent" | "ok" | "warn" }> = {
  NO_KEY: { labelKey: "sync.securityNoKey", tone: "warn" },
  LOCKED: { labelKey: "sync.securityLocked", tone: "neutral" },
  UNLOCKED: { labelKey: "sync.securityUnlocked", tone: "ok" },
};

/** 收缩护栏横幅的实体显示名 */
const SHRINK_ENTITY_KEY: Record<SyncEntityType, MsgKey> = {
  connections: "sync.entityConnections",
  registries: "sync.entityRegistries",
  ssh_keys: "sync.entitySshKeys",
  ssh_identities: "sync.entitySshIdentities",
};

/** 设置页 · 云同步分组 */
export function SyncSettings() {
  const state = useCloudSyncState();
  const actions = useSyncActions();
  const t = useT();
  const { data: settings } = useSettings();
  const update = useUpdateSettings();

  const [authStart, setAuthStart] = useState<DeviceFlowStart | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const [passwordModal, setPasswordModal] = useState<"set" | "change" | null>(null);
  /** 冲突"使用云端"需输入云端（另一台设备的）密码 */
  const [conflictPasswordOpen, setConflictPasswordOpen] = useState(false);
  /** 历史版本浏览与恢复 */
  const [historyOpen, setHistoryOpen] = useState(false);

  const connected = state.connected;
  const unlocked = state.securityState === "UNLOCKED";
  const busy = state.syncing;

  // 组件卸载时取消进行中的 Device Flow 轮询
  useEffect(() => () => abortRef.current?.abort(), []);

  const beginConnect = async () => {
    setAuthError(null);
    setAuthBusy(true);
    try {
      const start = await engine.startDeviceFlow();
      setAuthStart(start);
      const controller = new AbortController();
      abortRef.current = controller;
      await engine.completeGitHubAuth(start, {}, controller.signal);
      toast.success(t("sync.githubConnected"));
      setAuthStart(null);
    } catch (error) {
      const err = error as Error;
      if (err?.name !== "AbortError") {
        setAuthError(err?.message ?? String(error));
        toast.error(
          t("sync.githubConnectFailed", { err: err?.message ?? String(error) }),
        );
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const cancelConnect = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setAuthStart(null);
    setAuthBusy(false);
  };

  const disconnect = async () => {
    try {
      await engine.disconnectGitHub();
      toast.success(t("sync.githubDisconnected"));
    } catch (error) {
      toast.error(t("sync.disconnectFailed", { err: String(error) }));
    }
  };

  const unlock = async () => {
    if (!unlockPassword) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      // 解锁成功后自动记住密码（钥匙串/加密文件），下次启动自动解锁
      const ok = await engine.unlockAndRemember(unlockPassword);
      if (ok) {
        setUnlockPassword("");
      } else {
        setUnlockError(t("sync.wrongPassword"));
      }
    } finally {
      setUnlocking(false);
    }
  };

  const manualSync = async () => {
    await actions.manualSync();
  };

  return (
    <section className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
      <div className="flex items-center justify-between border-b border-edge/60 bg-panel2/40 px-4 py-2.5">
        <div className="text-[13px] font-semibold text-fg">{t("sync.title")}</div>
        <span className="text-[11px] text-fg3">{t("sync.sectionDesc")}</span>
      </div>

      {/* 冲突横幅 */}
      {state.syncState === "CONFLICT" && state.conflict && (
        <div className="border-b border-warn/20 bg-warn/5 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-fg">{t("sync.conflictTitle")}</div>
              <div className="mt-0.5 text-[11px] leading-4 text-fg3">
                {t("sync.conflictDesc", {
                  remoteVersion: state.conflict.remoteVersion,
                  device: state.conflict.remoteDeviceName ?? t("sync.otherDevice"),
                  localVersion: state.conflict.localVersion,
                })}
              </div>
              <div className="mt-2 flex gap-2" data-no-drag>
                <Button variant="outline" onClick={() => setConflictPasswordOpen(true)}>
                  <Download size={13} />
                  {t("sync.useRemote")}
                </Button>
                <Button variant="outline" onClick={() => void actions.resolveConflictLocal()}>
                  {t("sync.useLocal")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 收缩阻塞横幅 */}
      {state.syncState === "BLOCKED" && state.shrinkFinding?.suspicious && (
        <div className="border-b border-err/20 bg-err/5 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-err" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-fg">{t("sync.shrinkTitle")}</div>
              <div className="mt-0.5 text-[11px] leading-4 text-fg3">
                {t("sync.shrinkDesc", {
                  entity: t(SHRINK_ENTITY_KEY[state.shrinkFinding.entityType]),
                  base: state.shrinkFinding.baseCount,
                  outgoing: state.shrinkFinding.outgoingCount,
                  lost: state.shrinkFinding.lost,
                })}
              </div>
              <div className="mt-2 flex gap-2" data-no-drag>
                <Button variant="outline" onClick={() => void actions.restoreBlockedRemote()}>
                  <Download size={13} />
                  {t("syncBanner.restoreCloud")}
                </Button>
                <Button variant="danger" onClick={() => void actions.forcePushBlockedLocal()}>
                  {t("sync.forcePushLocal")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="divide-y divide-edge/60">
        {/* GitHub 连接 */}
        <div className="flex min-h-13 items-center justify-between gap-4 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
              <Cloud size={14} />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] text-fg">GitHub Gist</div>
              {connected && state.account ? (
                <div className="truncate text-[11px] text-fg3">
                  {state.tokenInvalid
                    ? t("sync.tokenInvalidDesc")
                    : t("sync.accountWithTokenBackend", {
                        account: state.account.name ?? state.account.login ?? state.account.id,
                        backend:
                          state.tokenBackend === "file"
                            ? t("sync.tokenInFile")
                            : t("sync.tokenInKeychain"),
                      })}
                </div>
              ) : (
                <div className="text-[11px] text-fg3">{t("sync.notConnectedDesc")}</div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5" data-no-drag>
            {connected ? (
              <>
                {state.tokenInvalid ? (
                  <Badge tone="err">{t("sync.tokenInvalid")}</Badge>
                ) : state.gistId ? (
                  <Badge tone="ok">{t("sync.connectedBadge")}</Badge>
                ) : (
                  <Badge tone="warn">{t("sync.gistMissing")}</Badge>
                )}
                {state.tokenInvalid && (
                  <Button
                    variant="outline"
                    onClick={() => void beginConnect()}
                    disabled={authBusy}
                    title={t("sync.reconnectTitle")}
                  >
                    {authBusy ? <Spinner className="h-3.5 w-3.5" /> : <Cloud size={13} />}
                    {t("sync.reconnectGithub")}
                  </Button>
                )}
                <IconButton
                  title={t("sync.disconnectTitle")}
                  onClick={() => void disconnect()}
                >
                  <Trash2 size={13} className="hover:text-err" />
                </IconButton>
              </>
            ) : (
              <Button variant="outline" onClick={() => void beginConnect()} disabled={authBusy}>
                {authBusy ? <Spinner className="h-3.5 w-3.5" /> : <Cloud size={13} />}
                {t("sync.connectGithub")}
              </Button>
            )}
          </div>
        </div>

        {/* 同步密码 */}
        <div className="flex min-h-13 items-center justify-between gap-4 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
              <KeyRound size={14} />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] text-fg">{t("sync.passwordTitle")}</div>
              <div className="text-[11px] text-fg3">
                {state.securityState === "NO_KEY"
                  ? t("sync.passwordDescNoKey")
                  : state.securityState === "LOCKED"
                    ? t("sync.passwordDescLocked")
                    : t("sync.passwordDescUnlocked")}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2" data-no-drag>
            <Badge tone={SECURITY_STATE_META[state.securityState].tone}>
              {t(SECURITY_STATE_META[state.securityState].labelKey)}
            </Badge>
            {state.securityState === "NO_KEY" && (
              <Button variant="outline" onClick={() => setPasswordModal("set")}>
                {t("sync.setPassword")}
              </Button>
            )}
            {state.securityState === "LOCKED" && (
              <div className="flex items-center gap-1.5">
                <Input
                  type="password"
                  className="w-40"
                  placeholder={t("sync.passwordTitle")}
                  value={unlockPassword}
                  autoComplete="off"
                  onChange={(e) => {
                    setUnlockPassword(e.target.value);
                    setUnlockError(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && void unlock()}
                />
                <Button variant="primary" onClick={() => void unlock()} disabled={unlocking || !unlockPassword}>
                  {unlocking ? <Spinner className="h-3.5 w-3.5" /> : <Lock size={13} />}
                  {t("sync.unlock")}
                </Button>
              </div>
            )}
            {unlocked && (
              <>
                <IconButton title={t("sync.changePasswordTitle")} onClick={() => setPasswordModal("change")}>
                  <Pencil size={13} />
                </IconButton>
                <IconButton
                  title={t("sync.lockTitle")}
                  onClick={() => {
                    engine.lock();
                    toast.success(t("sync.lockedToast"));
                  }}
                >
                  <Lock size={13} />
                </IconButton>
              </>
            )}
          </div>
        </div>
        {unlockError && (
          <div className="bg-err/5 px-4 py-1.5 text-[11px] text-err" role="alert">
            {unlockError}
          </div>
        )}

        {/* 自动同步开关 */}
        <div className="flex min-h-13 items-center justify-between gap-4 px-4 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] text-fg">{t("sync.autoSync")}</div>
            <div className="mt-0.5 text-[11px] leading-4 text-fg3">
              {t("sync.autoSyncDesc")}
            </div>
          </div>
          <Switch
            checked={state.autoSync}
            disabled={!connected || !unlocked}
            title={connected && unlocked ? undefined : t("sync.requiresSetup")}
            onChange={(v) => engine.setAutoSync(v)}
          />
        </div>

        {/* SSH 凭证同步开关（AppSettings 标量，随同步载荷跨设备保持一致） */}
        <div className="flex min-h-13 items-center justify-between gap-4 px-4 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] text-fg">{t("sync.syncSshCredentials")}</div>
            <div className="mt-0.5 text-[11px] leading-4 text-fg3">
              {t("sync.syncSshCredentialsDesc")}
            </div>
          </div>
          <Switch
            checked={settings?.sync_credentials ?? true}
            disabled={!connected || !unlocked}
            title={connected && unlocked ? undefined : t("sync.requiresSetup")}
            onChange={(v) => {
              if (settings) update.mutate({ ...settings, sync_credentials: v });
            }}
          />
        </div>

        {/* 同步状态 */}
        <div className="flex min-h-13 items-center justify-between gap-4 px-4 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-fg">{t("sync.statusTitle")}</span>
              <Badge tone={SYNC_STATE_META[state.syncState].tone}>
                {t(SYNC_STATE_META[state.syncState].labelKey)}
              </Badge>
              {state.lastSyncVersion != null && <Badge tone="neutral">v{state.lastSyncVersion}</Badge>}
            </div>
            <div className="mt-0.5 text-[11px] text-fg3">
              {t("sync.lastSync", { time: formatLastSync(state.lastSyncAt) })}
              {state.lastError ? ` · ${state.lastError}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5" data-no-drag>
            <Button
              variant="outline"
              onClick={() => setHistoryOpen(true)}
              disabled={!connected || !unlocked || busy}
              title={
                connected && unlocked ? t("sync.historyTitle") : t("sync.requiresSetup")
              }
            >
              <History size={13} />
              {t("sync.history")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void manualSync()}
              disabled={!connected || !unlocked || busy}
              title={!SYNC_CONSTANTS.GITHUB_CLIENT_ID ? t("sync.noClientId") : undefined}
            >
              <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
              {t("sync.syncNow")}
            </Button>
          </div>
        </div>
      </div>

      {/* 历史版本浏览与恢复 */}
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestore={actions.restoreRevision}
        currentVersion={state.lastSyncVersion}
      />

      {/* Device Flow 授权弹窗 */}
      <Modal
        open={authStart !== null}
        title={t("sync.connectGithub")}
        onClose={cancelConnect}
        footer={
          <>
            <Button variant="outline" onClick={cancelConnect}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                void copyText(authStart?.userCode ?? "").then((ok) => {
                  if (ok) toast.success(t("sync.deviceCodeCopied"));
                })
              }
            >
              {t("sync.copyDeviceCode")}
            </Button>
          </>
        }
      >
        {authStart && (
          <div className="space-y-3">
            <p>{t("sync.deviceFlowStep1")}</p>
            <div className="flex items-center justify-between gap-2 rounded-ctl border border-edge bg-panel2 px-3 py-2">
              <span className="font-mono text-[18px] font-semibold tracking-[0.2em] text-fg">{authStart.userCode}</span>
              <Button
                variant="outline"
                onClick={() => void openUrl(authStart.verificationUri).catch(() => {})}
              >
                {t("sync.openUrl", { url: authStart.verificationUri.replace("https://", "") })}
                <ExternalLink size={12} />
              </Button>
            </div>
            <p className="text-[12px] text-fg3">{t("sync.deviceFlowStep2")}</p>
            {authBusy && (
              <div className="flex items-center gap-2 text-[12px] text-fg3">
                <Spinner className="h-3.5 w-3.5" />
                {t("sync.waitingAuth")}
              </div>
            )}
            {authError && (
              <div role="alert" className="rounded-ctl border border-err/20 bg-err/5 px-2.5 py-2 text-[12px] text-err">
                {authError}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 设置 / 修改同步密码 */}
      <PasswordModal mode={passwordModal} onClose={() => setPasswordModal(null)} />

      {/* 冲突恢复：输入云端密码 */}
      <ConflictPasswordModal
        open={conflictPasswordOpen}
        onClose={() => setConflictPasswordOpen(false)}
        onSubmit={actions.resolveConflictRemote}
      />
    </section>
  );
}

/** 冲突"使用云端"弹窗：远端由另一台设备的密码加密，验证通过后本机同步密码将被重置为云端密码 */
function ConflictPasswordModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (password: string) => Promise<{ success: boolean; error?: string }>;
}) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword("");
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onSubmit(password);
      if (r.success) {
        onClose();
      } else {
        setError(r.error ?? t("sync.decryptFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={t("sync.remotePasswordTitle")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !password}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
            {t("sync.decryptAndRestore")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12px] leading-4 text-fg3">{t("sync.remotePasswordDesc")}</p>
        <Input
          type="password"
          value={password}
          autoComplete="off"
          autoFocus
          placeholder={t("sync.remotePasswordPlaceholder")}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
        {error && (
          <div role="alert" className="rounded-ctl border border-err/20 bg-err/5 px-2.5 py-2 text-[12px] text-err">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 设置（首次）与修改同步密码弹窗 */
function PasswordModal({ mode, onClose }: { mode: "set" | "change" | null; onClose: () => void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode) {
      setPassword("");
      setConfirm("");
      setOldPassword("");
      setError(null);
    }
  }, [mode]);

  if (!mode) return null;

  const submit = async () => {
    setError(null);
    if (mode === "set") {
      if (password.length < 6) {
        setError(t("sync.passwordMinLength"));
        return;
      }
      if (password !== confirm) {
        setError(t("sync.passwordMismatch"));
        return;
      }
      setBusy(true);
      try {
        await engine.setMasterPassword(password);
        toast.success(t("sync.passwordSet"));
        onClose();
      } finally {
        setBusy(false);
      }
    } else {
      if (password.length < 6) {
        setError(t("sync.newPasswordMinLength"));
        return;
      }
      if (password !== confirm) {
        setError(t("sync.passwordMismatch"));
        return;
      }
      setBusy(true);
      try {
        const ok = await engine.changePassword(oldPassword, password);
        if (!ok) {
          setError(t("sync.currentPasswordWrong"));
          return;
        }
        toast.success(t("sync.passwordChanged"));
        onClose();
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <Modal
      open
      title={mode === "set" ? t("sync.setPasswordTitle") : t("sync.changePasswordModalTitle")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
            {mode === "set" ? t("st.create") : t("sync.modify")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {mode === "change" && (
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg3">{t("sync.currentPassword")}</span>
            <Input
              type="password"
              value={oldPassword}
              autoComplete="off"
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-[12px] text-fg3">
            {mode === "set" ? t("sync.newPasswordLabel") : t("sync.newPasswordShort")}
          </span>
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-fg3">{t("sync.confirmPassword")}</span>
          <Input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <div className="rounded-ctl border border-edge bg-panel2 p-2.5 text-[11px] leading-4 text-fg3">
          {t("sync.passwordNote")}
        </div>
        {error && (
          <div role="alert" className="rounded-ctl border border-err/20 bg-err/5 px-2.5 py-2 text-[12px] text-err">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * 历史版本浏览与恢复弹窗：列出 Gist 修订历史（首条为云端当前内容），
 * 点选旧修订后解密预览，两步确认后恢复——旧数据应用回本机并作为新版本推送。
 */
function HistoryModal({
  open,
  onClose,
  onRestore,
  currentVersion,
}: {
  open: boolean;
  onClose: () => void;
  onRestore: (sha: string) => Promise<{ success: boolean; error?: string }>;
  currentVersion: number | null;
}) {
  const t = useT();
  const [entries, setEntries] = useState<Array<{ sha: string; date: number }> | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [preview, setPreview] = useState<engine.RevisionPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [restoring, setRestoring] = useState(false);
  /** 当前云端内容（修订历史首条）的预览，用于恢复前的前后对比 */
  const [currentPreview, setCurrentPreview] = useState<engine.RevisionPreview | null>(null);

  useEffect(() => {
    if (!open) return;
    setEntries(null);
    setListError(null);
    setSelectedSha(null);
    setPreview(null);
    setPreviewError(null);
    setPendingConfirm(false);
    setCurrentPreview(null);
    engine
      .fetchHistory()
      .then(async (list) => {
        setEntries(list);
        // 首条即云端当前内容：解密出条数用于恢复前对比（解密失败则不展示对比列）
        if (list.length > 0) {
          await engine
            .previewRevision(list[0].sha)
            .then(setCurrentPreview)
            .catch(() => setCurrentPreview(null));
        }
      })
      .catch((e) => setListError(e instanceof Error ? e.message : String(e)));
  }, [open]);

  /** 数量对比行：当前 → 所选；减少时红色高亮提示内容将被移除 */
  const cmpLine = (label: string, cur: number | undefined, sel: number) => (
    <div>
      {label}
      {t("sync.cmpColon")}
      {cur != null && (
        <>
          <span className={sel < cur ? "font-medium text-err" : ""}>{cur}</span>
          <span className="text-fg3"> → </span>
        </>
      )}
      {t("sync.nEntries", { n: sel })}
      {cur != null && sel < cur && t("sync.cmpDecrease", { n: cur - sel })}
    </div>
  );

  const selectRevision = async (sha: string) => {
    if (sha === selectedSha) return;
    setSelectedSha(sha);
    setPreview(null);
    setPreviewError(null);
    setPendingConfirm(false);
    setPreviewLoading(true);
    try {
      setPreview(await engine.previewRevision(sha));
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewLoading(false);
    }
  };

  const doRestore = async () => {
    if (!selectedSha) return;
    // 两步确认：首次点击只进入确认态，防止误触覆盖当前配置
    if (!pendingConfirm) {
      setPendingConfirm(true);
      return;
    }
    setRestoring(true);
    const r = await onRestore(selectedSha);
    setRestoring(false);
    if (r.success) {
      onClose();
    } else {
      setPendingConfirm(false);
      setPreviewError(r.error ?? t("sync.restoreFailed"));
    }
  };

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleString("zh-CN", { hour12: false });

  // 预览解密失败的修订不可恢复（密码不一致/数据损坏），按钮直接禁用
  const canRestore = !!preview && !previewLoading && !previewError && !restoring;

  return (
    <Modal
      open={open}
      title={t("sync.history")}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            variant="danger"
            onClick={() => void doRestore()}
            disabled={!canRestore}
          >
            {restoring ? <Spinner className="h-3.5 w-3.5" /> : null}
            {pendingConfirm
              ? t("sync.restoreConfirm", { version: currentVersion ?? "?" })
              : t("sync.restoreButton")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12px] leading-4 text-fg3">
          {t("sync.historyDescBefore")}
          <strong className="text-fg">{t("sync.historyDescStrong")}</strong>
          {t("sync.historyDescAfter")}
        </p>

        {listError && (
          <div role="alert" className="rounded-ctl border border-err/20 bg-err/5 px-2.5 py-2 text-[12px] text-err">
            {listError}
          </div>
        )}

        {!entries && !listError && (
          <div className="flex items-center gap-2 py-4 text-[12px] text-fg3">
            <Spinner className="h-3.5 w-3.5" />
            {t("sync.fetchingHistory")}
          </div>
        )}

        {entries && entries.length === 0 && (
          <div className="py-4 text-center text-[12px] text-fg3">{t("sync.noHistory")}</div>
        )}

        {entries && entries.length > 0 && (
          <div className="max-h-64 space-y-1.5 overflow-auto pr-0.5">
            {entries.map((e, i) => {
              const isCurrent = i === 0;
              const selected = selectedSha === e.sha;
              return (
                <button
                  key={e.sha}
                  type="button"
                  disabled={isCurrent}
                  onClick={() => void selectRevision(e.sha)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-ctl border px-3 py-2 text-left transition-colors",
                    isCurrent
                      ? "cursor-default border-accent/30 bg-accent/5"
                      : selected
                        ? "border-accent/60 bg-accent/5"
                        : "border-edge bg-panel hover:bg-hover",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] text-fg">
                      {isCurrent ? t("sync.currentVersion") : t("sync.revisionNo", { n: entries.length - i })}
                      {isCurrent && currentVersion != null && (
                        <Badge tone="neutral">v{currentVersion}</Badge>
                      )}
                    </span>
                    <span className="block text-[11px] text-fg3">{fmtTime(e.date)}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-fg3" title={e.sha}>
                    {e.sha.slice(0, 7)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* 所选修订的预览 */}
        {previewLoading && (
          <div className="flex items-center gap-2 text-[12px] text-fg3">
            <Spinner className="h-3.5 w-3.5" />
            {t("sync.decryptingRevision")}
          </div>
        )}
        {previewError && (
          <div role="alert" className="rounded-ctl border border-err/20 bg-err/5 px-2.5 py-2 text-[12px] text-err">
            {previewError}
          </div>
        )}
        {preview && (
          <div className="rounded-ctl border border-warn/30 bg-warn/5 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-warn">
              <TriangleAlert size={13} />
              {t("sync.restorePreviewTitle")}
            </div>
            <div className="mt-1.5 space-y-0.5 text-[12px] leading-5 text-fg2">
              {cmpLine(t("sync.entityConnections"), currentPreview?.connections, preview.connections)}
              {cmpLine(t("sync.entityRegistries"), currentPreview?.registries, preview.registries)}
              <div className="text-fg3">
                {t("sync.previewSource", {
                  version: preview.version,
                  device: preview.deviceName ?? t("sync.unknownDevice"),
                  appVersion: preview.appVersion ?? "",
                  time: fmtTime(preview.updatedAt),
                })}
              </div>
              <div className="text-fg3">{t("sync.restoreNote")}</div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
