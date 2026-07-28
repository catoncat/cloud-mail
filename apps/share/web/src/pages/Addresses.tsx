import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, ExternalLink, Inbox, Link2, Radio, Save, Search, Share2, Trash2, Unlink } from "lucide-react";
import { api } from "@/lib/api";
import { copyText, timeAgo } from "@/lib/utils";
import type { AddressView, FeedMessage } from "@/lib/types";
import { Badge, Button, Card, Code, Empty, IconButton, Input, Segmented, Select, SignalDot, Spinner } from "@/components/ui";

type AddressFilter = "all" | "waiting" | "shared";

function AddressRow({
  address,
  onOpen,
  onWatch,
  onToast,
}: {
  address: AddressView;
  onOpen: () => void;
  onWatch: () => void;
  onToast: (message: string) => void;
}) {
  const name = address.label || address.service || address.localPart;
  return (
    <div className="flex min-h-[46px] items-center gap-3 border-t border-zinc-100 px-3 py-2 first:border-t-0 sm:px-3.5 dark:border-zinc-800">
      <button className="min-w-0 flex flex-1 items-center gap-3 text-left" onClick={onOpen}>
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-zinc-100 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{name}</span>
            {address.messages === 0 && address.registered && <Badge tone="good">等码中</Badge>}
            {address.shares.length > 0 && <Badge><Share2 className="mr-1 h-3 w-3" />{address.shares.length}</Badge>}
          </div>
          <div className="mt-1 truncate font-mono text-[11.5px] text-zinc-400">{address.mailbox}</div>
        </div>
      </button>
      <div className="hidden shrink-0 text-right md:block">
        <div className="text-xs text-zinc-500">{address.messages ? `${address.messages} 封` : "未收信"}</div>
        <div className="mt-0.5 text-[11px] text-zinc-400">{timeAgo(address.lastActivity ?? address.createdAt)}</div>
      </div>
      {address.lastCode && (
        <button title="复制验证码" onClick={async () => onToast((await copyText(address.lastCode!)) ? "验证码已复制" : "复制失败")}>
          <Code>{address.lastCode}</Code>
        </button>
      )}
      <IconButton label="复制地址" onClick={async () => onToast((await copyText(address.mailbox)) ? "地址已复制" : "复制失败")}><Copy className="h-4 w-4" /></IconButton>
      <IconButton label="等待新邮件" onClick={onWatch}><Radio className="h-4 w-4" /></IconButton>
    </div>
  );
}

function HistoryItem({ message, onToast }: { message: FeedMessage; onToast: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-zinc-100 first:border-t-0 dark:border-zinc-800">
      <div className="flex min-h-[46px] items-center gap-3 px-3 py-2 sm:px-3.5">
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((value) => !value)}>
          <div className="truncate text-[13px]">{message.subject || "无主题"}</div>
          <div className="mt-0.5 truncate text-xs text-zinc-400">{message.from || "未知发件人"} · {timeAgo(message.receivedAt)}</div>
        </button>
        {message.code && <button title="复制验证码" onClick={async () => onToast((await copyText(message.code!)) ? "验证码已复制" : "复制失败")}><Code>{message.code}</Code></button>}
        {message.link && <a className="text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-50" href={message.link} target="_blank" rel="noopener" aria-label="打开登录链接" title="打开登录链接"><ExternalLink className="h-4 w-4" /></a>}
      </div>
      {open && <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-dashed border-zinc-200 px-4 py-4 font-mono text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">{message.text || "（无文本内容）"}</pre>}
    </div>
  );
}

function AddressDetail({
  apiKey,
  address,
  onBack,
  onWatch,
  onToast,
}: {
  apiKey: string;
  address: AddressView;
  onBack: () => void;
  onWatch: () => void;
  onToast: (message: string) => void;
}) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(address.label ?? "");
  const [service, setService] = useState(address.service ?? "");
  const [note, setNote] = useState(address.note ?? "");

  useEffect(() => {
    setLabel(address.label ?? "");
    setService(address.service ?? "");
    setNote(address.note ?? "");
  }, [address.label, address.note, address.service, address.mailbox]);

  const messages = useQuery({
    queryKey: ["messages", "address", address.mailbox],
    queryFn: () => api.messages(apiKey, { mailbox: address.mailbox, page: 1, size: 30 }),
    refetchInterval: 8_000,
  });

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["addresses"] }),
      qc.invalidateQueries({ queryKey: ["messages", "address", address.mailbox] }),
      qc.invalidateQueries({ queryKey: ["messages", "live"] }),
    ]);
  };

  const save = useMutation({
    mutationFn: () => api.updateAddress(apiKey, address.mailbox, { label, service, note }),
    onSuccess: async () => { onToast("已保存"); await refresh(); },
    onError: (error) => onToast(`保存失败：${error.message}`),
  });

  const share = useMutation({
    mutationFn: () => api.createLink(apiKey, address.mailbox, label || service || undefined),
    onSuccess: async (link) => {
      onToast((await copyText(link.url)) ? "分享链接已复制" : "分享链接已创建");
      await refresh();
    },
    onError: (error) => onToast(`创建失败：${error.message}`),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteLink(apiKey, id),
    onSuccess: async () => { onToast("分享已撤销"); await refresh(); },
    onError: (error) => onToast(`撤销失败：${error.message}`),
  });

  const publicAccess = useMutation({
    mutationFn: async () => {
      if (address.publicAccess) await api.revokeMailbox(apiKey, address.mailbox);
      else await api.allowMailbox(apiKey, address.mailbox, label || service || undefined);
    },
    onSuccess: async () => { onToast(address.publicAccess ? "固定入口已关闭" : "固定入口已开启"); await refresh(); },
    onError: (error) => onToast(`更新失败：${error.message}`),
  });

  const clear = useMutation({
    mutationFn: () => api.clearAddressMessages(apiKey, address.mailbox),
    onSuccess: async (result) => { onToast(`已清除 ${result.changes} 封邮件`); await refresh(); },
    onError: (error) => onToast(`清除失败：${error.message}`),
  });

  const publicUrl = `${location.origin}/?mail=${encodeURIComponent(address.mailbox)}`;

  return (
    <div className="space-y-6">
      <section>
        <button className="mb-5 flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50" onClick={onBack}><ArrowLeft className="h-3.5 w-3.5" />返回地址</button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <SignalDot active={address.messages === 0 && address.registered} />
              <h1 className="truncate text-xl font-semibold">{address.label || address.service || address.localPart}</h1>
            </div>
            <button className="mt-2 max-w-full truncate font-mono text-[13px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50" onClick={async () => onToast((await copyText(address.mailbox)) ? "地址已复制" : "复制失败")}>{address.mailbox}</button>
          </div>
          <div className="flex gap-2">
            <Button onClick={async () => onToast((await copyText(address.mailbox)) ? "地址已复制" : "复制失败")}><Copy className="h-4 w-4" />复制</Button>
            <Button variant="primary" onClick={onWatch}><Radio className="h-4 w-4" />等待新码</Button>
          </div>
        </div>
      </section>

      <section className="border-y border-zinc-200 py-5 dark:border-zinc-800">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">账号信息</h2>
          <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate()}><Save className="h-3.5 w-3.5" />保存</Button>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <label><span className="mb-1.5 block text-xs text-zinc-500">服务</span><Input value={service} placeholder="Notion" onChange={(event) => setService(event.target.value)} /></label>
          <label><span className="mb-1.5 block text-xs text-zinc-500">账号备注</span><Input value={label} placeholder="团队版" onChange={(event) => setLabel(event.target.value)} /></label>
          <label><span className="mb-1.5 block text-xs text-zinc-500">补充信息</span><Input value={note} placeholder="负责人、用途" onChange={(event) => setNote(event.target.value)} /></label>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">访问权限</h2>
            <div className="mt-0.5 text-xs text-zinc-400">{address.shares.length} 个临时链接{address.publicAccess ? " · 固定入口开启" : ""}</div>
          </div>
          <Button size="sm" onClick={() => share.mutate()} disabled={share.isPending}><Share2 className="h-3.5 w-3.5" />新分享</Button>
        </div>
        <Card className="overflow-hidden">
          {address.shares.map((item) => (
            <div key={item.id} className="flex min-h-[46px] items-center gap-3 border-t border-zinc-100 px-3.5 py-2 first:border-t-0 dark:border-zinc-800">
              <Link2 className="h-4 w-4 shrink-0 text-zinc-400" />
              <div className="min-w-0 flex-1"><div className="truncate text-[13px]">{item.label || "分享链接"}</div><div className="mt-0.5 text-xs text-zinc-400">{timeAgo(item.createdAt)}</div></div>
              <IconButton label="复制分享链接" onClick={async () => onToast((await copyText(item.url)) ? "链接已复制" : "复制失败")}><Copy className="h-4 w-4" /></IconButton>
              <IconButton label="撤销分享" className="text-red-600" disabled={revoke.isPending} onClick={() => { if (confirm(`撤销 ${address.mailbox} 的这个分享链接？`)) revoke.mutate(item.id); }}><Unlink className="h-4 w-4" /></IconButton>
            </div>
          ))}
          <div className="flex min-h-[46px] items-center gap-3 border-t border-zinc-100 px-3.5 py-2 first:border-t-0 dark:border-zinc-800">
            <Inbox className="h-4 w-4 shrink-0 text-zinc-400" />
            <div className="min-w-0 flex-1"><div className="text-[13px]">固定入口</div><div className="mt-0.5 truncate text-xs text-zinc-400">{address.publicAccess ? publicUrl : "仅自己使用时开启"}</div></div>
            {address.publicAccess && <IconButton label="复制固定入口" onClick={async () => onToast((await copyText(publicUrl)) ? "入口已复制" : "复制失败")}><Copy className="h-4 w-4" /></IconButton>}
            <Button size="sm" variant={address.publicAccess ? "danger" : "outline"} disabled={publicAccess.isPending} onClick={() => publicAccess.mutate()}>{address.publicAccess ? "关闭" : "开启"}</Button>
          </div>
        </Card>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><h2 className="text-sm font-semibold">邮件记录</h2><div className="mt-0.5 text-xs text-zinc-400">{messages.data?.total ?? address.messages} 封</div></div>
          {address.messages > 0 && <Button size="sm" variant="danger" disabled={clear.isPending} onClick={() => { if (confirm(`清除 ${address.mailbox} 的全部邮件？\n\n地址和分享权限会保留。`)) clear.mutate(); }}><Trash2 className="h-3.5 w-3.5" />清空邮件</Button>}
        </div>
        {messages.isPending ? <div className="flex items-center gap-2 border-y border-zinc-200 py-8 text-sm text-zinc-400 dark:border-zinc-800"><Spinner />读取邮件</div>
          : messages.data?.messages.length ? <Card className="overflow-hidden">{messages.data.messages.map((message) => <HistoryItem key={message.id ?? message.receivedAt} message={message} onToast={onToast} />)}</Card>
          : <Empty>还没有邮件</Empty>}
      </section>
    </div>
  );
}

export function Addresses({
  apiKey,
  selectedMailbox,
  initialDomain,
  onSelect,
  onWatch,
  onToast,
}: {
  apiKey: string;
  selectedMailbox: string | null;
  initialDomain: string;
  onSelect: (mailbox: string | null) => void;
  onWatch: (mailbox: string, baselineAt: string | null) => void;
  onToast: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AddressFilter>("all");
  const [domain, setDomain] = useState(initialDomain);
  const result = useQuery({ queryKey: ["addresses"], queryFn: () => api.addresses(apiKey), refetchInterval: 15_000 });

  useEffect(() => setDomain(initialDomain), [initialDomain]);

  const all = result.data?.addresses ?? [];
  const domains = [...new Set(all.map((item) => item.domain))].sort();
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((item) => {
      if (domain && item.domain !== domain) return false;
      if (filter === "waiting" && !(item.registered && item.messages === 0)) return false;
      if (filter === "shared" && item.shares.length === 0 && !item.publicAccess) return false;
      return !needle || [item.mailbox, item.label, item.service, item.note, item.latestSender, item.latestSubject].some((value) => String(value ?? "").toLowerCase().includes(needle));
    });
  }, [all, domain, filter, query]);

  const selected = selectedMailbox ? all.find((item) => item.mailbox === selectedMailbox) : undefined;
  if (selectedMailbox && selected) return <AddressDetail apiKey={apiKey} address={selected} onBack={() => onSelect(null)} onWatch={() => onWatch(selected.mailbox, selected.lastActivity)} onToast={onToast} />;
  if (selectedMailbox && result.isPending) return <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner />读取地址</div>;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-400" />
          <Input className="pl-9" placeholder="搜索服务、备注或地址" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Select className="w-auto min-w-36" value={domain} onChange={(event) => setDomain(event.target.value)}>
          <option value="">全部域名</option>
          {domains.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
        <Segmented value={filter} options={[{ value: "all", label: "全部" }, { value: "waiting", label: "等码中" }, { value: "shared", label: "已分享" }]} onChange={setFilter} />
      </div>

      <div className="mb-3 flex items-baseline justify-between"><h1 className="text-sm font-semibold">地址</h1><span className="text-xs text-zinc-400">{visible.length} / {all.length}</span></div>
      {result.isPending ? <div className="flex items-center gap-2 border-y border-zinc-200 py-10 text-sm text-zinc-400 dark:border-zinc-800"><Spinner />读取地址</div>
        : result.error ? <Empty>加载失败：{result.error.message}</Empty>
        : visible.length === 0 ? <Empty>没有匹配的地址</Empty>
        : <Card className="overflow-hidden">{visible.map((address) => <AddressRow key={address.mailbox} address={address} onOpen={() => onSelect(address.mailbox)} onWatch={() => onWatch(address.mailbox, address.lastActivity)} onToast={onToast} />)}</Card>}
    </div>
  );
}
