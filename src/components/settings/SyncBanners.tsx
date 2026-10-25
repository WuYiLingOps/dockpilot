/**
 * App 级云同步提示：空库恢复确认对话框 + 冲突/阻塞的浮动横幅。
 * 空库保护（方案 5.3 护栏 2）：本地为空但云端有数据时绝不静默覆盖云端，
 * 启动检查发现后弹出确认，用户可选"恢复云端"或"推送本地"。
 */

import { useCloudSyncState, useSyncActions } from "../../hooks/useCloudSync";
import { useT } from "../../lib/i18n";
import { Button } from "../ui";
import { TriangleAlert, Download, Upload } from "lucide-react";

/** 挂载在 App 根组件（设置页之外也能看到同步需要决策的状态） */
export function SyncBanners({ onManage }: { onManage: () => void }) {
  const state = useCloudSyncState();
  const actions = useSyncActions();
  const t = useT();

  if (state.emptyVaultPending) {
    const pending = state.emptyVaultPending.payload;
    // 数量清单按非零项拼接（中英各自的分隔符由词典提供）
    const summaryParts: string[] = [];
    if (pending.connections.length > 0) {
      summaryParts.push(
        t(pending.connections.length === 1 ? "syncBanner.connCountOne" : "syncBanner.connCount", {
          n: pending.connections.length,
        }),
      );
    }
    if (pending.registries.length > 0) {
      summaryParts.push(
        t(pending.registries.length === 1 ? "syncBanner.regCountOne" : "syncBanner.regCount", {
          n: pending.registries.length,
        }),
      );
    }
    const summary = summaryParts.join(t("syncBanner.listJoin"));

    return (
      <div className="fixed bottom-4 right-4 z-40 w-[380px] rounded-card border border-warn/30 bg-panel p-4 shadow-[var(--app-shadow)]" data-no-drag>
        <div className="flex items-start gap-2.5">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-fg">
              {t("syncBanner.cloudBackupFound")}
            </div>
            <p className="mt-1 text-[12px] leading-4 text-fg3">
              {t("syncBanner.emptyVaultDesc", { summary })}
            </p>
            <div className="mt-2.5 flex gap-2">
              <Button variant="primary" onClick={() => void actions.restoreEmptyVault()}>
                <Download size={13} />
                {t("syncBanner.restoreCloud")}
              </Button>
              <Button variant="outline" onClick={() => void actions.pushEmptyVault()}>
                <Upload size={13} />
                {t("syncBanner.pushLocal")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // GitHub 令牌失效：任何页面给一个可直达设置的横幅（云同步已整体暂停）
  if (state.connected && state.tokenInvalid) {
    return (
      <button
        type="button"
        onClick={onManage}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-card border border-err/30 bg-panel px-3.5 py-2.5 text-left shadow-[var(--app-shadow)] transition-colors hover:bg-hover"
        data-no-drag
      >
        <TriangleAlert size={16} className="shrink-0 text-err" />
        <span className="min-w-0 flex-1 text-[12px] leading-4 text-fg2">
          {t("syncBanner.tokenInvalid")}
        </span>
        <span className="shrink-0 text-[11px] text-accent">{t("syncBanner.goFix")}</span>
      </button>
    );
  }

  // 冲突 / 阻塞在设置页有完整横幅；其他页面给一个可直达的轻提示
  const needsDecision = state.syncState === "CONFLICT" || state.syncState === "BLOCKED";
  if (!needsDecision) return null;

  return (
    <button
      type="button"
      onClick={onManage}
      className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-card border border-warn/30 bg-panel px-3.5 py-2.5 text-left shadow-[var(--app-shadow)] transition-colors hover:bg-hover"
      data-no-drag
    >
      <TriangleAlert size={15} className="shrink-0 text-warn" />
      <span className="text-[12px] text-fg">
        {t("syncBanner.needsAttention", {
          reason:
            state.syncState === "CONFLICT"
              ? t("syncBanner.conflict")
              : t("syncBanner.blocked"),
        })}
      </span>
    </button>
  );
}
