import { useQuery } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { api } from "../../lib/api";
import { EmptyState, ErrorNote, Spinner } from "../ui";

/** 容器进程视图（docker top，5 秒轮询；仅运行中容器可获取） */
export function ProcessView({ id, running }: { id: string; running: boolean }) {
  const query = useQuery({
    queryKey: ["containerTop", id],
    queryFn: () => api.containerTop(id),
    refetchInterval: 5000,
    enabled: running,
  });

  if (!running) {
    return (
      <EmptyState
        icon={<Cpu size={28} />}
        title="容器未运行"
        desc="进程列表仅在容器运行时可获取，启动容器后自动出现。"
      />
    );
  }
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

  const top = query.data;
  if (!top) return null;
  const { titles, processes } = top;
  if (titles.length === 0) {
    return <EmptyState icon={<Cpu size={28} />} title="暂无进程数据" />;
  }

  return (
    <div className="h-full overflow-auto px-4 py-3">
      <table className="w-full border-collapse text-left font-mono text-[12px]">
        <thead className="sticky top-0 bg-panel">
          <tr className="border-b border-edge text-[11px] text-fg3">
            {titles.map((t) => (
              <th key={t} className="whitespace-nowrap px-2 py-1.5 font-medium">
                {t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {processes.map((row, i) => (
            <tr key={i} className="border-b border-edge/50 text-fg2 hover:bg-fg/[0.03]">
              {titles.map((_, j) => (
                <td key={j} className="max-w-96 truncate px-2 py-1.5" title={row[j]}>
                  {row[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {processes.length === 0 && (
        <div className="py-6 text-center text-xs text-fg3">暂无进程</div>
      )}
    </div>
  );
}
