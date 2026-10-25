import { useMemo, useState } from "react";
import { Database, Eraser } from "lucide-react";
import { formatBytes, rfc3339ToUnix, shortId, timeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { SystemDfDto } from "../../types/docker";
import {
  Badge,
  ErrorNote,
  SegmentedControl,
  Spinner,
} from "../../components/ui";
import { CHART_COLORS, Treemap } from "../../components/overview/Charts";
import { Panel, StatCell } from "./shared";

type UsageScope = "all" | "containers" | "images" | "volumes" | "cache";

const USAGE_SCOPES: { key: UsageScope; labelKey: "st.usageAll" | "st.usageImages" | "st.usageContainers" | "st.usageVolumes" | "st.usageCache" }[] = [
  { key: "all", labelKey: "st.usageAll" },
  { key: "images", labelKey: "st.usageImages" },
  { key: "containers", labelKey: "st.usageContainers" },
  { key: "volumes", labelKey: "st.usageVolumes" },
  { key: "cache", labelKey: "st.usageCache" },
];

export function UsageTab({
  dfd,
  dfError,
  onRetry,
}: {
  dfd: SystemDfDto | undefined;
  dfError: string | null;
  onRetry: () => void;
}) {
  const t = useT();
  const [scope, setScope] = useState<UsageScope>("all");

  const treemapItems = useMemo(() => {
    if (!dfd) return [];
    if (scope === "containers") return dfd.containers;
    if (scope === "images") return dfd.images;
    if (scope === "volumes") return dfd.volumes;
    if (scope === "cache")
      return dfd.build_cache.map((b) => ({
        name: b.description || shortId(b.id),
        size: b.size,
      }));
    return [...dfd.images, ...dfd.containers, ...dfd.volumes].sort(
      (a, b) => b.size - a.size,
    );
  }, [dfd, scope]);

  if (dfError) {
    return <ErrorNote message={dfError} onRetry={onRetry} />;
  }
  if (!dfd) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-3 overflow-auto p-4 pt-2">
      <Panel
        icon={Eraser}
        title={t("st.usageTitle")}
        extra={
          <SegmentedControl
            options={USAGE_SCOPES.map(({ key, labelKey }) => ({ key, label: t(labelKey) }))}
            value={scope}
            onChange={setScope}
          />
        }
      >
        <Treemap items={treemapItems} height={250} />
        <div className="mt-4 grid grid-cols-2 content-start gap-x-8 gap-y-5 sm:grid-cols-4">
          <StatCell
            label={t("st.usageImages")}
            value={formatBytes(dfd.images_size)}
            sub={t("st.nItems", { n: dfd.images_count })}
            color={CHART_COLORS[0]}
          />
          <StatCell
            label={t("st.usageContainers")}
            value={formatBytes(dfd.containers_size)}
            sub={t("st.nItems", { n: dfd.containers_count })}
            color={CHART_COLORS[1]}
          />
          <StatCell
            label={t("st.usageVolumes")}
            value={formatBytes(dfd.volumes_size)}
            sub={t("st.nItemsNoBind", { n: dfd.volumes_count })}
            color={CHART_COLORS[2]}
          />
          <StatCell
            label={t("st.usageCache")}
            value={formatBytes(dfd.build_cache_size)}
            sub={t("st.nEntries", { n: dfd.build_cache.length })}
            color={CHART_COLORS[3]}
          />
        </div>
      </Panel>

      <Panel
        icon={Database}
        title={t("st.cacheDetail")}
        extra={
          <span className="text-[11px] text-fg3">
            {t("st.cacheDetailTotal", {
              n: dfd.build_cache.length,
              size: formatBytes(dfd.build_cache_size),
            })}
          </span>
        }
      >
        {dfd.build_cache.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-fg3">{t("st.noCache")}</p>
        ) : (
          <div className="space-y-1">
            {dfd.build_cache.map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-3 rounded-btn px-2 py-1.5 transition-colors hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg2" title={b.description || b.id}>
                  {b.description || shortId(b.id)}
                </span>
                <Badge>{b.typ || "cache"}</Badge>
                {b.shared && <Badge tone="accent">{t("st.shared")}</Badge>}
                {b.in_use ? <Badge tone="ok">{t("st.inUse")}</Badge> : <Badge tone="warn">{t("st.unused")}</Badge>}
                <span className="w-16 shrink-0 text-right text-[11px] text-fg3">
                  {timeAgo(rfc3339ToUnix(b.created_at))}
                </span>
                <span className="w-20 shrink-0 text-right text-[12px] tabular-nums text-fg2">
                  {formatBytes(b.size)}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 border-t border-edge/60 pt-3 text-[11px] text-fg3">
          {t("st.cacheCleanupHint")}
        </div>
      </Panel>
    </div>
  );
}
