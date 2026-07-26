import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { copyText, timeAgo } from "@/lib/utils";
import { Button, Card, Code, Empty, Row, Spinner } from "@/components/ui";

export function Mailboxes({ apiKey, domain, onToast }: { apiKey: string; domain: string; onToast: (m: string) => void }) {
  const qc = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: ["mailboxes", domain],
    queryFn: () => api.mailboxes(apiKey, domain),
    refetchInterval: 15_000,
  });

  const share = useMutation({
    mutationFn: (mailbox: string) => api.createLink(apiKey, mailbox, "console"),
    onSuccess: async (link) => {
      onToast((await copyText(link.url)) ? "链接已生成并复制" : "链接已生成");
      void qc.invalidateQueries({ queryKey: ["mailboxes", domain] });
      void qc.invalidateQueries({ queryKey: ["links"] });
    },
    onError: (e) => onToast(`生成失败：${e.message}`),
  });

  if (isPending) return <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner /> 载入中</div>;
  if (error) return <Empty>加载失败：{error.message}</Empty>;
  if (data.mailboxes.length === 0) return <Empty>该域名下没有邮箱收到邮件</Empty>;

  return (
    <>
      <div className="mb-2.5 flex items-baseline justify-between">
        <span className="text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300">邮箱</span>
        <span className="text-xs text-zinc-400">{data.mailboxes.length} 个</span>
      </div>
      <Card>
        {data.mailboxes.map((m) => (
          <Row key={m.mailbox}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[13px]">{m.localPart}</div>
              <div className="mt-0.5 truncate text-xs text-zinc-400">
                {m.service && `${m.service} · `}{timeAgo(m.lastActivity)} · {m.messages} 封
              </div>
            </div>
            {m.lastCode && <Code>{m.lastCode}</Code>}
            <Button size="sm" onClick={async () => onToast((await copyText(m.mailbox)) ? "已复制邮箱" : "复制失败")}>邮箱</Button>
            {m.shareUrl ? (
              <Button size="sm" onClick={async () => onToast((await copyText(m.shareUrl!)) ? "已复制链接" : "复制失败")}>链接</Button>
            ) : (
              <Button size="sm" variant="primary" disabled={share.isPending} onClick={() => share.mutate(m.mailbox)}>分享</Button>
            )}
          </Row>
        ))}
      </Card>
    </>
  );
}
