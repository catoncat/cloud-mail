import type { Env, IntakeMessage, LatestMessage, MailboxSummary } from "./types";

function origin(env: Env): string {
  const u = new URL(env.INTAKE_ORIGIN);
  u.pathname = u.pathname.replace(/\/+$/, "");
  u.search = "";
  return u.toString();
}

async function call<T>(env: Env, path: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(path, origin(env));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json", authorization: `Bearer ${env.MAIL_INTAKE_ADMIN_TOKEN}` },
  });
  if (!res.ok) return null;
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { ok?: boolean } & T;
    return parsed.ok === false ? null : parsed;
  } catch {
    return null;
  }
}

export async function listDomains(env: Env): Promise<Array<{ domain: string; enabled: boolean }>> {
  const data = await call<{ items?: Array<{ domain?: string; enabled?: number | boolean }> }>(env, "/admin/domains", {});
  return (data?.items ?? [])
    .map((i) => ({ domain: String(i.domain ?? "").toLowerCase(), enabled: Boolean(i.enabled) }))
    .filter((i) => i.domain);
}

export async function messagesByDomain(env: Env, domain: string, limit = 500): Promise<IntakeMessage[]> {
  const data = await call<{ items?: IntakeMessage[] }>(env, "/admin/messages", { domain, limit: String(limit) });
  return data?.items ?? [];
}

export async function recentMessages(env: Env, limit = 50): Promise<IntakeMessage[]> {
  const data = await call<{ items?: IntakeMessage[] }>(env, "/admin/recent-messages", { limit: String(limit) });
  return data?.items ?? [];
}

export async function mailboxSummaries(env: Env, limit = 1000): Promise<MailboxSummary[]> {
  const data = await call<{
    items?: Array<{
      recipient?: string;
      domain?: string;
      local_part?: string;
      messages?: number;
      codes?: number;
      last_activity?: string;
      last_code?: string;
      last_code_at?: string;
      latest_sender?: string;
      latest_subject?: string;
    }>;
  }>(env, "/admin/mailboxes", { limit: String(limit) });

  return (data?.items ?? []).flatMap((row) => {
    const mailbox = String(row.recipient ?? "").toLowerCase();
    const domain = String(row.domain ?? "").toLowerCase();
    if (!mailbox || !domain) return [];
    return [{
      mailbox,
      localPart: String(row.local_part ?? mailbox.split("@")[0] ?? ""),
      domain,
      messages: Number(row.messages ?? 0),
      codes: Number(row.codes ?? 0),
      lastActivity: row.last_activity || null,
      lastCode: row.last_code || null,
      lastCodeAt: row.last_code_at || null,
      latestSender: String(row.latest_sender ?? ""),
      latestSubject: String(row.latest_subject ?? ""),
    } satisfies MailboxSummary];
  });
}

export interface DomainCounters {
  domain: string;
  messages: number;
  mailboxes: number;
  codes: number;
  codesToday: number;
  codesWeek: number;
  lastActivity: string | null;
}

/**
 * Per-domain counters aggregated by intake in SQL.
 *
 * Dashboards must use this rather than counting messages client-side: pulling
 * every body back just to length-check it does not survive real mail volume.
 */
export async function domainCounters(env: Env): Promise<Map<string, DomainCounters>> {
  const data = await call<{
    items?: Array<{
      domain?: string;
      messages?: number;
      mailboxes?: number;
      codes?: number;
      codes_today?: number;
      codes_week?: number;
      last_activity?: string | null;
    }>;
  }>(env, "/admin/stats", {});

  const out = new Map<string, DomainCounters>();
  for (const row of data?.items ?? []) {
    const domain = String(row.domain ?? "").toLowerCase();
    if (!domain) continue;
    out.set(domain, {
      domain,
      messages: Number(row.messages ?? 0),
      mailboxes: Number(row.mailboxes ?? 0),
      codes: Number(row.codes ?? 0),
      codesToday: Number(row.codes_today ?? 0),
      codesWeek: Number(row.codes_week ?? 0),
      lastActivity: row.last_activity ?? null,
    });
  }
  return out;
}

export async function messagesByMailbox(env: Env, email: string, limit = 1): Promise<IntakeMessage[]> {
  const data = await call<{ items?: IntakeMessage[] }>(env, "/admin/messages", { email, limit: String(limit) });
  return data?.items ?? [];
}

export async function deleteMailboxMessages(env: Env, email: string): Promise<number> {
  const url = new URL("/admin/messages", origin(env));
  url.searchParams.set("email", email);
  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: { accept: "application/json", authorization: `Bearer ${env.MAIL_INTAKE_ADMIN_TOKEN}` },
  });
  if (!res.ok) throw new Error(`intake_delete_failed_${res.status}`);
  const data = await res.json<{ changes?: number }>();
  return Number(data.changes ?? 0);
}

const SERVICES: Array<[RegExp, string]> = [
  [/notion/i, "Notion"],
  [/\bx\.ai\b|xai|grok/i, "Grok"],
  [/openai|chatgpt/i, "OpenAI"],
  [/anthropic|claude/i, "Claude"],
  [/github/i, "GitHub"],
  [/google|gmail/i, "Google"],
  [/microsoft|outlook/i, "Microsoft"],
];

export function guessService(sender = "", subject = ""): string | null {
  const hay = `${sender} ${subject}`;
  for (const [re, name] of SERVICES) if (re.test(hay)) return name;
  return null;
}

/**
 * Display-side fallbacks.
 *
 * Extraction is intake's job — it sees the decoded MIME and is the single source
 * of truth. These only cover messages stored before the extractor was fixed, so
 * historical rows do not render stale garbage. Once backfilled they never fire.
 */

function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/\s(?:style|bgcolor|color|width|height)\s*=\s*"[^"]*"/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Values intake used to emit before it stopped guessing: CSS greys, soft breaks. */
const LEGACY_NOISE = /^(?:(\d)\1{3,}|000000|ffffff|333333|666666|999999|cccccc)$/i;
const LEGACY_BOGUS_LINK = /\bw3\.org|\bschemas?[-.]|www\.=|[./=]=$/i;

function usableCode(raw: string): string | null {
  const value = raw.trim();
  if (!value || LEGACY_NOISE.test(value)) return null;
  return /^[A-Za-z0-9][A-Za-z0-9-]{2,11}$/.test(value) ? value : null;
}

function usableLink(raw: string): string | null {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value) || LEGACY_BOGUS_LINK.test(value)) return null;
  return value;
}

export function toLatest(item: IntakeMessage, mailbox: string): LatestMessage {
  const html = String(item.html_body ?? "");
  const text = String(item.text_body ?? "").trim() || stripHtml(html);
  return {
    id: item.id ?? null,
    from: item.sender ?? "",
    to: item.recipient ?? mailbox,
    subject: item.subject ?? "",
    receivedAt: item.received_at ?? "",
    text,
    code: usableCode(String(item.code ?? "")) ?? undefined,
    link: usableLink(String(item.link ?? "")) ?? undefined,
  };
}

/** Register a recipient domain in the intake allowlist. */
export async function upsertIntakeDomain(env: Env, domain: string, zone: string): Promise<void> {
  const url = new URL("/admin/domains", origin(env));
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.MAIL_INTAKE_ADMIN_TOKEN}` },
    body: JSON.stringify({ domain, zone, enabled: true }),
  });
  if (!res.ok) throw new Error(`intake_upsert_failed_${res.status}`);
}
