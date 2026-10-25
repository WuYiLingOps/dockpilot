import { useQuery } from "@tanstack/react-query";
import { openPath } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { Eraser, FolderOpen, PackagePlus, ScrollText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { openAppLogViewer } from "../../lib/applog";
import { formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSettings, useUpdateSettings } from "../../lib/settings";
import { Badge, Button, Modal, Select, Spinner, Switch } from "../ui";
import { Card, Row } from "./SettingsCard";

/** 上次退出状态行的展示值 */
function CrashBadge({
  info,
}: {
  info: { kind: "panic" | "abnormal"; timestamp: string | null } | null;
}) {
  const t = useT();
  if (!info) return <Badge tone="ok">{t("diag.lastCleanExit")}</Badge>;
  const when = info.timestamp ? new Date(info.timestamp).toLocaleString() : "";
  return (
    <span className="flex items-center gap-2">
      {when && <span className="text-[12px] text-fg3">{when}</span>}
      <Badge tone={info.kind === "panic" ? "err" : "warn"}>
        {info.kind === "panic" ? t("diag.panic") : t("diag.abnormalExit")}
      </Badge>
    </span>
  );
}

/** 设置页 · 故障诊断：上次异常退出状态、使用日志查看器入口、调试日志开关、日志目录与诊断包 */
export function DiagnosticsSettings() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const t = useT();
  const lastCrash = useQuery({
    queryKey: ["lastCrash"],
    queryFn: api.getLastCrash,
    staleTime: Infinity,
    retry: false,
  });
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  // 日志目录占用（清理后 refetch 刷新）
  const logFiles = useQuery({
    queryKey: ["appLogFiles"],
    queryFn: api.listLogFiles,
    staleTime: 60_000,
  });
  const logTotalSize = (logFiles.data ?? []).reduce((sum, f) => sum + f.size, 0);

  const last = lastCrash.data ?? null;
  const summary =
    last?.kind === "panic"
      ? `${last.location ?? t("app.crashUnknownLocation")}：${last.message ?? t("app.crashUnknownMessage")}`
      : undefined;

  const toggleDebugLogging = (v: boolean) => {
    // 后端即时切换级别并持久化；再走整包提交同步前端缓存
    void api
      .setDebugLogging(v)
      .then(() => {
        if (settings) update.mutate({ ...settings, debug_logging: v });
        toast.success(v ? t("diag.debugOn") : t("diag.debugOff"));
      })
      .catch((e) => toast.error(t("diag.debugToggleFailed", { err: String(e) })));
  };

  const openLogDir = async () => {
    try {
      await openPath(await api.getLogDir());
    } catch (e) {
      toast.error(t("diag.openLogDirFailed", { err: String(e) }));
    }
  };

  const runCleanup = async () => {
    setCleaning(true);
    try {
      const r = await api.cleanupAppLogs();
      if (r.removed === 0) {
        toast.info(t("diag.noExpiredLogs"));
      } else {
        toast.success(
          t("diag.logsCleaned", { n: r.removed, size: formatBytes(r.bytes) }),
        );
        void logFiles.refetch();
      }
    } catch (e) {
      toast.error(t("diag.logsCleanFailed", { err: String(e) }));
    } finally {
      setCleaning(false);
    }
  };

  const exportDiagnostics = async () => {
    if (exporting) return;
    try {
      const path = await save({
        title: t("diag.exportTitle"),
        defaultPath: `dockpilot-diagnostics-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.tar`,
        filters: [{ name: t("diag.bundleFilter"), extensions: ["tar"] }],
      });
      if (!path) return;
      setExporting(true);
      await api.exportDiagnostics(path);
      toast.success(t("diag.exportedTo", { path }));
      setExportOpen(false);
    } catch (e) {
      toast.error(t("diag.exportFailed", { err: String(e) }));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card title={t("settings.catDiagnostics")}>
      <Row
        label={t("diag.lastExitStatus")}
        desc={summary ?? t("diag.lastExitStatusDesc")}
      >
        <CrashBadge info={last} />
      </Row>
      <Row label={t("diag.usageLogs")} desc={t("diag.usageLogsDesc")}>
        <Button variant="outline" className="h-7" onClick={openAppLogViewer}>
          <ScrollText size={14} />
          {t("app.viewLogs")}
        </Button>
      </Row>
      <Row label={t("diag.openLogDir")} desc={t("diag.openLogDirDesc")}>
        <Button variant="outline" className="h-7" onClick={() => void openLogDir()}>
          <FolderOpen size={14} />
          {t("diag.openDir")}
        </Button>
      </Row>
      <Row
        label={t("diag.logCleanup")}
        desc={t("diag.logCleanupDesc", { size: formatBytes(logTotalSize) })}
      >
        <div className="flex items-center gap-2">
          <Select
            value={String(settings?.log_retention_days ?? 14)}
            className="w-32"
            onChange={(e) => {
              if (settings) update.mutate({ ...settings, log_retention_days: Number(e.target.value) });
            }}
          >
            <option value="7">{t("diag.retainDays", { n: 7 })}</option>
            <option value="14">{t("diag.retainDays", { n: 14 })}</option>
            <option value="30">{t("diag.retainDays", { n: 30 })}</option>
            <option value="90">{t("diag.retainDays", { n: 90 })}</option>
            <option value="0">{t("diag.retainForever")}</option>
          </Select>
          <Button variant="outline" className="h-7" disabled={cleaning} onClick={() => void runCleanup()}>
            {cleaning ? <Spinner className="h-3.5 w-3.5" /> : <Eraser size={13} />}
            {t("diag.cleanNow")}
          </Button>
        </div>
      </Row>
      <Row
        label={t("diag.debugLogging")}
        desc={t("diag.debugLoggingDesc")}
      >
        <Switch
          checked={settings?.debug_logging ?? false}
          onChange={(v) => toggleDebugLogging(v)}
        />
      </Row>
      <Row label={t("diag.exportRow")} desc={t("diag.exportRowDesc")}>
        <Button variant="outline" className="h-7" onClick={() => setExportOpen(true)}>
          <PackagePlus size={14} />
          {t("appLog.export")}
        </Button>
      </Row>

      <Modal
        open={exportOpen}
        title={t("diag.exportTitle")}
        onClose={() => setExportOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setExportOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={exporting} onClick={() => void exportDiagnostics()}>
              {exporting ? t("diag.exporting") : t("diag.chooseAndExport")}
            </Button>
          </>
        }
      >
        <p>{t("diag.bundleIntro")}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>{t("diag.bundleLogs")}</li>
          <li>{t("diag.bundleCrash")}</li>
          <li>{t("diag.bundleSystem")}</li>
        </ul>
        <p className="mt-2 text-warn">{t("diag.bundlePrivacy")}</p>
      </Modal>
    </Card>
  );
}
