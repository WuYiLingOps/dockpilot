import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  Copy,
  Download,
  FileText,
  Hammer,
  Pause,
  Pencil,
  Play,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import { copyText } from "../lib/clipboard";
import { useComposeRun } from "../hooks/useComposeRun";
import { projectState } from "./Compose";
import { OutputPanel } from "../components/compose/OutputPanel";
import { withDragRegion } from "../lib/drag";
import {
  Button,
  Checkbox,
  ErrorNote,
  IconButton,
  Modal,
  PortChips,
  Select,
  Spinner,
  StateBadge,
  StatusDot,
} from "../components/ui";

type ActionOpts = { removeVolumes?: boolean; removeImages?: boolean; services?: string[] };

const GRID =
  "grid grid-cols-[104px_minmax(130px,0.9fr)_minmax(150px,1.2fr)_minmax(120px,1fr)_88px] items-center gap-x-3";

export function ComposeDetail({
  project,
  onBack,
  onOpenContainer,
}: {
  project: string;
  onBack: () => void;
  onOpenContainer: (id: string) => void;
}) {
  const { data: settings } = useSettings();
  const run = useComposeRun();

  const query = useQuery({
    queryKey: ["composeProjects"],
    queryFn: api.listComposeProjects,
    refetchInterval: (settings?.containers_refresh_secs ?? 10) * 1000,
  });
  const cli = useQuery({
    queryKey: ["composeCli"],
    queryFn: api.composeCliInfo,
    staleTime: 30_000,
  });
  const p = query.data?.find((x) => x.name === project);
  const cliReady = cli.data?.available === true;

  const [downOpen, setDownOpen] = useState(false);
  const [downVolumes, setDownVolumes] = useState(false);
  const [downImages, setDownImages] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlIndex, setYamlIndex] = useState(0);
  const [yamlEditing, setYamlEditing] = useState(false);
  const [yamlDraft, setYamlDraft] = useState("");

  const yamlPath = p?.config_files[yamlIndex];
  const yamlContent = useQuery({
    queryKey: ["composeFile", yamlPath],
    queryFn: () => api.readComposeFile(yamlPath!),
    enabled: yamlOpen && !!yamlPath,
  });

  // 项目被外部 down 掉后自动返回列表
  useEffect(() => {
    if (!query.isLoading && !p) onBack();
  }, [query.isLoading, p, onBack]);

  const yamlDirty = yamlEditing && yamlDraft !== yamlContent.data;
  const saveYaml = useMutation({
    mutationFn: () => api.writeComposeFile(yamlPath!, yamlDraft),
    onSuccess: () => {
      toast.success("compose 文件已保存（原文件已备份为 .bak）", {
        action: {
          label: "重新应用",
          onClick: () => act("up", "重新应用"),
        },
      });
      setYamlEditing(false);
      void yamlContent.refetch();
    },
    onError: (e) => toast.error(`保存失败: ${e}`),
  });

  const act = (action: string, label: string, opts: ActionOpts = {}) =>
    run.start((o) => api.composeAction(project, action, opts, o), {
      label: `${label}项目 ${project}`,
    });

  const needCli = cliReady ? undefined : "需要安装 Docker Compose CLI";

  return (
    <>
      <div
        {...withDragRegion()}
        className="flex h-12 shrink-0 items-center gap-2.5 border-b border-edge bg-panel px-3 pr-[8.5rem]"
      >
        <IconButton title="返回项目列表" onClick={onBack} data-no-drag>
          <ChevronLeft size={17} />
        </IconButton>
        {p ? (
          <>
            <h1 className="truncate text-[15px] font-semibold text-fg">{p.name}</h1>
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg2">
              <StatusDot state={projectState(p)} />
              {p.running_count}/{p.total_count} 运行
            </span>
            <span
              className="hidden min-w-0 truncate font-mono text-[11px] text-fg3 lg:inline"
              title={`${p.working_dir}\n${p.config_files.join("\n")}`}
            >
              {p.working_dir}
            </span>
          </>
        ) : (
          <Spinner className="h-4 w-4" />
        )}
        <div className="ml-auto flex items-center gap-1" data-no-drag>
          <Button
            variant="tinted"
            disabled={!cliReady || run.running}
            title={needCli}
            onClick={() => act("up", "启动")}
          >
            <Play size={14} />
            启动
          </Button>
          <IconButton title={needCli ?? "停止全部服务"} disabled={!cliReady || run.running} onClick={() => act("stop", "停止")}>
            <Square size={15} />
          </IconButton>
          <IconButton title={needCli ?? "重启全部服务"} disabled={!cliReady || run.running} onClick={() => act("restart", "重启")}>
            <RotateCw size={15} />
          </IconButton>
          <IconButton title={needCli ?? "构建镜像"} disabled={!cliReady || run.running} onClick={() => act("build", "构建")}>
            <Hammer size={15} />
          </IconButton>
          <IconButton title={needCli ?? "拉取镜像"} disabled={!cliReady || run.running} onClick={() => act("pull", "拉取镜像")}>
            <Download size={15} />
          </IconButton>
          <IconButton
            title={needCli ?? "下线项目（停止并删除容器）"}
            disabled={!cliReady || run.running}
            className="hover:bg-err/10 hover:text-err"
            onClick={() => setDownOpen(true)}
          >
            <Trash2 size={15} />
          </IconButton>
          <span className="mx-1 h-4 w-px bg-edge" />
          <IconButton title="查看 compose 配置" onClick={() => { setYamlIndex(0); setYamlOpen(true); }}>
            <FileText size={15} />
          </IconButton>
        </div>
      </div>

      {query.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : query.isError ? (
        <ErrorNote message={String(query.error)} onRetry={() => void query.refetch()} />
      ) : p ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto p-4 pt-3">
            <div className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
              <div
                className={`${GRID} h-8 border-b border-edge bg-panel2/60 px-4 text-[11px] font-medium text-fg3`}
              >
                <div>状态</div>
                <div>服务</div>
                <div>镜像</div>
                <div>端口</div>
                <div />
              </div>
              {p.services.map((s) => (
                <div
                  key={s.container_id}
                  onClick={() => onOpenContainer(s.container_id)}
                  className={`${GRID} group cursor-pointer border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-hover`}
                >
                  <div title={s.status}>
                    <div className="flex items-center gap-1.5 text-[12px] text-fg2">
                      <StateBadge state={s.state} />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-fg">{s.name}</div>
                    <div className="truncate font-mono text-[11px] text-fg3">
                      {s.container_id.slice(0, 12)}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[12px] text-fg2" title={s.image}>
                      {s.image}
                    </div>
                  </div>
                  <PortChips ports={s.ports} />
                  <div
                    className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                    data-no-drag
                  >
                    {(s.state === "exited" || s.state === "created" || s.state === "dead") && (
                      <IconButton
                        title={needCli ?? "启动服务"}
                        disabled={!cliReady || run.running}
                        onClick={() => act("start", "启动服务", { services: [s.name] })}
                      >
                        <Play size={14} />
                      </IconButton>
                    )}
                    {s.state === "running" && (
                      <>
                        <IconButton
                          title={needCli ?? "停止服务"}
                          disabled={!cliReady || run.running}
                          onClick={() => act("stop", "停止服务", { services: [s.name] })}
                        >
                          <Square size={14} />
                        </IconButton>
                        <IconButton
                          title={needCli ?? "重启服务"}
                          disabled={!cliReady || run.running}
                          onClick={() => act("restart", "重启服务", { services: [s.name] })}
                        >
                          <RotateCw size={14} />
                        </IconButton>
                        <IconButton
                          title={needCli ?? "暂停服务"}
                          disabled={!cliReady || run.running}
                          onClick={() => act("pause", "暂停服务", { services: [s.name] })}
                        >
                          <Pause size={14} />
                        </IconButton>
                      </>
                    )}
                    {s.state === "paused" && (
                      <IconButton
                        title={needCli ?? "恢复服务"}
                        disabled={!cliReady || run.running}
                        onClick={() => act("unpause", "恢复服务", { services: [s.name] })}
                      >
                        <Play size={14} />
                      </IconButton>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {(run.running || run.lines.length > 0) && (
            <div className="shrink-0 px-4 pb-4">
              <OutputPanel
                label={run.label}
                lines={run.lines}
                running={run.running}
                result={run.result}
                onCancel={run.stop}
                onClose={run.clear}
              />
            </div>
          )}
        </div>
      ) : null}

      {/* 下线确认 */}
      <Modal
        open={downOpen}
        title="下线项目"
        onClose={() => setDownOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setDownOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDownOpen(false);
                act("down", "下线", { removeVolumes: downVolumes, removeImages: downImages });
              }}
            >
              确认下线
            </Button>
          </>
        }
      >
        <p>
          确定下线项目 <span className="font-mono text-fg">{project}</span> 吗？
          将停止并删除该项目创建的所有容器与默认网络。
        </p>
        <div className="mt-2.5 space-y-1.5">
          <Checkbox
            label="同时删除数据卷（--volumes，数据将不可恢复）"
            checked={downVolumes}
            onChange={setDownVolumes}
          />
          <Checkbox
            label="同时删除项目本地构建的镜像（--rmi local）"
            checked={downImages}
            onChange={setDownImages}
          />
        </div>
      </Modal>

      {/* compose 配置查看 / 编辑 */}
      <Modal
        open={yamlOpen}
        title="compose 配置"
        size="lg"
        onClose={() => {
          setYamlEditing(false);
          setYamlOpen(false);
        }}
        footer={
          yamlEditing ? (
            <>
              <span className="mr-auto self-center text-[11px] text-fg3">
                保存前会自动校验语法并备份原文件（Ctrl+S 保存）
              </span>
              <Button
                variant="outline"
                onClick={() => {
                  setYamlEditing(false);
                  setYamlDraft("");
                }}
              >
                取消
              </Button>
              <Button
                variant="primary"
                disabled={!yamlDirty || saveYaml.isPending}
                onClick={() => saveYaml.mutate()}
              >
                {saveYaml.isPending ? "保存中…" : "保存"}
              </Button>
            </>
          ) : undefined
        }
      >
        {p && p.config_files.length > 1 && !yamlEditing && (
          <Select
            value={yamlIndex}
            onChange={(e) => setYamlIndex(Number(e.target.value))}
            className="mb-2"
          >
            {p.config_files.map((f, i) => (
              <option key={f} value={i}>
                {f}
              </option>
            ))}
          </Select>
        )}
        {yamlPath && (
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-[11px] text-fg3" title={yamlPath}>
              {yamlPath}
            </span>
            {yamlEditing ? (
              <span className="shrink-0 text-[11px] text-fg3">
                {yamlDirty ? "有未保存的修改" : "内容未变化"}
              </span>
            ) : (
              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton
                  title="编辑此文件"
                  disabled={yamlContent.isLoading || yamlContent.isError}
                  onClick={() => {
                    setYamlDraft(yamlContent.data ?? "");
                    setYamlEditing(true);
                  }}
                >
                  <Pencil size={14} />
                </IconButton>
                {yamlContent.data && (
                  <IconButton title="复制内容" onClick={() => void copyText(yamlContent.data!)}>
                    <Copy size={14} />
                  </IconButton>
                )}
              </div>
            )}
          </div>
        )}
        {yamlContent.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner className="h-5 w-5" />
          </div>
        ) : yamlContent.isError ? (
          <div className="break-all text-[12px] text-err">{String(yamlContent.error)}</div>
        ) : yamlEditing ? (
          <textarea
            value={yamlDraft}
            onChange={(e) => setYamlDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                if (yamlDirty && !saveYaml.isPending) saveYaml.mutate();
              }
            }}
            spellCheck={false}
            autoFocus
            className="h-[50vh] w-full resize-y rounded-ctl border border-edge-strong bg-canvas p-3 font-mono text-[11.5px] leading-5 text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/25"
          />
        ) : (
          <pre className="max-h-80 overflow-auto rounded-ctl bg-canvas p-3 font-mono text-[11.5px] leading-5 text-fg2">
            {yamlContent.data}
          </pre>
        )}
      </Modal>
    </>
  );
}
