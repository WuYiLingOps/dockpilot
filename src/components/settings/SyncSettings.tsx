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
import { formatLastSync, SYNC_CONSTANTS, type DeviceFlowStart, type SecurityState, type SyncState } from "../../types/sync";
import * as engine from "../../lib/sync/engine";
import { useCloudSyncState, useSyncActions } from "../../hooks/useCloudSync";

const SYNC_STATE_META: Record<SyncState, { label: string; tone: "neutral" | "accent" | "ok" | "warn" | "err" }> = {
  IDLE: { label: "就绪", tone: "neutral" },
  SYNCING: { label: "同步中", tone: "accent" },
  CONFLICT: { label: "冲突", tone: "warn" },
  BLOCKED: { label: "已暂停", tone: "err" },
  ERROR: { label: "错误", tone: "err" },
};

const SECURITY_STATE_META: Record<SecurityState, { label: string; tone: "neutral" | "accent" | "ok" | "warn" }> = {
  NO_KEY: { label: "未设密码", tone: "warn" },
  LOCKED: { label: "已锁定", tone: "neutral" },
  UNLOCKED: { label: "已解锁", tone: "ok" },
};

/** 设置页 · 云同步分组 */
export function SyncSettings() {
  const state = useCloudSyncState();
  const actions = useSyncActions();

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
      toast.success("已连接 GitHub");
      setAuthStart(null);
    } catch (error) {
      const err = error as Error;
      if (err?.name !== "AbortError") {
        setAuthError(err?.message ?? String(error));
        toast.error(`连接 GitHub 失败: ${err?.message ?? String(error)}`);
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
      toast.success("已断开 GitHub 连接");
    } catch (error) {
      toast.error(`断开失败: ${String(error)}`);
    }
  };

  const unlock = async () => {
    if (!unlockPassword) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const ok = await engine.unlock(unlockPassword);
      if (ok) {
        setUnlockPassword("");
      } else {
        setUnlockError("密码不正确");
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
        <div className="text-[13px] font-semibold text-fg">云同步</div>
        <span className="text-[11px] text-fg3">多台设备间加密同步配置（GitHub 私有 Gist）</span>
      </div>

      {/* 冲突横幅 */}
      {state.syncState === "CONFLICT" && state.conflict && (
        <div className="border-b border-warn/20 bg-warn/5 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-fg">云端数据无法用当前同步密码解密</div>
              <div className="mt-0.5 text-[11px] leading-4 text-fg3">
                云端版本 v{state.conflict.remoteVersion}（{state.conflict.remoteDeviceName ?? "其他设备"}），
                本机版本 v{state.conflict.localVersion}。两台设备的同步密码不同。
              </div>
              <div className="mt-2 flex gap-2" data-no-drag>
                <Button variant="outline" onClick={() => setConflictPasswordOpen(true)}>
                  <Download size={13} />
                  使用云端（输入云端密码）
                </Button>
                <Button variant="outline" onClick={() => void actions.resolveConflictLocal()}>
                  使用本地覆盖云端
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
              <div className="text-[13px] font-medium text-fg">同步已暂停：本次推送会删除过多数据</div>
              <div className="mt-0.5 text-[11px] leading-4 text-fg3">
                {state.shrinkFinding.entityType === "connections" ? "连接配置" : "镜像仓库"}从{" "}
                {state.shrinkFinding.baseCount} 条减少到 {state.shrinkFinding.outgoingCount} 条（丢失{" "}
                {state.shrinkFinding.lost} 条）。可能是本机数据异常，为保护云端已停止自动推送。
              </div>
              <div className="mt-2 flex gap-2" data-no-drag>
                <Button variant="outline" onClick={() => void actions.restoreBlockedRemote()}>
                  <Download size={13} />
                  恢复云端数据
                </Button>
                <Button variant="danger" onClick={() => void actions.forcePushBlockedLocal()}>
                  仍要推送本地
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
                  {state.account.name ?? state.account.login ?? state.account.id}（
                  {state.tokenBackend === "file" ? "令牌存加密文件" : "令牌存系统钥匙串"}）
                </div>
              ) : (
                <div className="text-[11px] text-fg3">未连接 —— 授权后配置将加密存入你的私有 Gist</div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5" data-no-drag>
            {connected ? (
              <>
                {state.gistId ? <Badge tone="ok">已连接</Badge> : <Badge tone="warn">未找到同步库</Badge>}
                <IconButton title="断开连接（清除本机令牌与同步快照）" onClick={() => void disconnect()}>
                  <Trash2 size={13} className="hover:text-err" />
                </IconButton>
              </>
            ) : (
              <Button variant="outline" onClick={() => void beginConnect()} disabled={authBusy}>
                {authBusy ? <Spinner className="h-3.5 w-3.5" /> : <Cloud size={13} />}
                连接 GitHub
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
              <div className="text-[13px] text-fg">同步密码</div>
              <div className="text-[11px] text-fg3">
                {state.securityState === "NO_KEY"
                  ? "用于加密云端数据，密码不保存在本机（遗忘后云端数据无法恢复）"
                  : state.securityState === "LOCKED"
                    ? "输入密码解锁后才能同步"
                    : "密码仅在本次运行内存中持有"}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2" data-no-drag>
            <Badge tone={SECURITY_STATE_META[state.securityState].tone}>
              {SECURITY_STATE_META[state.securityState].label}
            </Badge>
            {state.securityState === "NO_KEY" && (
              <Button variant="outline" onClick={() => setPasswordModal("set")}>
                设置密码
              </Button>
            )}
            {state.securityState === "LOCKED" && (
              <div className="flex items-center gap-1.5">
                <Input
                  type="password"
                  className="w-40"
                  placeholder="同步密码"
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
                  解锁
                </Button>
              </div>
            )}
            {unlocked && (
              <IconButton title="修改同步密码" onClick={() => setPasswordModal("change")}>
                <Pencil size={13} />
              </IconButton>
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
            <div className="text-[13px] text-fg">自动同步</div>
            <div className="mt-0.5 text-[11px] leading-4 text-fg3">
              配置变更 3 秒后自动上传；启动与窗口切回时自动检查云端更新
            </div>
          </div>
          <Switch
            checked={state.autoSync}
            disabled={!connected || !unlocked}
            title={connected && unlocked ? undefined : "需先连接 GitHub 并解锁同步密码"}
            onChange={(v) => engine.setAutoSync(v)}
          />
        </div>

        {/* 同步状态 */}
        <div className="flex min-h-13 items-center justify-between gap-4 px-4 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-fg">同步状态</span>
              <Badge tone={SYNC_STATE_META[state.syncState].tone}>{SYNC_STATE_META[state.syncState].label}</Badge>
              {state.lastSyncVersion != null && <Badge tone="neutral">v{state.lastSyncVersion}</Badge>}
            </div>
            <div className="mt-0.5 text-[11px] text-fg3">
              上次同步: {formatLastSync(state.lastSyncAt)}
              {state.lastError ? ` · ${state.lastError}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5" data-no-drag>
            <Button
              variant="outline"
              onClick={() => setHistoryOpen(true)}
              disabled={!connected || !unlocked || busy}
              title={connected && unlocked ? "浏览并恢复 Gist 修订历史" : "需先连接 GitHub 并解锁同步密码"}
            >
              <History size={13} />
              历史版本
            </Button>
            <Button
              variant="outline"
              onClick={() => void manualSync()}
              disabled={!connected || !unlocked || busy}
              title={!SYNC_CONSTANTS.GITHUB_CLIENT_ID ? "构建时未配置 GitHub client_id" : undefined}
            >
              <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
              立即同步
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
        title="连接 GitHub"
        onClose={cancelConnect}
        footer={
          <>
            <Button variant="outline" onClick={cancelConnect}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                void copyText(authStart?.userCode ?? "").then((ok) => {
                  if (ok) toast.success("已复制设备码");
                })
              }
            >
              复制设备码
            </Button>
          </>
        }
      >
        {authStart && (
          <div className="space-y-3">
            <p>1. 点击下方按钮打开 GitHub 授权页，输入设备码：</p>
            <div className="flex items-center justify-between gap-2 rounded-ctl border border-edge bg-panel2 px-3 py-2">
              <span className="font-mono text-[18px] font-semibold tracking-[0.2em] text-fg">{authStart.userCode}</span>
              <Button
                variant="outline"
                onClick={() => void openUrl(authStart.verificationUri).catch(() => {})}
              >
                打开 {authStart.verificationUri.replace("https://", "")}
                <ExternalLink size={12} />
              </Button>
            </div>
            <p className="text-[12px] text-fg3">2. 授权后本页会自动完成连接，请稍候…</p>
            {authBusy && (
              <div className="flex items-center gap-2 text-[12px] text-fg3">
                <Spinner className="h-3.5 w-3.5" />
                等待授权完成…
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
        setError(r.error ?? "解密失败");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="输入云端密码"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !password}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
            解密并恢复
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12px] leading-4 text-fg3">
          云端数据由另一台设备的同步密码加密。输入该密码以解密并恢复；
          恢复后本机的同步密码将被重置为云端密码。
        </p>
        <Input
          type="password"
          value={password}
          autoComplete="off"
          autoFocus
          placeholder="云端（另一台设备的）同步密码"
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
        setError("密码至少 6 位");
        return;
      }
      if (password !== confirm) {
        setError("两次输入的密码不一致");
        return;
      }
      setBusy(true);
      try {
        await engine.setMasterPassword(password);
        toast.success("同步密码已设置");
        onClose();
      } finally {
        setBusy(false);
      }
    } else {
      if (password.length < 6) {
        setError("新密码至少 6 位");
        return;
      }
      if (password !== confirm) {
        setError("两次输入的密码不一致");
        return;
      }
      setBusy(true);
      try {
        const ok = await engine.changePassword(oldPassword, password);
        if (!ok) {
          setError("当前密码不正确");
          return;
        }
        toast.success("同步密码已修改，云端数据将在下次配置变更时以新密码加密");
        onClose();
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <Modal
      open
      title={mode === "set" ? "设置同步密码" : "修改同步密码"}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
            {mode === "set" ? "设置" : "修改"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {mode === "change" && (
          <label className="block">
            <span className="mb-1 block text-[12px] text-fg3">当前密码</span>
            <Input
              type="password"
              value={oldPassword}
              autoComplete="off"
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-[12px] text-fg3">{mode === "set" ? "同步密码（至少 6 位）" : "新密码"}</span>
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-fg3">确认密码</span>
          <Input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <div className="rounded-ctl border border-edge bg-panel2 p-2.5 text-[11px] leading-4 text-fg3">
          云端只存密文（AES-256-GCM + PBKDF2）。密码不做任何保存——多台设备须使用相同密码；
          遗忘后云端数据将无法解密，只能删除同步 Gist 重来。
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
      {label}：
      {cur != null && (
        <>
          <span className={sel < cur ? "font-medium text-err" : ""}>{cur}</span>
          <span className="text-fg3"> → </span>
        </>
      )}
      {sel} 条
      {cur != null && sel < cur && <span className="text-err">（将减少 {cur - sel} 条）</span>}
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
      setPreviewError(r.error ?? "恢复失败");
    }
  };

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleString("zh-CN", { hour12: false });

  // 预览解密失败的修订不可恢复（密码不一致/数据损坏），按钮直接禁用
  const canRestore = !!preview && !previewLoading && !previewError && !restoring;

  return (
    <Modal
      open={open}
      title="历史版本"
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="danger"
            onClick={() => void doRestore()}
            disabled={!canRestore}
          >
            {restoring ? <Spinner className="h-3.5 w-3.5" /> : null}
            {pendingConfirm
              ? `确认恢复（覆盖当前 v${currentVersion ?? "?"}）`
              : "恢复此版本（覆盖当前配置）"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12px] leading-4 text-fg3">
          浏览并恢复 Gist 修订历史中的旧版配置数据。恢复是<strong className="text-fg">整体覆盖（不是合并）</strong>：本机与云端都会变成所选修订的内容，并作为新版本推送，不会改写修订历史。
        </p>

        {listError && (
          <div role="alert" className="rounded-ctl border border-err/20 bg-err/5 px-2.5 py-2 text-[12px] text-err">
            {listError}
          </div>
        )}

        {!entries && !listError && (
          <div className="flex items-center gap-2 py-4 text-[12px] text-fg3">
            <Spinner className="h-3.5 w-3.5" />
            正在获取修订历史…
          </div>
        )}

        {entries && entries.length === 0 && (
          <div className="py-4 text-center text-[12px] text-fg3">云端还没有修订历史</div>
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
                      {isCurrent ? "当前版本" : `修订 #${entries.length - i}`}
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
            正在解密该修订…
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
              恢复预览 —— 整体覆盖，不是合并
            </div>
            <div className="mt-1.5 space-y-0.5 text-[12px] leading-5 text-fg2">
              {cmpLine("连接配置", currentPreview?.connections, preview.connections)}
              {cmpLine("镜像仓库", currentPreview?.registries, preview.registries)}
              <div className="text-fg3">
                来源：版本 v{preview.version} · {preview.deviceName ?? "未知设备"}（{preview.appVersion}）· 数据时间{" "}
                {fmtTime(preview.updatedAt)}
              </div>
              <div className="text-fg3">
                恢复后本机与云端都变成该内容并作为新版本推送；被覆盖的内容可从修订历史再次恢复回来
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
