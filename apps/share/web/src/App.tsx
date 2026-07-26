import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, Inbox as InboxIcon, LayoutDashboard, RefreshCw, Share2, Workflow } from "lucide-react";
import { clearKey, getKey } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui";
import { Login } from "@/pages/Login";
import { Overview } from "@/pages/Overview";
import { Domains } from "@/pages/Domains";
import { Mailboxes } from "@/pages/Mailboxes";
import { Links } from "@/pages/Links";
import { Inbox } from "@/pages/Inbox";
import { Services } from "@/pages/Services";

type View = "overview" | "inbox" | "domains" | "services" | "links";

const NAV = [
  { id: "overview" as const, label: "概览", icon: LayoutDashboard },
  { id: "inbox" as const, label: "收件", icon: InboxIcon },
  { id: "domains" as const, label: "域名", icon: Globe },
  { id: "services" as const, label: "服务", icon: Workflow },
  { id: "links" as const, label: "分享", icon: Share2 },
];

export function App() {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>("overview");
  const [domain, setDomain] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    const saved = getKey();
    if (!saved) return setChecking(false);
    void fetch("/admin/api/overview", { headers: { authorization: `Bearer ${saved}` }, cache: "no-store" })
      .then((r) => { if (r.ok) setApiKey(saved); else clearKey(); })
      .catch(() => clearKey())
      .finally(() => setChecking(false));
  }, []);

  const notify = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2200);
  }, []);

  const go = (v: View) => { setView(v); setDomain(null); };

  if (checking) return <div className="grid min-h-screen place-items-center text-sm text-zinc-400">载入中…</div>;
  if (!apiKey) return <Login initialKey={getKey()} onSuccess={setApiKey} />;

  return (
    <div className="grid min-h-screen md:grid-cols-[216px_minmax(0,1fr)]">
      <aside className="fixed inset-x-0 bottom-0 z-10 flex gap-1 border-t border-zinc-200 bg-white p-1.5 md:static md:flex-col md:gap-0.5 md:border-r md:border-t-0 md:p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="hidden items-center gap-2 px-2 pb-4 pt-1 md:flex">
          <div className="grid h-6 w-6 place-items-center rounded-md bg-zinc-900 text-[11px] font-bold text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900">M</div>
          <span className="text-[13px] font-semibold">控制台</span>
        </div>
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => go(id)}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors md:flex-none md:justify-start",
              view === id && !domain
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-50",
            )}>
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
        <button onClick={() => { clearKey(); location.reload(); }}
          className="mt-auto hidden border-t border-zinc-100 px-2.5 pt-2.5 text-left text-xs text-zinc-400 hover:text-zinc-900 md:block dark:border-zinc-800 dark:hover:text-zinc-50">
          退出
        </button>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-[5] flex h-[52px] items-center justify-between gap-4 border-b border-zinc-200 bg-zinc-50/85 px-4 backdrop-blur md:px-6 dark:border-zinc-800 dark:bg-zinc-950/85">
          <nav className="flex min-w-0 items-center gap-1.5 text-[13px]">
            {domain ? (
              <>
                <button className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50" onClick={() => setDomain(null)}>域名</button>
                <span className="text-zinc-300 dark:text-zinc-700">/</span>
                <span className="truncate font-mono font-semibold">{domain}</span>
              </>
            ) : (
              <span className="font-semibold">{NAV.find((n) => n.id === view)?.label}</span>
            )}
          </nav>
          <div className="flex shrink-0 items-center gap-2.5">
            {toast && <span className="text-xs tabular-nums text-zinc-400">{toast}</span>}
            <Button size="sm" onClick={() => void qc.invalidateQueries()}>
              <RefreshCw className="h-3.5 w-3.5" />刷新
            </Button>
          </div>
        </header>

        <main className="px-4 pb-24 pt-5 md:px-6 md:pb-12">
          {domain ? <Mailboxes apiKey={apiKey} domain={domain} onToast={notify} />
            : view === "overview" ? <Overview apiKey={apiKey} onOpenDomain={setDomain} />
            : view === "inbox" ? <Inbox apiKey={apiKey} onToast={notify} />
            : view === "domains" ? <Domains apiKey={apiKey} onOpenDomain={setDomain} onToast={notify} />
            : view === "services" ? <Services apiKey={apiKey} />
            : <Links apiKey={apiKey} onToast={notify} />}
        </main>
      </div>
    </div>
  );
}
