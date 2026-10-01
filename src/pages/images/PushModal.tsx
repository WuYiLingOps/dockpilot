import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { useRegistries, useSaveRegistry } from "../../lib/registries";
import { shortId } from "../../lib/format";
import type { ImageDto } from "../../types/docker";
import { Button, Input, Modal, Select, Spinner } from "../../components/ui";
import { suggestPushTarget } from "./shared";

/** 推送镜像到 registry：选凭据 → 填目标仓库/标签 → 自动打标签并推送（进度流式展示） */
export function PushModal({ img, onClose }: { img: ImageDto; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: registries } = useRegistries();
  const saveRegistry = useSaveRegistry();
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const source = img.tags[0] || shortId(img.id);
  const suggest = useMemo(() => suggestPushTarget(source), [source]);
  const [registryId, setRegistryId] = useState("");
  const [repository, setRepository] = useState(suggest.repository);
  const [tag, setTag] = useState(suggest.tag);

  // 弹窗内快捷新建凭据
  const [quickAdd, setQuickAdd] = useState(false);
  const [quickDraft, setQuickDraft] = useState({
    kind: "aliyun" as "aliyun" | "harbor" | "generic",
    registry: "",
    username: "",
    password: "",
  });
  const [quickSaving, setQuickSaving] = useState(false);

  const list = registries ?? [];
  const selected = list.find((r) => r.id === registryId) ?? null;

  // 凭据列表就绪后默认选中第一个；确认没有凭据时自动展开快捷新建（加载中不动作）
  useEffect(() => {
    if (!registries) return;
    if (registries.length === 0) {
      setQuickAdd(true);
      return;
    }
    setRegistryId((prev) =>
      prev && registries.some((r) => r.id === prev) ? prev : registries[0].id,
    );
  }, [registries]);

  const saveQuick = async () => {
    if (!quickDraft.registry.trim() || !quickDraft.username.trim() || !quickDraft.password || quickSaving) {
      return;
    }
    setQuickSaving(true);
    try {
      const saved = await saveRegistry.mutateAsync({
        id: null,
        name: quickDraft.registry.split(":")[0],
        kind: quickDraft.kind,
        registry: quickDraft.registry,
        username: quickDraft.username,
        password: quickDraft.password,
        skip_tls_verify: false,
      });
      setRegistryId(saved.id);
      setQuickAdd(false);
      setQuickDraft({ kind: "aliyun", registry: "", username: "", password: "" });
    } catch {
      // 错误已由 useSaveRegistry 统一 toast
    } finally {
      setQuickSaving(false);
    }
  };

  const start = () => {
    if (running || !registryId || !repository.trim() || !tag.trim()) return;
    setRunning(true);
    setLines([`准备推送 ${repository.trim()}:${tag.trim()} …`]);
    cancelRef.current = api.pushImage(source, registryId, repository, tag, (p) => {
      if (p.status || p.progress) {
        const text = p.error ? `✗ ${p.error}` : [p.status, p.progress].filter(Boolean).join(" ");
        setLines((prev) => {
          const next = [...prev, text];
          return next.length > 300 ? next.slice(next.length - 300) : next;
        });
      }
      if (p.done) {
        setRunning(false);
        if (p.cancelled) {
          toast.info("推送已取消");
        } else if (p.error) {
          toast.error(p.error, { duration: 10000 });
        } else {
          toast.success(`已推送 ${repository.trim()}:${tag.trim()}`);
          void qc.invalidateQueries({ queryKey: ["images"] });
        }
      }
    });
  };

  const close = () => {
    if (running) cancelRef.current?.();
    cancelRef.current = null;
    setRunning(false);
    onClose();
  };

  // 推送输出区跟随滚动到底部
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <Modal
      open
      title="推送镜像"
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            {running ? "取消推送" : "关闭"}
          </Button>
          <Button
            variant="primary"
            disabled={running || !registryId || !repository.trim() || !tag.trim() || quickAdd}
            onClick={start}
          >
            {running ? "推送中…" : "开始推送"}
          </Button>
        </>
      }
    >
      <p className="mb-3">
        推送镜像 <span className="font-mono text-fg">{source}</span>，目标引用与本地不同时会自动打标签。
      </p>

      {list.length === 0 && !quickAdd ? (
        <div className="rounded-ctl border border-edge bg-panel2 p-2.5 text-[12px] text-fg3">
          还没有可用的仓库凭据，请先在下方新建（也可到 设置-镜像仓库 管理）
        </div>
      ) : (
        <label className="block">
          <span className="mb-1 block text-[12px] text-fg3">仓库凭据</span>
          <div className="flex gap-2">
            <Select
              value={registryId}
              onChange={(e) => setRegistryId(e.target.value)}
              className="min-w-0 flex-1"
              disabled={running || list.length === 0}
            >
              {list.length === 0 && <option value="">暂无凭据</option>}
              {list.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}（{r.registry}）
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              className="shrink-0"
              title="新建仓库凭据"
              onClick={() => setQuickAdd((v) => !v)}
              disabled={running}
            >
              <Plus size={13} />
              新建
            </Button>
          </div>
        </label>
      )}

      {quickAdd && (
        <div className="mt-3 space-y-2.5 rounded-ctl border border-edge bg-panel2/40 p-3">
          <div className="text-[12px] font-medium text-fg2">新建仓库凭据</div>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] text-fg3">类型</span>
              <Select
                value={quickDraft.kind}
                onChange={(e) =>
                  setQuickDraft({ ...quickDraft, kind: e.target.value as typeof quickDraft.kind })
                }
                className="w-full"
              >
                <option value="aliyun">阿里云 ACR</option>
                <option value="harbor">Harbor</option>
                <option value="generic">通用仓库</option>
              </Select>
            </label>
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] text-fg3">仓库地址</span>
              <Input
                value={quickDraft.registry}
                onChange={(e) => setQuickDraft({ ...quickDraft, registry: e.target.value })}
                placeholder="registry.cn-hangzhou.aliyuncs.com"
                className="w-full font-mono"
                spellCheck={false}
              />
            </label>
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] text-fg3">用户名</span>
              <Input
                value={quickDraft.username}
                onChange={(e) => setQuickDraft({ ...quickDraft, username: e.target.value })}
                className="w-full font-mono"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] text-fg3">密码 / 令牌</span>
              <Input
                type="password"
                value={quickDraft.password}
                onChange={(e) => setQuickDraft({ ...quickDraft, password: e.target.value })}
                className="w-full"
                autoComplete="new-password"
              />
            </label>
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={
                quickSaving ||
                !quickDraft.registry.trim() ||
                !quickDraft.username.trim() ||
                !quickDraft.password
              }
              onClick={() => void saveQuick()}
            >
              {quickSaving ? <Spinner className="h-3.5 w-3.5" /> : null}
              保存凭据
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_140px] gap-2.5">
        <label className="block min-w-0">
          <span className="mb-1 block text-[12px] text-fg3">仓库名（namespace/repo）</span>
          <Input
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder={selected?.kind === "aliyun" ? "命名空间/仓库（需提前创建命名空间）" : "project/app"}
            className="w-full font-mono"
            spellCheck={false}
            disabled={running}
          />
        </label>
        <label className="block min-w-0">
          <span className="mb-1 block text-[12px] text-fg3">标签</span>
          <Input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="latest"
            className="w-full font-mono"
            spellCheck={false}
            disabled={running}
          />
        </label>
      </div>
      {selected && (
        <div className="mt-1.5 break-all text-[11px] text-fg3">
          目标引用：<span className="font-mono">{selected.registry}/{repository.trim() || "…"}</span>
          :<span className="font-mono">{tag.trim() || "…"}</span>
        </div>
      )}

      {lines.length > 0 && (
        <div
          ref={boxRef}
          className="mt-3 h-44 overflow-auto rounded-ctl border border-edge bg-panel2 p-2.5 font-mono text-[11px] leading-4 text-fg2"
        >
          {lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {l}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
