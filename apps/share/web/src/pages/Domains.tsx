import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { copyText, timeAgo } from "@/lib/utils";
import { Badge, Button, Card, Empty, Input, Row, Spinner } from "@/components/ui";
import type { DomainStat } from "@/lib/types";

function AddDomain({ apiKey, onToast }: { apiKey: string; onToast: (s: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [zone, setZone] = useState("");
  const [result, setResult] = useState<{ dnsReady: boolean; command?: string } | null>(null);

  const zones = useQuery({ queryKey: ["zones"], queryFn: () => api.zones(apiKey), enabled: open });

  const add = useMutation({
    mutationFn: (domain: string) => api.addDomain(apiKey, domain),
    onSuccess: (r) => {
      setResult({ dnsReady: r.dnsReady, command: r.followUp?.command });
      setPrefix("");
      onToast(r.dnsReady ? "已添加，DNS 就绪" : "已登记，需完成 DNS");
      void qc.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (e) => onToast(`添加失败：${e.message}`),
  });

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" />添加域名
      </Button>
    );
  }

  const configured = new Set(zones.data?.configured ?? []);
  const full = prefix.trim() ? `${prefix.trim()}.${zone}` : zone;
  const exists = configured.has(full);

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 text-[12.5px] font-semibold">添加收信域名</div>
      {zones.isPending ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner /> 读取 Cloudflare</div>
      ) : zones.error ? (
        <div className="text-sm text-red-600">无法读取 zone：{zones.error.message}</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-40"
              placeholder="子域名（可空）"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.replace(/[^a-zA-Z0-9-]/g, ""))}
            />
            <span className="text-zinc-400">.</span>
            <select
              className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
            >
              <option value="">选择域名</option>
              {zones.data.zones.map((z) => <option key={z.id} value={z.name}>{z.name}</option>)}
            </select>
            <Button
              variant="primary"
              size="sm"
              disabled={!zone || exists || add.isPending}
              onClick={() => add.mutate(full)}
            >
              {add.isPending ? "处理中…" : "添加"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setResult(null); }}>取消</Button>
          </div>
          {zone && (
            <div className="mt-2 font-mono text-xs text-zinc-500">
              {full}
              {exists && <span className="ml-2 text-amber-600">已存在</span>}
            </div>
          )}
        </>
      )}

      {result && !result.dnsReady && result.command && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
          <div className="text-xs font-medium text-amber-800 dark:text-amber-500">
            白名单已登记，但 DNS 需要在本机执行一次
          </div>
          <div className="mt-2 flex items-start gap-2">
            <code className="flex-1 break-all rounded bg-white/60 p-2 font-mono text-[11px] leading-relaxed dark:bg-black/30">
              {result.command}
            </code>
            <Button size="sm" onClick={async () => onToast((await copyText(result.command!)) ? "已复制命令" : "复制失败")}>
              复制
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function Domains({ apiKey, onOpenDomain, onToast }: { apiKey: string; onOpenDomain: (d: string) => void; onToast: (s: string) => void }) {
  const { data, isPending, error } = useQuery({ queryKey: ["domains"], queryFn: () => api.domains(apiKey) });

  if (isPending) return <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner /> 载入中</div>;
  if (error) return <Empty>加载失败：{error.message}</Empty>;

  const withMail = data.domains.filter((d) => d.mailboxes > 0);
  const empty = data.domains.filter((d) => d.mailboxes === 0);

  const row = (d: DomainStat, clickable: boolean) => (
    <Row
      key={d.domain}
      className={clickable ? "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50" : undefined}
      onClick={clickable ? () => onOpenDomain(d.domain) : undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[13px]">{d.domain}</div>
        <div className="mt-0.5 truncate text-xs text-zinc-400">
          {d.mailboxes > 0 ? `${d.mailboxes} 邮箱 · ${d.codes} 验证码 · ${timeAgo(d.lastActivity)}` : "尚无收信记录"}
        </div>
      </div>
      {!d.enabled && <Badge>已停用</Badge>}
      {clickable && <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600" />}
    </Row>
  );

  return (
    <>
      <div className="mb-4"><AddDomain apiKey={apiKey} onToast={onToast} /></div>

      {withMail.length > 0 && (
        <div className="mb-6">
          <div className="mb-2.5 flex items-baseline justify-between">
            <span className="text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300">有收信记录</span>
            <span className="text-xs text-zinc-400">{withMail.length} 个</span>
          </div>
          <Card>{withMail.map((d) => row(d, true))}</Card>
        </div>
      )}
      {empty.length > 0 && (
        <div>
          <div className="mb-2.5 flex items-baseline justify-between">
            <span className="text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300">未收到过邮件</span>
            <span className="text-xs text-zinc-400">{empty.length} 个</span>
          </div>
          <Card>{empty.map((d) => row(d, false))}</Card>
        </div>
      )}
      {data.domains.length === 0 && <Empty>没有配置域名</Empty>}
    </>
  );
}
