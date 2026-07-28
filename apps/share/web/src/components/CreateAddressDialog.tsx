import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Copy, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { copyText } from "@/lib/utils";
import type { AddressView } from "@/lib/types";
import { Button, Dialog, Input, Select, Spinner } from "@/components/ui";

const LAST_DOMAIN = "cloudMailLastDomain";

export function CreateAddressDialog({
  apiKey,
  open,
  onClose,
  onCreated,
  onToast,
}: {
  apiKey: string;
  open: boolean;
  onClose: () => void;
  onCreated: (address: AddressView) => void;
  onToast: (message: string) => void;
}) {
  const qc = useQueryClient();
  const [service, setService] = useState("");
  const [domain, setDomain] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [label, setLabel] = useState("");
  const [custom, setCustom] = useState(false);

  const domains = useQuery({
    queryKey: ["domains"],
    queryFn: () => api.domains(apiKey),
    enabled: open,
  });

  useEffect(() => {
    if (!open || domain || !domains.data) return;
    let saved = "";
    try { saved = localStorage.getItem(LAST_DOMAIN) ?? ""; } catch { /* ignore */ }
    const enabled = domains.data.domains.filter((item) => item.enabled);
    setDomain(enabled.some((item) => item.domain === saved) ? saved : enabled[0]?.domain ?? "");
  }, [domain, domains.data, open]);

  const create = useMutation({
    mutationFn: () => api.createAddress(apiKey, {
      domain: domain || undefined,
      service: service || undefined,
      localPart: custom ? localPart : undefined,
      label: label || undefined,
    }),
    onSuccess: async (address) => {
      try { localStorage.setItem(LAST_DOMAIN, address.domain); } catch { /* ignore */ }
      const copied = await copyText(address.mailbox);
      onToast(copied ? "地址已复制，正在等码" : "地址已创建");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["addresses"] }),
        qc.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      setService("");
      setLocalPart("");
      setLabel("");
      setCustom(false);
      onClose();
      onCreated(address);
    },
    onError: (error) => onToast(`创建失败：${error.message}`),
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!domain || (custom && !localPart.trim()) || create.isPending) return;
    create.mutate();
  }

  const enabled = domains.data?.domains.filter((item) => item.enabled) ?? [];

  return (
    <Dialog open={open} title="新地址" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">服务或用途</span>
            <Input autoFocus placeholder="Notion、Grok、测试账号" value={service} onChange={(event) => setService(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">收信域名</span>
            {domains.isPending ? (
              <div className="flex h-10 items-center gap-2 text-sm text-zinc-400"><Spinner />读取中</div>
            ) : (
              <Select value={domain} onChange={(event) => setDomain(event.target.value)} disabled={enabled.length === 0}>
                {enabled.map((item) => <option key={item.domain} value={item.domain}>{item.domain}</option>)}
              </Select>
            )}
          </label>
        </div>

        <button
          type="button"
          className="mt-4 flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
          onClick={() => setCustom((value) => !value)}
        >
          {custom ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          自定义
        </button>

        {custom && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">@ 前的地址</span>
              <Input className="font-mono" placeholder="notion-team" value={localPart} onChange={(event) => setLocalPart(event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">账号备注</span>
              <Input placeholder="团队版、客户 A" value={label} onChange={(event) => setLabel(event.target.value)} />
            </label>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" disabled={!domain || enabled.length === 0 || create.isPending}>
            {create.isPending ? <><Spinner />创建中</> : <><Plus className="h-4 w-4" /><Copy className="h-3.5 w-3.5" />创建并复制</>}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
