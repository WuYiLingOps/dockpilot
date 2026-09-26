import { useState } from "react";
import { Boxes, Cloud, Container, Gauge, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import {
  useRegistries,
  useRemoveRegistry,
  useSaveRegistry,
} from "../../lib/registries";
import {
  REGISTRY_KINDS,
  registryKindLabel,
  secretBackendLabel,
  type RegistryKind,
  type RegistryProfile,
} from "../../types/settings";
import { Badge, Button, Checkbox, IconButton, Input, Modal, SegmentedControl, Select, Spinner } from "../ui";

/** 仓库类型图标（badge 色调：通用仓库中性） */
const KIND_META: Record<RegistryKind, { icon: typeof Cloud; tone: "accent" | "ok" | "neutral" }> = {
  aliyun: { icon: Cloud, tone: "accent" },
  harbor: { icon: Container, tone: "ok" },
  generic: { icon: Boxes, tone: "neutral" },
};

/** 阿里云个人版常见 region 预设（企业版/自定义域名走"自定义"输入） */
const ALIYUN_REGIONS: { value: string; label: string }[] = [
  { value: "registry.cn-hangzhou.aliyuncs.com", label: "华东1（杭州）" },
  { value: "registry.cn-shanghai.aliyuncs.com", label: "华东2（上海）" },
  { value: "registry.cn-qingdao.aliyuncs.com", label: "华北1（青岛）" },
  { value: "registry.cn-beijing.aliyuncs.com", label: "华北2（北京）" },
  { value: "registry.cn-zhangjiakou.aliyuncs.com", label: "华北3（张家口）" },
  { value: "registry.cn-huhehaote.aliyuncs.com", label: "华北5（呼和浩特）" },
  { value: "registry.cn-shenzhen.aliyuncs.com", label: "华南1（深圳）" },
  { value: "registry.cn-guangzhou.aliyuncs.com", label: "华南3（广州）" },
  { value: "registry.cn-chengdu.aliyuncs.com", label: "西南1（成都）" },
  { value: "registry.cn-hongkong.aliyuncs.com", label: "中国香港" },
  { value: "registry.ap-southeast-1.aliyuncs.com", label: "新加坡" },
  { value: "registry.us-west-1.aliyuncs.com", label: "硅谷" },
  { value: "registry.eu-central-1.aliyuncs.com", label: "法兰克福" },
];

/** 编辑弹窗草稿 */
interface Draft {
  id: string | null;
  name: string;
  kind: RegistryKind;
  registry: string;
  username: string;
  password: string;
  skip_tls_verify: boolean;
}

type TestState =
  | { status: "testing" }
  | { status: "ok"; ms: number; via_http: boolean }
  | { status: "fail"; error: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function emptyDraft(kind: RegistryKind = "aliyun"): Draft {
  return {
    id: null,
    name: "",
    kind,
    registry: "",
    username: "",
    password: "",
    skip_tls_verify: false,
  };
}

function draftFromProfile(p: RegistryProfile): Draft {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    registry: p.registry,
    username: p.username,
    password: "",
    skip_tls_verify: p.skip_tls_verify,
  };
}

function validateDraft(d: Draft, isNew: boolean): string | null {
  if (!d.name.trim()) return "请填写名称";
  if (!d.registry.trim()) return "请填写仓库地址";
  if (d.registry.includes("://") || d.registry.includes("/")) {
    return "仓库地址应为域名[:端口]，如 registry.cn-hangzhou.aliyuncs.com";
  }
  if (!d.username.trim()) return "请填写用户名";
  if (isNew && !d.password) return "请填写密码或访问令牌";
  return null;
}

/** 设置页 · 镜像仓库分组：推送用的 registry 凭据增删改与连通性测试 */
export function RegistrySettings() {
  const { data: registries } = useRegistries();
  const save = useSaveRegistry();
  const remove = useRemoveRegistry();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<RegistryProfile | null>(null);
  const [testing, setTesting] = useState<Record<string, TestState>>({});

  if (!registries) return null;

  const saveDraft = async () => {
    if (!draft) return;
    const err = validateDraft(draft, draft.id === null);
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    try {
      await save.mutateAsync({
        id: draft.id,
        name: draft.name,
        kind: draft.kind,
        registry: draft.registry,
        username: draft.username,
        password: draft.password,
        skip_tls_verify: draft.skip_tls_verify,
      });
      setDraft(null);
    } catch {
      // 错误已由 useSaveRegistry 统一 toast
    } finally {
      setSaving(false);
    }
  };

  const testRow = async (p: RegistryProfile) => {
    if (testing[p.id]?.status === "testing") return;
    setTesting((t) => ({ ...t, [p.id]: { status: "testing" } }));
    try {
      const r = await api.testRegistry(p.id);
      setTesting((t) =>
        r.ok
          ? { ...t, [p.id]: { status: "ok", ms: r.latency_ms, via_http: r.via_http } }
          : { ...t, [p.id]: { status: "fail", error: r.error || "测试失败" } },
      );
      if (!r.ok) toast.error(`测试「${p.name}」失败: ${(r.error || "测试失败").split("\n")[0]}`);
      else if (r.via_http) toast.info("仓库经 HTTP 可达：推送需在 daemon.json 配置 insecure-registries");
    } catch (e) {
      const message = errorMessage(e);
      setTesting((t) => ({ ...t, [p.id]: { status: "fail", error: message } }));
      toast.error(`测试「${p.name}」失败: ${message}`);
    }
  };

  const draftTest = draft?.id ? testing[draft.id] : undefined;

  return (
    <section className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
      <div className="flex items-center justify-between border-b border-edge/60 bg-panel2/40 px-4 py-2.5">
        <div className="text-[13px] font-semibold text-fg">镜像仓库</div>
        <span className="text-[11px] text-fg3">推送镜像到私有仓库（阿里云 ACR / Harbor 等）</span>
      </div>

      {registries.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-fg3">
          还没有配置仓库凭据，添加后即可在镜像页推送镜像
        </div>
      ) : (
        <div className="divide-y divide-edge/60">
          {registries.map((r) => {
            const meta = KIND_META[r.kind] ?? KIND_META.generic;
            const Icon = meta.icon;
            const t = testing[r.id];
            return (
              <div key={r.id} className="group flex items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-hover">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl bg-panel2 text-fg3">
                  <Icon size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13px] text-fg">
                    <span className="truncate">{r.name}</span>
                    {r.secret_backend === "file" && (
                      <span
                        title="系统钥匙串不可用，密码已加密存入本机绑定文件（换机/重装系统后需重新录入）"
                        className="cursor-help text-fg3"
                      >
                        <KeyRound size={11} />
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11px] text-fg3" title={`${r.username}@${r.registry}`}>
                    {r.username}@{r.registry}
                  </div>
                </div>
                <Badge tone={meta.tone}>{registryKindLabel(r.kind)}</Badge>
                <span className="hidden text-[11px] text-fg3 xl:inline">
                  {secretBackendLabel(r.secret_backend)}
                </span>
                {t?.status === "testing" && <Spinner className="h-3.5 w-3.5" />}
                {t?.status === "ok" && (
                  <Badge tone={t.ms < 300 ? "ok" : t.ms < 1000 ? "warn" : "neutral"}>
                    {t.ms} ms{t.via_http ? " · HTTP" : ""}
                  </Badge>
                )}
                {t?.status === "fail" && (
                  <span title={t.error}>
                    <Badge tone="err">失败</Badge>
                  </span>
                )}
                <div
                  data-no-drag
                  className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <IconButton title="测试连接" onClick={() => void testRow(r)}>
                    <Gauge size={13} />
                  </IconButton>
                  <IconButton title="编辑" onClick={() => setDraft(draftFromProfile(r))}>
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    title="删除"
                    className="hover:bg-err/10 hover:text-err"
                    onClick={() => setConfirmDelete(r)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-[11px] text-fg3">
          密码保存在本机：优先系统钥匙串，无钥匙串时加密存入本机文件；点击列表项可测试连通性
        </span>
        <Button variant="outline" className="shrink-0" onClick={() => setDraft(emptyDraft())}>
          <Plus size={13} />
          添加仓库
        </Button>
      </div>

      {/* 添加 / 编辑凭据 */}
      <Modal
        open={draft !== null}
        title={draft?.id ? "编辑仓库凭据" : "添加仓库凭据"}
        onClose={() => setDraft(null)}
        size="lg"
        footer={
          <>
            <div className="flex-1" />
            <Button variant="outline" onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void saveDraft()} disabled={saving || !draft}>
              {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
              {draft?.id ? "保存" : "添加"}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3.5">
            <div>
              <div className="mb-1.5 text-[12px] text-fg3">仓库类型</div>
              <SegmentedControl
                options={REGISTRY_KINDS}
                value={draft.kind}
                onChange={(k) => setDraft({ ...draft, kind: k })}
              />
            </div>

            {draft.kind === "aliyun" && (
              <label className="block">
                <span className="mb-1 block text-[12px] text-fg3">地域预设（可选）</span>
                <Select
                  value={ALIYUN_REGIONS.some((r) => r.value === draft.registry) ? draft.registry : "custom"}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v !== "custom") setDraft({ ...draft, registry: v });
                  }}
                  className="w-full"
                >
                  {ALIYUN_REGIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}（{r.value}）
                    </option>
                  ))}
                  <option value="custom">自定义地址…</option>
                </Select>
              </label>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-1 block min-w-0">
                <span className="mb-1 block text-[12px] text-fg3">名称</span>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={draft.kind === "aliyun" ? "阿里云杭州" : draft.kind === "harbor" ? "内网 Harbor" : "我的仓库"}
                  className="w-full"
                  spellCheck={false}
                />
              </label>
              <label className="col-span-1 block min-w-0">
                <span className="mb-1 block text-[12px] text-fg3">仓库地址</span>
                <Input
                  value={draft.registry}
                  onChange={(e) => setDraft({ ...draft, registry: e.target.value })}
                  placeholder={draft.kind === "harbor" ? "harbor.example.com" : "registry.example.com"}
                  className="w-full font-mono"
                  spellCheck={false}
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-1 block min-w-0">
                <span className="mb-1 block text-[12px] text-fg3">用户名</span>
                <Input
                  value={draft.username}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                  placeholder={draft.kind === "harbor" ? "user 或 robot$project+bot" : "登录账号"}
                  className="w-full font-mono"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="col-span-1 block min-w-0">
                <span className="mb-1 block text-[12px] text-fg3">密码 / 访问令牌</span>
                <Input
                  type="password"
                  value={draft.password}
                  onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                  placeholder={draft.id ? "留空表示不修改" : "密码或固定密码（个人版在凭证管理设置）"}
                  className="w-full"
                  autoComplete="new-password"
                />
              </label>
            </div>

            <div className="rounded-ctl border border-edge bg-panel2 p-2.5 text-[11px] leading-4 text-fg3">
              {draft.kind === "aliyun" &&
                "阿里云容器镜像服务（个人版免费）：用户名即阿里云登录账号（可在镜像服务控制台确认），密码建议在「访问凭证管理」中设置固定密码；命名空间需提前创建。"}
              {draft.kind === "harbor" &&
                "Harbor：可用普通账号或机器人账户（robot$项目+名称），账号需对目标项目有推送权限且项目已存在；自签名证书时勾选下方跳过校验以便测试。"}
              {draft.kind === "generic" &&
                "任何 Docker Registry v2 兼容仓库（Distribution、Nexus、Quay 等）。"}
            </div>

            <Checkbox
              label="测试连接时跳过 TLS 证书校验（自签名证书用，仅作用于测试，不影响推送）"
              checked={draft.skip_tls_verify}
              onChange={(v) => setDraft({ ...draft, skip_tls_verify: v })}
            />

            {draftTest?.status === "ok" && (
              <div role="status" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-ctl border border-ok/20 bg-ok/5 px-2.5 py-2 text-[12px]">
                <Badge tone="ok">凭据有效</Badge>
                <span className="shrink-0 tabular-nums text-fg2">{draftTest.ms} ms</span>
                {draftTest.via_http && <Badge tone="warn">经 HTTP 访问</Badge>}
              </div>
            )}
            {draftTest?.status === "fail" && (
              <div
                role="alert"
                className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-ctl border border-err/20 bg-err/5 px-2.5 py-2 text-[12px] leading-4 text-err"
              >
                {draftTest.error || "测试失败"}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={confirmDelete !== null}
        title="删除仓库凭据"
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (confirmDelete) remove.mutate(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p>
          将删除仓库「<span className="font-semibold text-fg">{confirmDelete?.name}</span>」的凭据，
          并同时清除本机保存的密码（{confirmDelete ? secretBackendLabel(confirmDelete.secret_backend) : ""}）。
        </p>
      </Modal>
    </section>
  );
}
