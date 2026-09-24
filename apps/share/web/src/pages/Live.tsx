import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Inbox, Plus, Radio } from "lucide-react";
import { api } from "@/lib/api";
import { copyText, timeAgo } from "@/lib/utils";
import type { AddressView, FeedMessage } from "@/lib/types";
import { Button, Card, Code, Empty, IconButton, Segmented, SignalDot, Spinner } from "@/components/ui";
import { type ActiveWatch, WatchPanel } from "@/components/WatchPanel";

type FeedMode = "codes" | "all";

function MessageItem({
  message,
  address,
  onWatch,
  onToast,
}: {
  message: FeedMessage;
  address?: AddressView;
  onWatch: (mailbox: string, baselineAt: string | null) => void;
  onToast: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const recent = Date.now() - new Date(message.receivedAt).getTime() < 10 * 60_000;
  const name = address?.label || address?.service || message.from.split("@")[1] || "邮件";

  return (
    <div className="border-t border-zinc-100 first:border-t-0 dark:border-zinc-800">
      <div className="flex min-h-[46px] items-center gap-3 px-3 py-2 sm:px-3.5">
        <button className="min-w-0 flex flex-1 items-center gap-3 text-left" onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-zinc-300" /> : <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300" />}
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-zinc-100 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{address?.label || address?.service || message.subject || "无主题"}</span>
              {recent && <SignalDot active />}
            </div>
            <div className="mt-0.5 truncate font-mono text-[11.5px] text-zinc-400">{message.to}</div>
          </div>
        </button>

        <span className="hidden shrink-0 text-xs tabular-nums text-zinc-400 sm:block">{timeAgo(message.receivedAt)}</span>
        {message.code && (
          <button
            className="shrink-0"
            title="复制验证码"
            onClick={async () => onToast((await copyText(message.code!)) ? "验证码已复制" : "复制失败")}
          >
            <Code>{message.code}</Code>
          </button>
        )}
        <IconButton label="等待下一封邮件" onClick={() => onWatch(message.to, message.receivedAt)}><Radio className="h-4 w-4" /></IconButton>
      </div>
      {open && (
        <div className="border-t border-dashed border-zinc-200 px-4 py-4 dark:border-zinc-800">
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
            <span>{message.from || "未知发件人"}</span>
            <span>{new Date(message.receivedAt).toLocaleString()}</span>
          </div>
          <div className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            {message.text || "（无文本内容）"}
          </div>
        </div>
      )}
    </div>
  );
}

export function Live({
  apiKey,
  watch,
  onCreate,
  onWatch,
  onStopWatch,
  onOpenAddress,
  onToast,
}: {
  apiKey: string;
  watch: ActiveWatch | null;
  onCreate: () => void;
  onWatch: (mailbox: string, baselineAt: string | null) => void;
  onStopWatch: () => void;
  onOpenAddress: (mailbox: string) => void;
  onToast: (message: string) => void;
}) {
  const [mode, setMode] = useState<FeedMode>("codes");
  const addresses = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.addresses(apiKey),
    refetchInterval: 15_000,
  });
  const feed = useQuery({
    queryKey: ["messages", "live"],
    queryFn: () => api.messages(apiKey, { page: 1, size: 30 }),
    refetchInterval: 5_000,
  });

  const addressMap = new Map(addresses.data?.addresses.map((item) => [item.mailbox, item]) ?? []);
  const waiting = (addresses.data?.addresses ?? []).filter((item) => item.registered && item.messages === 0).slice(0, 5);
  const messages = (feed.data?.messages ?? []).filter((message) => mode === "all" || Boolean(message.code));
  const watchedAddress = watch ? addressMap.get(watch.mailbox) : undefined;

  return (
    <div className="space-y-6">
      {watch ? (
        <WatchPanel
          apiKey={apiKey}
          watch={watch}
          address={watchedAddress}
          onClose={onStopWatch}
          onOpenAddress={onOpenAddress}
          onToast={onToast}
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-zinc-500"><Radio className="h-3.5 w-3.5" />实时收码</div>
              <h1 className="text-base font-semibold">现在收码</h1>
              <div className="mt-1 font-mono text-xs text-zinc-400">
                {feed.data?.messages[0] ? `最近来信 ${timeAgo(feed.data.messages[0].receivedAt)}` : "等待第一封邮件"}
              </div>
            </div>
            <Button variant="primary" onClick={onCreate}>
              <Plus className="h-4 w-4" />新地址
            </Button>
          </div>
          {waiting.length > 0 && (
            <div className="border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
              <div className="flex items-center gap-2 overflow-x-auto">
                <span className="shrink-0 text-xs text-zinc-400">待来信</span>
                {waiting.map((item) => (
                  <button key={item.mailbox} className="flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-[11.5px] hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800" onClick={() => onWatch(item.mailbox, item.lastActivity)}>
                    <SignalDot active />{item.mailbox}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">最近到达</h2>
            <div className="mt-0.5 text-xs text-zinc-400">{feed.data ? `${feed.data.total} 封` : "实时更新"}</div>
          </div>
          <Segmented value={mode} options={[{ value: "codes", label: "验证码" }, { value: "all", label: "全部邮件" }]} onChange={setMode} />
        </div>

        {feed.isPending ? (
          <div className="flex items-center gap-2 border-y border-zinc-200 py-10 text-sm text-zinc-400 dark:border-zinc-800"><Spinner />读取邮件</div>
        ) : feed.error ? (
          <Empty>加载失败：{feed.error.message}</Empty>
        ) : messages.length === 0 ? (
          <Empty>
            <Inbox className="mx-auto mb-3 h-5 w-5" />
            {mode === "codes" ? "还没有验证码" : "还没有邮件"}
          </Empty>
        ) : (
          <Card className="overflow-hidden">
            {messages.map((message) => (
              <MessageItem
                key={message.id ?? `${message.to}-${message.receivedAt}`}
                message={message}
                address={addressMap.get(message.to)}
                onWatch={onWatch}
                onToast={onToast}
              />
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
