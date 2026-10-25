import { useState } from "react";
import { Boxes, Cloud, Container, Gauge, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { t, useT } from "../../lib/i18n";
import type { MsgKey } from "../../lib/i18n/zh";
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
const ALIYUN_REGIONS: { value: string; labelKey: MsgKey }[] = [
  { value: "registry.cn-hangzhou.aliyuncs.com", labelKey: "reg.regionHangzhou" },
  { value: "registry.cn-shanghai.aliyuncs.com", labelKey: "reg.regionShanghai" },
  { value: "registry.cn-qingdao.aliyuncs.com", labelKey: "reg.regionQingdao" },
  { value: "registry.cn-beijing.aliyuncs.com", labelKey: "reg.regionBeijing" },
  { value: "registry.cn-zhangjiakou.aliyuncs.com", labelKey: "reg.regionZhangjiakou" },
  { value: "registry.cn-huhehaote.aliyuncs.com", labelKey: "reg.regionHohhot" },
  { value: "registry.cn-shenzhen.aliyuncs.com", labelKey: "reg.regionShenzhen" },
  { value: "registry.cn-guangzhou.aliyuncs.com", labelKey: "reg.regionGuangzhou" },
  { value: "registry.cn-chengdu.aliyuncs.com", labelKey: "reg.regionChengdu" },
  { value: "registry.cn-hongkong.aliyuncs.com", labelKey: "reg.regionHongkong" },
  { value: "registry.ap-southeast-1.aliyuncs.com", labelKey: "reg.regionSingapore" },
  { value: "registry.us-west-1.aliyuncs.com", labelKey: "reg.regionSiliconValley" },
  { value: "registry.eu-central-1.aliyuncs.com", labelKey: "reg.regionFrankfurt" },
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
  if (!d.name.trim()) return t("reg.nameRequired");
  if (!d.registry.trim()) return t("reg.registryRequired");
  if (d.registry.includes("://") || d.registry.includes("/")) {
    return t("reg.registryFormat");
  }
  if (!d.username.trim()) return t("reg.usernameRequired");
  if (isNew && !d.password) return t("reg.passwordRequired");
  return null;
}

/** 设置页 · 镜像仓库分组：推送用的 registry 凭据增删改与连通性测试 */
export function RegistrySettings() {
  const t = useT();
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
      setTesting((prev) =>
        r.ok
          ? { ...prev, [p.id]: { status: "ok", ms: r.latency_ms, via_http: r.via_http } }
          : { ...prev, [p.id]: { status: "fail", error: r.error || t("reg.testFailed") } },
      );
      if (!r.ok)
        toast.error(
          t("reg.testFailedNamed", {
            name: p.name,
            err: (r.error || t("reg.testFailed")).split("\n")[0],
          }),
        );
      else if (r.via_http) toast.info(t("reg.viaHttpHint"));
    } catch (e) {
      const message = errorMessage(e);
      setTesting((prev) => ({ ...prev, [p.id]: { status: "fail", error: message } }));
      toast.error(t("reg.testFailedNamed", { name: p.name, err: message }));
    }
  };

  const draftTest = draft?.id ? testing[draft.id] : undefined;

  return (
    <section className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
      <div className="flex items-center justify-between border-b border-edge/60 bg-panel2/40 px-4 py-2.5">
        <div className="text-[13px] font-semibold text-fg">{t("settings.catRegistries")}</div>
        <span className="text-[11px] text-fg3">{t("reg.sectionDesc")}</span>
      </div>

      {registries.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-fg3">
          {t("reg.empty")}
        </div>
      ) : (
        <div className="divide-y divide-edge/60">
          {registries.map((r) => {
            const meta = KIND_META[r.kind] ?? KIND_META.generic;
            const Icon = meta.icon;
            const ts = testing[r.id];
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
                        title={t("reg.fileBackendNote")}
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
                {ts?.status === "testing" && <Spinner className="h-3.5 w-3.5" />}
                {ts?.status === "ok" && (
                  <Badge tone={ts.ms < 300 ? "ok" : ts.ms < 1000 ? "warn" : "neutral"}>
                    {ts.ms} ms{ts.via_http ? " · HTTP" : ""}
                  </Badge>
                )}
                {ts?.status === "fail" && (
                  <span title={ts.error}>
                    <Badge tone="err">{t("push.rowFailedBadge")}</Badge>
                  </span>
                )}
                <div
                  data-no-drag
                  className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <IconButton title={t("reg.testConnection")} onClick={() => void testRow(r)}>
                    <Gauge size={13} />
                  </IconButton>
                  <IconButton title={t("reg.edit")} onClick={() => setDraft(draftFromProfile(r))}>
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    title={t("containers.actRemove")}
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
        <span className="text-[11px] text-fg3">{t("reg.storageHint")}</span>
        <Button variant="outline" className="shrink-0" onClick={() => setDraft(emptyDraft())}>
          <Plus size={13} />
          {t("reg.addRegistry")}
        </Button>
      </div>

      {/* 添加 / 编辑凭据 */}
      <Modal
        open={draft !== null}
        title={draft?.id ? t("reg.editTitle") : t("reg.addTitle")}
        onClose={() => setDraft(null)}
        size="lg"
        footer={
          <>
            <div className="flex-1" />
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void saveDraft()} disabled={saving || !draft}>
              {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
              {draft?.id ? t("common.save") : t("img.add")}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3.5">
            <div>
              <div className="mb-1.5 text-[12px] text-fg3">{t("reg.kindLabel")}</div>
              <SegmentedControl
                options={REGISTRY_KINDS.map(({ key }) => ({
                  key,
                  label: registryKindLabel(key),
                }))}
                value={draft.kind}
                onChange={(k) => setDraft({ ...draft, kind: k })}
              />
            </div>

            {draft.kind === "aliyun" && (
              <label className="block">
                <span className="mb-1 block text-[12px] text-fg3">{t("reg.regionPreset")}</span>
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
                      {t(r.labelKey)}（{r.value}）
                    </option>
                  ))}
                  <option value="custom">{t("reg.customAddress")}</option>
                </Select>
              </label>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-1 block min-w-0">
                <span className="mb-1 block text-[12px] text-fg3">{t("st.name")}</span>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={
                    draft.kind === "aliyun"
                      ? t("reg.namePhAliyun")
                      : draft.kind === "harbor"
                        ? t("reg.namePhHarbor")
                        : t("reg.namePhGeneric")
                  }
                  className="w-full"
                  spellCheck={false}
                />
              </label>
              <label className="col-span-1 block min-w-0">
                <span className="mb-1 block text-[12px] text-fg3">{t("reg.registryLabel")}</span>
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
                <span className="mb-1 block text-[12px] text-fg3">{t("push.username")}</span>
                <Input
                  value={draft.username}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                  placeholder={draft.kind === "harbor" ? "user / robot$project+bot" : t("reg.usernamePh")}
                  className="w-full font-mono"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="col-span-1 block min-w-0">
                <span className="mb-1 block text-[12px] text-fg3">{t("push.password")}</span>
                <Input
                  type="password"
                  value={draft.password}
                  onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                  placeholder={draft.id ? t("reg.passwordKeep") : t("reg.passwordPh")}
                  className="w-full"
                  autoComplete="new-password"
                />
              </label>
            </div>

            <div className="rounded-ctl border border-edge bg-panel2 p-2.5 text-[11px] leading-4 text-fg3">
              {draft.kind === "aliyun" && t("reg.kindHelpAliyun")}
              {draft.kind === "harbor" && t("reg.kindHelpHarbor")}
              {draft.kind === "generic" && t("reg.kindHelpGeneric")}
            </div>

            <Checkbox
              label={t("reg.skipTls")}
              checked={draft.skip_tls_verify}
              onChange={(v) => setDraft({ ...draft, skip_tls_verify: v })}
            />

            {draftTest?.status === "ok" && (
              <div role="status" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-ctl border border-ok/20 bg-ok/5 px-2.5 py-2 text-[12px]">
                <Badge tone="ok">{t("reg.credentialValid")}</Badge>
                <span className="shrink-0 tabular-nums text-fg2">{draftTest.ms} ms</span>
                {draftTest.via_http && <Badge tone="warn">{t("reg.viaHttp")}</Badge>}
              </div>
            )}
            {draftTest?.status === "fail" && (
              <div
                role="alert"
                className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-ctl border border-err/20 bg-err/5 px-2.5 py-2 text-[12px] leading-4 text-err"
              >
                {draftTest.error || t("reg.testFailed")}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={confirmDelete !== null}
        title={t("reg.deleteTitle")}
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (confirmDelete) remove.mutate(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              {t("containers.actRemove")}
            </Button>
          </>
        }
      >
        <p>
          {t("reg.deleteConfirmBefore")}
          <span className="font-semibold text-fg">{confirmDelete?.name}</span>
          {t("reg.deleteConfirmAfter", {
            backend: confirmDelete ? secretBackendLabel(confirmDelete.secret_backend) : "",
          })}
        </p>
      </Modal>
    </section>
  );
}
