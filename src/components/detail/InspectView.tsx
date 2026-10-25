import { useQuery } from "@tanstack/react-query";
import { Braces, Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import { Button, ErrorNote, SearchInput, Spinner } from "../ui";

/**
 * 原始 Inspect JSON 查看器（引擎原文，排障用）：
 * 支持关键字逐行过滤与一键复制。
 */
export function InspectView({ kind, id }: { kind: string; id: string }) {
  const query = useQuery({
    queryKey: ["inspect", kind, id],
    queryFn: () => api.inspectDocker(kind, id),
    staleTime: 30_000,
  });
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const t = useT();

  const text = useMemo(
    () => (query.data ? JSON.stringify(query.data, null, 2) : ""),
    [query.data],
  );
  const filtered = useMemo(() => {
    if (!filter.trim()) return text;
    const kw = filter.toLowerCase();
    return text
      .split("\n")
      .filter((l) => l.toLowerCase().includes(kw))
      .join("\n");
  }, [text, filter]);

  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success(t("inspect.copied"));
    } else {
      toast.error(t("common.copyFailed"));
    }
  };

  if (query.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  if (query.isError) {
    return <ErrorNote message={String(query.error)} onRetry={() => query.refetch()} />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2">
        <SearchInput
          value={filter}
          onChange={setFilter}
          placeholder={t("inspect.filterPlaceholder")}
        />
        <Button variant="outline" onClick={copy} disabled={!text}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {t("common.copy")}
        </Button>
        <Button variant="ghost" onClick={() => query.refetch()}>
          {t("common.refresh")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {filtered ? (
          <pre className="whitespace-pre font-mono text-[12px] leading-5 text-fg2">
            {filtered}
          </pre>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
            <Braces size={28} className="text-fg3/70" />
            <div className="text-[13px] font-medium text-fg2">{t("inspect.noMatch")}</div>
            <div className="text-xs text-fg3">{t("inspect.noMatchHint")}</div>
          </div>
        )}
      </div>
    </div>
  );
}
