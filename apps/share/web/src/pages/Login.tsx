import { useState } from "react";
import { api, ApiError, setKey as persist } from "@/lib/api";
import { Button, Input } from "@/components/ui";

export function Login({ onSuccess, initialKey = "" }: { onSuccess: (key: string) => void; initialKey?: string }) {
  const [value, setValue] = useState(initialKey);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(true);

  async function submit() {
    const key = value.trim();
    if (!key) return setError("请输入管理密钥");
    setBusy(true);
    setError("");
    try {
      await api.verify(key);
      if (remember) persist(key);
      onSuccess(key);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "密钥无效" : "无法连接服务，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-[340px]">
        <div className="mb-5 grid h-9 w-9 place-items-center rounded-lg bg-zinc-900 text-sm font-bold text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900">M</div>
        <h1 className="text-[17px] font-semibold tracking-tight">控制台</h1>
        <p className="mb-5 mt-1 text-[13px] text-zinc-500">输入管理密钥继续</p>

        <Input
          type="password"
          className="font-mono"
          placeholder="密钥"
          value={value}
          autoComplete="current-password"
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) void submit(); }}
        />

        <div className="mt-3 flex items-center justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-zinc-500">
            <input type="checkbox" className="h-3.5 w-3.5 accent-zinc-900 dark:accent-zinc-50" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住
          </label>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>

        <Button variant="primary" className="mt-3 w-full" disabled={busy} onClick={() => void submit()}>
          {busy ? "验证中…" : "继续"}
        </Button>
      </div>
    </div>
  );
}
