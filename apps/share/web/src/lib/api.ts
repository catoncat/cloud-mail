import type { AddressView, DomainHealth, DomainStat, LinkView, MailboxStat, MessageFeed, Overview, UsageReport, Zone } from "./types";

const KEY_STORAGE = "mailAdminKey";

export function getKey(): string {
  try { return localStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; }
}
export function setKey(key: string) {
  try { localStorage.setItem(KEY_STORAGE, key); } catch { /* private mode */ }
}
export function clearKey() {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* private mode */ }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    cache: "no-store",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

export const api = {
  verify: (key: string) => request<Overview>("/overview", key),
  overview: (key: string) => request<Overview>("/overview", key),
  addresses: (key: string) => request<{ addresses: AddressView[] }>("/addresses", key),
  createAddress: (key: string, input: { domain?: string; localPart?: string; label?: string; service?: string; note?: string }) =>
    request<AddressView>("/addresses", key, { method: "POST", body: JSON.stringify(input) }),
  updateAddress: (key: string, mailbox: string, input: { label?: string; service?: string; note?: string }) =>
    request<AddressView>(`/addresses/${encodeURIComponent(mailbox)}`, key, { method: "PATCH", body: JSON.stringify(input) }),
  clearAddressMessages: (key: string, mailbox: string) =>
    request<{ ok: boolean; changes: number }>(`/addresses/${encodeURIComponent(mailbox)}/messages`, key, { method: "DELETE" }),
  domains: (key: string) => request<{ domains: DomainStat[] }>("/domains", key),
  mailboxes: (key: string, domain: string) =>
    request<{ mailboxes: MailboxStat[] }>(`/domains/${encodeURIComponent(domain)}/mailboxes`, key),
  domainHealth: (key: string, domain: string) =>
    request<DomainHealth>(`/domains/${encodeURIComponent(domain)}/health`, key),
  links: (key: string) => request<{ links: LinkView[] }>("/links", key),
  messages: (key: string, params: { page?: number; size?: number; domain?: string; mailbox?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, String(v));
    return request<MessageFeed>(`/messages?${q}`, key);
  },
  zones: (key: string) => request<{ zones: Zone[]; configured: string[] }>("/zones", key),
  addDomain: (key: string, domain: string) =>
    request<{ ok: boolean; domain: string; dnsReady: boolean; followUp: { command: string } | null }>(
      "/domains", key, { method: "POST", body: JSON.stringify({ domain }) },
    ),
  usage: (key: string) => request<UsageReport>("/usage", key),
  createLink: (key: string, mailbox: string, label?: string) =>
    request<LinkView>("/links", key, { method: "POST", body: JSON.stringify({ mailbox, label }) }),
  deleteLink: (key: string, id: string) => request<{ ok: boolean }>(`/links/${id}`, key, { method: "DELETE" }),
  allowMailbox: (key: string, mailbox: string, label?: string) =>
    request<{ created: Array<{ mailbox: string; url: string }> }>("/mailboxes", key, {
      method: "POST",
      body: JSON.stringify({ mailbox, label }),
    }),
  revokeMailbox: (key: string, mailbox: string) =>
    request<{ ok: boolean; mailbox: string }>(`/mailboxes/${encodeURIComponent(mailbox)}`, key, { method: "DELETE" }),
};
