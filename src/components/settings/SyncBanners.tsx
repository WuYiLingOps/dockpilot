/**
 * App 级云同步提示：空库恢复确认对话框 + 冲突/阻塞的浮动横幅。
 * 空库保护（方案 5.3 护栏 2）：本地为空但云端有数据时绝不静默覆盖云端，
 * 启动检查发现后弹出确认，用户可选"恢复云端"或"推送本地"。
 */

import { useCloudSyncState, useSyncActions } from "../../hooks/useCloudSync";
import { Button } from "../ui";
import { TriangleAlert, Download, Upload } from "lucide-react";

/** 挂载在 App 根组件（设置页之外也能看到同步需要决策的状态） */
export function SyncBanners({ onManage }: { onManage: () => void }) {
  const state = useCloudSyncState();
  const actions = useSyncActions();

  if (state.emptyVaultPending) {
    return (
      <div className="fixed bottom-4 right-4 z-40 w-[380px] rounded-card border border-warn/30 bg-panel p-4 shadow-[var(--app-shadow)]" data-no-drag>
        <div className="flex items-start gap-2.5">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-fg">发现云端备份</div>
            <p className="mt-1 text-[12px] leading-4 text-fg3">
              本机没有连接与仓库数据，云端存在
              {state.emptyVaultPending.payload.connections.length > 0 &&
                ` ${state.emptyVaultPending.payload.connections.length} 条连接配置`}
              {state.emptyVaultPending.payload.connections.length > 0 &&
                state.emptyVaultPending.payload.registries.length > 0 &&
                "、"}
              {state.emptyVaultPending.payload.registries.length > 0 &&
                ` ${state.emptyVaultPending.payload.registries.length} 条仓库凭据信息`}
              （凭据密码保存在各设备本机，不会同步）。
              为防止误覆盖云端，请选择如何处理：
            </p>
            <div className="mt-2.5 flex gap-2">
              <Button variant="primary" onClick={() => void actions.restoreEmptyVault()}>
                <Download size={13} />
                恢复云端数据
              </Button>
              <Button variant="outline" onClick={() => void actions.pushEmptyVault()}>
                <Upload size={13} />
                推送本机数据
              </Button>
            </div>
          </div>
        </div>
      </div>
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
        云同步需要处理：{state.syncState === "CONFLICT" ? "云端数据与本机密码不一致" : "本次推送会删除过多数据，已暂停"}
      </span>
    </button>
  );
}
