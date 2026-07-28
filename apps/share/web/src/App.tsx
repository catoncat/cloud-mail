import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AtSign, Plus, Radio, RefreshCw, Settings2 } from "lucide-react";
import { clearKey, getKey } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AddressView } from "@/lib/types";
import { Button, IconButton } from "@/components/ui";
import { CreateAddressDialog } from "@/components/CreateAddressDialog";
import type { ActiveWatch } from "@/components/WatchPanel";
import { Login } from "@/pages/Login";
import { Live } from "@/pages/Live";
import { Addresses } from "@/pages/Addresses";
import { System } from "@/pages/System";

type View = "live" | "addresses" | "system";

const NAV = [
  { id: "live" as const, label: "收码", icon: Radio },
  { id: "addresses" as const, label: "地址", icon: AtSign },
  { id: "system" as const, label: "系统", icon: Settings2 },
];

export function App() {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>("live");
  const [selectedMailbox, setSelectedMailbox] = useState<string | null>(null);
  const [addressDomain, setAddressDomain] = useState("");
  const [watch, setWatch] = useState<ActiveWatch | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    const saved = getKey();
    if (!saved) return setChecking(false);
    void fetch("/admin/api/overview", { headers: { authorization: `Bearer ${saved}` }, cache: "no-store" })
      .then((response) => { if (response.ok) setApiKey(saved); else clearKey(); })
      .catch(() => clearKey())
      .finally(() => setChecking(false));
  }, []);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2_400);
  }, []);

  const go = (next: View) => {
    setView(next);
    if (next !== "addresses") setSelectedMailbox(null);
    if (next === "addresses") {
      setSelectedMailbox(null);
      setAddressDomain("");
    }
  };

  const startWatch = (mailbox: string, baselineAt: string | null = null, startedAt = Date.now()) => {
    setWatch({ mailbox, baselineAt, startedAt });
    setView("live");
    setSelectedMailbox(null);
  };

  const openAddress = (mailbox: string) => {
    setSelectedMailbox(mailbox);
    setAddressDomain("");
    setView("addresses");
  };

  const handleCreated = (address: AddressView) => {
    const createdAt = address.createdAt ? Date.parse(address.createdAt) : Date.now();
    startWatch(address.mailbox, address.lastActivity, Number.isFinite(createdAt) ? createdAt : Date.now());
  };

  if (checking) return <div className="grid min-h-screen place-items-center text-sm text-zinc-400">载入中…</div>;
  if (!apiKey) return <Login initialKey={getKey()} onSuccess={setApiKey} />;

  const pageTitle = selectedMailbox || NAV.find((item) => item.id === view)?.label || "收码";

  return (
    <div className="grid min-h-screen md:grid-cols-[216px_minmax(0,1fr)]">
      <aside className="fixed inset-x-0 bottom-0 z-10 flex gap-1 border-t border-zinc-200 bg-white p-1.5 md:static md:flex-col md:gap-0.5 md:border-r md:border-t-0 md:p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="hidden items-center gap-2 px-2 pb-4 pt-1 md:flex">
          <div className="grid h-6 w-6 place-items-center rounded-md bg-zinc-900 text-[11px] font-bold text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900">M</div>
          <span className="text-[13px] font-semibold">控制台</span>
        </div>

        <nav className="flex flex-1 gap-1 md:flex-none md:flex-col md:gap-0.5" aria-label="主导航">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors md:w-full md:flex-none md:justify-start",
                view === id
                  ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-50",
              )}
              aria-current={view === id ? "page" : undefined}
              onClick={() => go(id)}
            >
              <Icon className="h-4 w-4" />{label}
            </button>
          ))}
        </nav>

        <button
          className="mt-auto hidden border-t border-zinc-100 px-2.5 pt-2.5 text-left text-xs text-zinc-400 hover:text-zinc-900 md:block dark:border-zinc-800 dark:hover:text-zinc-50"
          onClick={() => { clearKey(); location.reload(); }}
        >
          退出
        </button>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-[5] flex h-[52px] items-center justify-between gap-4 border-b border-zinc-200 bg-zinc-50/85 px-4 backdrop-blur md:px-6 dark:border-zinc-800 dark:bg-zinc-950/85">
          <span className="min-w-0 truncate text-[13px] font-semibold">{pageTitle}</span>
          <div className="flex shrink-0 items-center gap-2">
            <IconButton label="刷新" onClick={() => void qc.invalidateQueries()}><RefreshCw className="h-3.5 w-3.5" /></IconButton>
            <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}><Plus className="h-3.5 w-3.5" />新地址</Button>
          </div>
        </header>

        <main className="px-4 pb-24 pt-5 md:px-6 md:pb-12">
          {view === "live" ? (
            <Live
              apiKey={apiKey}
              watch={watch}
              onCreate={() => setCreateOpen(true)}
              onWatch={(mailbox, baselineAt) => startWatch(mailbox, baselineAt)}
              onStopWatch={() => setWatch(null)}
              onOpenAddress={openAddress}
              onToast={notify}
            />
          ) : view === "addresses" ? (
            <Addresses
              apiKey={apiKey}
              selectedMailbox={selectedMailbox}
              initialDomain={addressDomain}
              onSelect={setSelectedMailbox}
              onWatch={(mailbox, baselineAt) => startWatch(mailbox, baselineAt)}
              onToast={notify}
            />
          ) : (
            <System
              apiKey={apiKey}
              onOpenDomain={(domain) => { setAddressDomain(domain); setSelectedMailbox(null); setView("addresses"); }}
              onToast={notify}
            />
          )}
        </main>
      </div>

      <CreateAddressDialog
        apiKey={apiKey}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
        onToast={notify}
      />

      {toast && (
        <div className="fixed bottom-20 left-1/2 z-[60] -translate-x-1/2 rounded-md bg-zinc-900 px-3 py-2 text-xs font-medium text-white shadow-lg md:bottom-6 dark:bg-zinc-50 dark:text-zinc-900">
          {toast}
        </div>
      )}
    </div>
  );
}
