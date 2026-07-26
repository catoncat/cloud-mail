import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { copyText, timeAgo } from "@/lib/utils";
import { Button, Card, Empty, Row, Spinner } from "@/components/ui";

export function Links({ apiKey, onToast }: { apiKey: string; onToast: (m: string) => void }) {
  const qc = useQueryClient();
  const { data, isPending, error } = useQuery({ queryKey: ["links"], queryFn: () => api.links(apiKey) });

  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteLink(apiKey, id),
    onSuccess: () => {
      onToast("已撤销");
      void qc.invalidateQueries({ queryKey: ["links"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => onToast(`撤销失败：${e.message}`),
  });

  if (isPending) return <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner /> 载入中</div>;
  if (error) return <Empty>加载失败：{error.message}</Empty>;
  if (data.links.length === 0) return <Empty>还没有分享链接</Empty>;

  return (
    <>
      <div className="mb-2.5 flex items-baseline justify-between">
        <span className="text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300">外发链接</span>
        <span className="text-xs text-zinc-400">{data.links.length} 条</span>
      </div>
      <Card>
        {data.links.map((l) => (
          <Row key={l.id}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[13px]">{l.mailbox}</div>
              <div className="mt-0.5 truncate text-xs text-zinc-400">{l.label && `${l.label} · `}{timeAgo(l.createdAt)}</div>
            </div>
            <Button size="sm" onClick={async () => onToast((await copyText(l.url)) ? "已复制" : "复制失败")}>复制</Button>
            <Button size="sm" variant="danger" disabled={revoke.isPending}
              onClick={() => {
                // Name the target: several links often point at the same mailbox and
                // only the label distinguishes them.
                const target = l.label ? `${l.mailbox}（${l.label}）` : l.mailbox;
                if (confirm(`撤销 ${target} 的分享链接？\n\n对方将立即无法再查看验证码，此操作不可恢复。`)) revoke.mutate(l.id);
              }}>撤销</Button>
          </Row>
        ))}
      </Card>
    </>
  );
}
