import { useQuery } from "@tanstack/react-query";
import { openPath } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { Eraser, FolderOpen, PackagePlus, ScrollText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { openAppLogViewer } from "../../lib/applog";
import { formatBytes } from "../../lib/format";
import { useSettings, useUpdateSettings } from "../../lib/settings";
import { Badge, Button, Modal, Select, Spinner, Switch } from "../ui";
import { Card, Row } from "./SettingsCard";

/** 上次退出状态行的展示值 */
function CrashBadge({
  info,
}: {
  info: { kind: "panic" | "abnormal"; timestamp: string | null } | null;
}) {
  if (!info) return <Badge tone="ok">上次正常退出</Badge>;
  const when = info.timestamp ? new Date(info.timestamp).toLocaleString() : "";
  return (
    <span className="flex items-center gap-2">
      {when && <span className="text-[12px] text-fg3">{when}</span>}
      <Badge tone={info.kind === "panic" ? "err" : "warn"}>
        {info.kind === "panic" ? "内部错误" : "未正常退出"}
      </Badge>
    </span>
  );
}

/** 设置页 · 故障诊断：上次异常退出状态、使用日志查看器入口、调试日志开关、日志目录与诊断包 */
export function DiagnosticsSettings() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
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
      ? `${last.location ?? "未知位置"}：${last.message ?? "未知错误"}`
      : undefined;

  const toggleDebugLogging = (v: boolean) => {
    // 后端即时切换级别并持久化；再走整包提交同步前端缓存
    void api
      .setDebugLogging(v)
      .then(() => {
        if (settings) update.mutate({ ...settings, debug_logging: v });
        toast.success(v ? "调试日志已开启" : "调试日志已关闭");
      })
      .catch((e) => toast.error(`切换调试日志失败: ${e}`));
  };

  const openLogDir = async () => {
    try {
      await openPath(await api.getLogDir());
    } catch (e) {
      toast.error(`打开日志目录失败: ${e}`);
    }
  };

  const runCleanup = async () => {
    setCleaning(true);
    try {
      const r = await api.cleanupAppLogs();
      if (r.removed === 0) {
        toast.info("没有超过保留期的日志文件");
      } else {
        toast.success(`已清理 ${r.removed} 个日志文件（${formatBytes(r.bytes)}）`);
        void logFiles.refetch();
      }
    } catch (e) {
      toast.error(`日志清理失败: ${e}`);
    } finally {
      setCleaning(false);
    }
  };

  const exportDiagnostics = async () => {
    if (exporting) return;
    try {
      const path = await save({
        title: "导出诊断包",
        defaultPath: `dockpilot-diagnostics-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.tar`,
        filters: [{ name: "诊断包", extensions: ["tar"] }],
      });
      if (!path) return;
      setExporting(true);
      const written = await api.exportDiagnostics(path);
      toast.success(`诊断包已导出到 ${written}`);
      setExportOpen(false);
    } catch (e) {
      toast.error(`导出诊断包失败: ${e}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card title="故障诊断">
      <Row
        label="上次退出状态"
        desc={summary ?? "异常退出后，下次启动时会在顶部提示；仅感知型退出（如断电、强制结束）无法归因"}
      >
        <CrashBadge info={last} />
      </Row>
      <Row label="使用日志" desc="浏览 DockPilot 自身的运行与操作日志（级别过滤、关键字搜索、导出）">
        <Button variant="outline" className="h-7" onClick={openAppLogViewer}>
          <ScrollText size={14} />
          查看日志
        </Button>
      </Row>
      <Row label="打开日志目录" desc="日志按会话分文件保存；历史归档超过保留期自动删除">
        <Button variant="outline" className="h-7" onClick={() => void openLogDir()}>
          <FolderOpen size={14} />
          打开目录
        </Button>
      </Row>
      <Row
        label="日志清理"
        desc={`历史日志占用 ${formatBytes(logTotalSize)}；超过保留期后启动/定时任务自动删除，当前会话日志不受影响`}
      >
        <div className="flex items-center gap-2">
          <Select
            value={String(settings?.log_retention_days ?? 14)}
            className="w-32"
            onChange={(e) => {
              if (settings) update.mutate({ ...settings, log_retention_days: Number(e.target.value) });
            }}
          >
            <option value="7">保留 7 天</option>
            <option value="14">保留 14 天</option>
            <option value="30">保留 30 天</option>
            <option value="90">保留 90 天</option>
            <option value="0">永久保留</option>
          </Select>
          <Button variant="outline" className="h-7" disabled={cleaning} onClick={() => void runCleanup()}>
            {cleaning ? <Spinner className="h-3.5 w-3.5" /> : <Eraser size={13} />}
            立即清理
          </Button>
        </div>
      </Row>
      <Row
        label="调试日志"
        desc="开启后记录 Debug 级别日志（立即生效），排查问题时使用，平时建议关闭"
      >
        <Switch
          checked={settings?.debug_logging ?? false}
          onChange={(v) => toggleDebugLogging(v)}
        />
      </Row>
      <Row label="导出诊断包" desc="打包最近日志、上次崩溃详情与系统信息（不含任何密码 / 私钥 / 令牌）">
        <Button variant="outline" className="h-7" onClick={() => setExportOpen(true)}>
          <PackagePlus size={14} />
          导出
        </Button>
      </Row>

      <Modal
        open={exportOpen}
        title="导出诊断包"
        onClose={() => setExportOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setExportOpen(false)}>
              取消
            </Button>
            <Button variant="primary" disabled={exporting} onClick={() => void exportDiagnostics()}>
              {exporting ? "正在导出…" : "选择位置并导出"}
            </Button>
          </>
        }
      >
        <p>诊断包（.tar）包含以下内容，请确认后随 Issue 反馈：</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>最近 3 个日志文件（含 SSH 主机地址等连接信息）</li>
          <li>上次崩溃详情（若存在）</li>
          <li>系统信息（版本 / 操作系统 / 架构）</li>
        </ul>
        <p className="mt-2 text-warn">
          不包含任何密码、私钥、令牌；如介意主机地址泄露，请导出前自行确认。
        </p>
      </Modal>
    </Card>
  );
}
