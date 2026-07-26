import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { Card, Empty, Row, Spinner } from "@/components/ui";

export function Overview({ apiKey, onOpenDomain }: { apiKey: string; onOpenDomain: (d: string) => void }) {
  const { data, isPending, error } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.overview(apiKey),
    refetchInterval: 30_000,
  });

  if (isPending) return <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner /> 载入中</div>;
  if (error) return <Empty>加载失败：{error.message}</Empty>;

  const stats = [
    { k: "今日验证码", v: data.codesToday },
    { k: "近 7 天", v: data.codesWeek },
    { k: "邮箱", v: data.mailboxesTotal },
    { k: "分享链接", v: data.shareLinks },
  ];

  return (
    <>
      <div className="mb-1.5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 lg:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-800">
        {stats.map((s) => (
          <div key={s.k} className="bg-white px-4 py-3.5 dark:bg-zinc-900">
            <div className="text-[11.5px] text-zinc-500">{s.k}</div>
            <div className="mt-1 text-[22px] font-semibold leading-tight tracking-tight tabular-nums">{s.v}</div>
          </div>
        ))}
      </div>
      <div className="mb-6 text-xs text-zinc-400">
        最后收信 {timeAgo(data.lastActivity)} · {data.domainsWithMail} / {data.domainsConfigured} 个域名有记录
      </div>

      <div className="mb-2.5 flex items-baseline justify-between">
        <span className="text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300">最近收信的域名</span>
        <span className="text-xs text-zinc-400">按最后活动排序</span>
      </div>
      {data.topDomains.length === 0 ? (
        <Empty>还没有收到任何邮件</Empty>
      ) : (
        <Card>
          {data.topDomains.map((d) => (
            <Row key={d.domain} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50" onClick={() => onOpenDomain(d.domain)}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px]">{d.domain}</div>
                <div className="mt-0.5 truncate text-xs text-zinc-400">
                  {d.mailboxes} 邮箱 · {d.codes} 验证码 · {timeAgo(d.lastActivity)}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600" />
            </Row>
          ))}
        </Card>
      )}
    </>
  );
}
