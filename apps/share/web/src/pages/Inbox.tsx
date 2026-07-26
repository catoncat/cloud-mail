import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { copyText, timeAgo } from "@/lib/utils";
import { Button, Card, Code, Empty, Row, Spinner } from "@/components/ui";
import type { FeedMessage } from "@/lib/types";

function MessageRow({ m, onToast }: { m: FeedMessage; onToast: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-zinc-100 first:border-t-0 dark:border-zinc-800">
      <div
        className="flex min-h-[46px] cursor-pointer items-center gap-3 px-3.5 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-300" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-300" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">{m.subject || "无主题"}</div>
          <div className="mt-0.5 truncate font-mono text-xs text-zinc-400">{m.to}</div>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-zinc-400">{timeAgo(m.receivedAt)}</span>
        {m.code && (
          <button
            className="shrink-0"
            onClick={async (e) => { e.stopPropagation(); onToast((await copyText(m.code!)) ? "已复制" : "复制失败"); }}
          >
            <Code>{m.code}</Code>
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-dashed border-zinc-200 px-3.5 py-3 dark:border-zinc-800">
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
            <span>发件人 {m.from || "—"}</span>
            <span>{new Date(m.receivedAt).toLocaleString()}</span>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 font-mono text-xs leading-relaxed text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
            {m.text || "（无文本内容）"}
          </pre>
          {m.link && (
            <a href={m.link} target="_blank" rel="noopener" className="mt-2 inline-block break-all text-xs text-zinc-500 underline">
              {m.link.slice(0, 90)}…
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function Inbox({ apiKey, onToast }: { apiKey: string; onToast: (s: string) => void }) {
  const [page, setPage] = useState(1);
  const [domain, setDomain] = useState("");

  const domains = useQuery({ queryKey: ["domains"], queryFn: () => api.domains(apiKey) });
  const feed = useQuery({
    queryKey: ["messages", page, domain],
    queryFn: () => api.messages(apiKey, { page, size: 25, domain: domain || undefined }),
    refetchInterval: 20_000,
  });

  const active = domains.data?.domains.filter((d) => d.mailboxes > 0) ?? [];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-[13px] dark:border-zinc-800 dark:bg-zinc-900"
          value={domain}
          onChange={(e) => { setDomain(e.target.value); setPage(1); }}
        >
          <option value="">全部域名</option>
          {active.map((d) => <option key={d.domain} value={d.domain}>{d.domain}</option>)}
        </select>
        {feed.data && <span className="text-xs text-zinc-400">共 {feed.data.total} 封</span>}
      </div>

      {feed.isPending ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner /> 载入中</div>
      ) : feed.error ? (
        <Empty>加载失败：{feed.error.message}</Empty>
      ) : feed.data.messages.length === 0 ? (
        <Empty>没有邮件</Empty>
      ) : (
        <>
          <Card>{feed.data.messages.map((m) => <MessageRow key={m.id ?? `${m.to}-${m.receivedAt}`} m={m} onToast={onToast} />)}</Card>
          {feed.data.pages > 1 && (
            <div className="mt-3 flex items-center justify-between">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
              <span className="text-xs tabular-nums text-zinc-400">{page} / {feed.data.pages}</span>
              <Button size="sm" disabled={page >= feed.data.pages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
