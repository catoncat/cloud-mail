import type { Env, IntakeMessage, LatestMessage } from "./types";

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

export async function messagesByMailbox(env: Env, email: string, limit = 1): Promise<IntakeMessage[]> {
  const data = await call<{ items?: IntakeMessage[] }>(env, "/admin/messages", { email, limit: String(limit) });
  return data?.items ?? [];
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

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
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

/** Codes that are almost certainly CSS/hex noise rather than a real OTP. */
function looksLikeNoise(value: string): boolean {
  return /^(\d)\1{3,}$/.test(value) || /^(?:000000|ffffff|333333|666666|999999|cccccc)$/i.test(value);
}

export function extractCode(item: IntakeMessage, text: string, subject = ""): string | null {
  // Case is preserved verbatim: providers such as Notion issue case-sensitive codes.
  const body = text.trim();
  const raw = String(item.code ?? "").trim();

  // Notifications ("signed in on a new device") carry no code; never guess one.
  if (/已在新设备|new device|signed in|登录提醒|security alert/i.test(subject)) return null;

  // Prefer the visible body. A bare token on the first line is the common shape.
  const firstLine = body.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (/^[A-Za-z0-9]{4,10}$/.test(firstLine) && !looksLikeNoise(firstLine)) return firstLine;

  const dashed = body.match(/(?<![A-Za-z0-9])([A-Za-z0-9]{3}-[A-Za-z0-9]{3})(?![A-Za-z0-9])/);
  if (dashed) return dashed[1];

  const digits = body.match(/(?<!\d)(\d{4,8})(?!\d)/);
  if (digits && !looksLikeNoise(digits[1])) return digits[1];

  // Fall back to the upstream field only when the body gave us nothing usable.
  if (!body) return null;
  if (looksLikeNoise(raw)) return null;
  return /^[A-Za-z0-9-]{4,12}$/.test(raw) ? raw : null;
}

export function extractLink(item: IntakeMessage, html: string, text: string): string | null {
  const bogus = /w3\.org|schemas?\.|\.dtd$|\.xsd$|www\.=/i;
  const raw = String(item.link ?? "").trim();
  if (/^https?:\/\//i.test(raw) && !bogus.test(raw)) return raw;
  // Prefer links from the visible text body; fall back to href attributes.
  const candidates = [
    ...String(text).matchAll(/https?:\/\/[^\s"'<>]+/gi),
    ...String(html).matchAll(/href=["'](https?:\/\/[^"']+)["']/gi),
  ].map((m) =>
    (m[1] ?? m[0])
      .replace(/&amp;/g, "&")
      .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16))),
  );
  return candidates.find((u) => !bogus.test(u)) ?? null;
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
    code: extractCode(item, text, item.subject ?? "") ?? undefined,
    link: extractLink(item, html, text) ?? undefined,
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
