import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, Globe2 } from "lucide-react";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { Card, Segmented, Spinner } from "@/components/ui";
import { Domains } from "@/pages/Domains";
import { Services } from "@/pages/Services";

type SystemSection = "domains" | "agents";

export function System({
  apiKey,
  onOpenDomain,
  onToast,
}: {
  apiKey: string;
  onOpenDomain: (domain: string) => void;
  onToast: (message: string) => void;
}) {
  const [section, setSection] = useState<SystemSection>("domains");
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api.overview(apiKey), refetchInterval: 30_000 });
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => api.usage(apiKey), refetchInterval: 30_000 });

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2.5 text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300">运行状态</div>
        {overview.isPending ? (
          <div className="flex items-center gap-2 border-y border-zinc-200 py-8 text-sm text-zinc-400 dark:border-zinc-800"><Spinner />读取状态</div>
        ) : overview.data && (
          <Card className="grid overflow-hidden sm:grid-cols-3">
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Globe2 className="h-4 w-4 text-zinc-500" />
              <div><div className="text-sm font-semibold tabular-nums">{overview.data.domainsConfigured} 个域名</div><div className="mt-0.5 text-xs text-zinc-400">{overview.data.domainsWithMail} 个已有来信</div></div>
            </div>
            <div className="flex items-center gap-3 border-t border-zinc-200 px-4 py-3.5 sm:border-l sm:border-t-0 dark:border-zinc-800">
              <Activity className="h-4 w-4 text-zinc-500" />
              <div><div className="text-sm font-semibold">{timeAgo(overview.data.lastActivity)}</div><div className="mt-0.5 text-xs text-zinc-400">最近来信</div></div>
            </div>
            <div className="flex items-center gap-3 border-t border-zinc-200 px-4 py-3.5 sm:border-l sm:border-t-0 dark:border-zinc-800">
              <Bot className="h-4 w-4 text-zinc-500" />
              <div><div className="text-sm font-semibold tabular-nums">{usage.data?.services.length ?? 0} 个服务</div><div className="mt-0.5 text-xs text-zinc-400">Agent 已接入</div></div>
            </div>
          </Card>
        )}
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold">系统配置</h1>
            <p className="mt-0.5 text-xs text-zinc-400">域名路由与 Agent 地址池</p>
          </div>
          <Segmented
            value={section}
            options={[{ value: "domains", label: "收信域名" }, { value: "agents", label: "Agent 使用" }]}
            onChange={setSection}
          />
        </div>

        {section === "domains" ? (
          <Domains apiKey={apiKey} onOpenDomain={onOpenDomain} onToast={onToast} />
        ) : (
          <Services apiKey={apiKey} />
        )}
      </section>
    </div>
  );
}
