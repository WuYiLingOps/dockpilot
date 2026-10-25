import { Network, Trash2 } from "lucide-react";
import { shortId } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { NetworkDto } from "../../types/docker";
import { Badge, EmptyState, IconButton } from "../../components/ui";

const NETWORK_GRID =
  "grid grid-cols-[minmax(150px,1.2fr)_84px_64px_minmax(170px,1fr)_76px_minmax(130px,0.9fr)_52px] items-center gap-x-3";

export function NetworkList({
  nets,
  search,
  onOpen,
  onDelete,
}: {
  nets: NetworkDto[];
  search: string;
  onOpen: (name: string) => void;
  onDelete: (n: NetworkDto) => void;
}) {
  const t = useT();
  const keyword = search.trim().toLowerCase();
  const filtered = keyword
    ? nets.filter(
        (n) =>
          n.name.toLowerCase().includes(keyword) ||
          n.driver.toLowerCase().includes(keyword) ||
          (n.subnet ?? "").includes(keyword),
      )
    : nets;

  return filtered.length === 0 ? (
    <EmptyState
      icon={<Network size={40} strokeWidth={1.5} />}
      title={t("st.netEmptySearch")}
      desc={t("inspect.noMatchHint")}
    />
  ) : (
    <div className="flex-1 overflow-auto p-4 pt-2">
      <div className="overflow-hidden rounded-card border border-edge bg-panel shadow-[var(--app-shadow)]">
        <div
          className={`${NETWORK_GRID} h-8 border-b border-edge bg-panel2/60 px-4 text-[11px] font-medium text-fg3`}
        >
          <div>{t("st.name")}</div>
          <div>{t("st.driver")}</div>
          <div>{t("st.thScope")}</div>
          <div>{t("st.thSubnet")}</div>
          <div>{t("st.thConnected")}</div>
          <div>{t("st.thLabels")}</div>
          <div />
        </div>
        {filtered.map((n) => (
          <div
            key={n.id || n.name}
            onClick={() => onOpen(n.name)}
            className={`${NETWORK_GRID} group cursor-pointer border-b border-edge/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-hover`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-fg" title={n.name}>
                  {n.name}
                </span>
                {n.internal && <Badge tone="warn">{t("st.internal")}</Badge>}
              </div>
              <div className="truncate font-mono text-[11px] text-fg3">{shortId(n.id)}</div>
            </div>
            <div className="truncate font-mono text-[12px] text-fg2">{n.driver}</div>
            <div className="text-[12px] text-fg2">{n.scope || "-"}</div>
            <div className="min-w-0">
              {n.subnet || n.gateway ? (
                <>
                  <div className="truncate font-mono text-[11px] text-fg2" title={n.subnet ?? ""}>
                    {n.subnet ?? "-"}
                  </div>
                  <div className="truncate font-mono text-[11px] text-fg3" title={n.gateway ?? ""}>
                    {n.gateway ?? "-"}
                  </div>
                </>
              ) : (
                <span className="text-[12px] text-fg3">{t("st.autoAssigned")}</span>
              )}
            </div>
            <div className="text-[12px] tabular-nums text-fg2">
              {n.containers.length > 0 ? t("storage.nContainersShort", { n: n.containers.length }) : "0"}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {n.built_in && <Badge>{t("st.builtIn")}</Badge>}
              {n.enable_ipv6 && <Badge tone="accent">IPv6</Badge>}
              {!n.built_in && !n.enable_ipv6 && <span className="text-fg3">—</span>}
            </div>
            <div
              className="flex items-center justify-end opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
              data-no-drag
            >
              <IconButton
                title={n.built_in ? t("st.builtInNoDelete") : t("containers.actRemove")}
                disabled={n.built_in}
                className="hover:bg-err/10 hover:text-err"
                onClick={() => onDelete(n)}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
