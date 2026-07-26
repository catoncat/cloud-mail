import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { Card, Empty, Row, Spinner } from "@/components/ui";

export function Services({ apiKey }: { apiKey: string }) {
  const { data, isPending, error } = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.usage(apiKey),
    refetchInterval: 30_000,
  });

  if (isPending) return <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner /> 载入中</div>;
  if (error) return <Empty>加载失败：{error.message}</Empty>;
  if (data.services.length === 0) return <Empty>还没有服务领取过域名</Empty>;

  return (
    <>
      <div className="mb-6">
        <div className="mb-2.5 flex items-baseline justify-between">
          <span className="text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300">服务</span>
          <span className="text-xs text-zinc-400">{data.services.length} 个</span>
        </div>
        <Card>
          {data.services.map((s) => (
            <Row key={s.service}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{s.service}</div>
                <div className="mt-0.5 truncate font-mono text-xs text-zinc-400">{s.domains.join("  ")}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[13px] tabular-nums">{s.claims} 次</div>
                <div className="text-xs text-zinc-400">{timeAgo(s.lastAt)}</div>
              </div>
            </Row>
          ))}
        </Card>
      </div>

      <div className="mb-2.5 text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300">最近领取</div>
      <Card>
        {data.recent.slice(0, 20).map((r, i) => (
          <Row key={`${r.at}-${i}`}>
            <span className="w-28 shrink-0 text-xs tabular-nums text-zinc-400">{timeAgo(r.at)}</span>
            <span className="flex-1 truncate text-[13px]">{r.service}</span>
            <span className="truncate font-mono text-xs text-zinc-500">{r.domain}</span>
          </Row>
        ))}
      </Card>
    </>
  );
}
