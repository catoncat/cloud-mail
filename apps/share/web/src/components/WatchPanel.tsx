import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, Inbox, X } from "lucide-react";
import { api } from "@/lib/api";
import { copyText, timeAgo } from "@/lib/utils";
import type { AddressView } from "@/lib/types";
import { Badge, BigCode, Button, Card, IconButton, SignalDot, Spinner } from "@/components/ui";

export type ActiveWatch = { mailbox: string; baselineAt: string | null; startedAt: number };

export function WatchPanel({
  apiKey,
  watch,
  address,
  onClose,
  onOpenAddress,
  onToast,
}: {
  apiKey: string;
  watch: ActiveWatch;
  address?: AddressView;
  onClose: () => void;
  onOpenAddress: (mailbox: string) => void;
  onToast: (message: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const notifiedId = useRef<string | null>(null);
  const originalTitle = useRef(document.title);

  const feed = useQuery({
    queryKey: ["messages", "watch", watch.mailbox],
    queryFn: () => api.messages(apiKey, { mailbox: watch.mailbox, page: 1, size: 20 }),
    refetchInterval: 3_000,
  });

  useEffect(() => {
    setNow(Date.now());
    notifiedId.current = null;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [watch.mailbox, watch.startedAt]);

  const latest = feed.data?.messages[0] ?? null;
  const isNew = Boolean(latest && (
    watch.baselineAt
      ? latest.receivedAt > watch.baselineAt
      : new Date(latest.receivedAt).getTime() >= watch.startedAt - 2_000
  ));
  const hasArrived = Boolean(latest && isNew);

  useEffect(() => {
    if (!hasArrived || !latest || notifiedId.current === latest.id) return;
    notifiedId.current = latest.id;
    document.title = latest.code ? `${latest.code} · 验证码已到` : "新邮件已到";
    try { navigator.vibrate?.(80); } catch { /* ignore */ }
    const timer = window.setTimeout(() => { document.title = originalTitle.current; }, 12_000);
    return () => window.clearTimeout(timer);
  }, [hasArrived, latest]);

  useEffect(() => () => { document.title = originalTitle.current; }, []);

  const elapsed = useMemo(() => {
    const seconds = Math.max(0, Math.floor((now - watch.startedAt) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  }, [now, watch.startedAt]);

  const name = address?.label || address?.service || "当前地址";

  return (
    <Card className="overflow-hidden">
      <div className="flex min-h-[46px] items-center gap-3 border-b border-zinc-100 px-3.5 dark:border-zinc-800">
        <SignalDot active={!hasArrived} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{hasArrived ? "收到新邮件" : `正在等待 · ${elapsed}`}</div>
          <button
            className="mt-0.5 block max-w-full truncate font-mono text-[11.5px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
            onClick={async () => onToast((await copyText(watch.mailbox)) ? "地址已复制" : "复制失败")}
          >
            {watch.mailbox}
          </button>
        </div>
        <Badge tone={hasArrived ? "signal" : "good"}>{name}</Badge>
        <IconButton label="关闭监听" onClick={onClose}><X className="h-4 w-4" /></IconButton>
      </div>

      <div className="grid place-items-center px-5 py-6 text-center">
        {feed.isPending ? (
          <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner />连接收件箱</div>
        ) : feed.error ? (
          <div>
            <div className="text-sm font-medium text-red-700 dark:text-red-400">读取失败</div>
            <div className="mt-1 text-xs text-zinc-400">{feed.error.message}</div>
          </div>
        ) : hasArrived && latest ? (
          <div className="w-full max-w-xl">
            <div className="mb-3 text-xs font-medium text-zinc-500">{latest.code ? "验证码" : latest.subject || "新邮件"}</div>
            {latest.code ? <BigCode value={latest.code} /> : <div className="text-xl font-semibold">{latest.subject || "无主题"}</div>}
            <div className="mt-3 text-xs text-zinc-400">{latest.subject} · {timeAgo(latest.receivedAt)}</div>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {latest.code && (
                <Button variant="primary" onClick={async () => onToast((await copyText(latest.code!)) ? "验证码已复制" : "复制失败")}>
                  <Copy className="h-4 w-4" />复制验证码
                </Button>
              )}
              {latest.link && (
                <a className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800" href={latest.link} target="_blank" rel="noopener">
                  <ExternalLink className="h-4 w-4" />打开登录链接
                </a>
              )}
              <Button onClick={() => onOpenAddress(watch.mailbox)}><Inbox className="h-4 w-4" />查看邮件</Button>
            </div>
          </div>
        ) : (
          <div className="max-w-md">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              <Inbox className="h-6 w-6" />
            </div>
            <div className="text-base font-semibold">等待下一封邮件</div>
            <div className="mt-2 text-sm text-zinc-500">{latest ? `上一封：${latest.subject || "无主题"}，${timeAgo(latest.receivedAt)}` : "地址已经就绪"}</div>
            <Button className="mt-5" onClick={async () => onToast((await copyText(watch.mailbox)) ? "地址已复制" : "复制失败")}>
              <Copy className="h-4 w-4" />复制地址
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
