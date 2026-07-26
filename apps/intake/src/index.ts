import PostalMime from "postal-mime";
import { extractCode, extractLink, stripHtml } from "./extract";

interface Env {
  DB: D1Database;
  MAIL_ADMIN_TOKEN: string;
  MAX_RAW_BYTES?: string;
  RETENTION_HOURS?: string;
}

interface DomainRow {
  domain: string;
  zone: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  recipient: string;
  domain: string;
  local_part: string;
  sender: string;
  subject: string;
  received_at: string;
  raw_size: number;
  raw_truncated: number;
  raw: string;
  text_body: string;
  html_body: string;
  code: string;
  link: string;
  message_id: string;
  headers_json: string;
}

interface ForwardRow {
  domain: string;
  zone: string;
  destination: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const DEFAULT_MAX_RAW_BYTES = 1_048_576;
const DEFAULT_RETENTION_HOURS = 6;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      return json({ ok: true, service: "cloud-mail-intake" });
    }

    if (!url.pathname.startsWith("/admin/")) {
      return text("Not found", 404);
    }

    const authError = await requireAdmin(request, env);
    if (authError) return authError;

    if (request.method === "GET" && url.pathname === "/admin/domains") {
      return listDomains(env);
    }

    if (request.method === "POST" && url.pathname === "/admin/domains") {
      return upsertDomain(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/forwards") {
      return listForwards(env);
    }

    if (request.method === "POST" && url.pathname === "/admin/forwards") {
      return upsertForward(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/messages") {
      return listMessages(url, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/latest-code") {
      return latestField(url, env, "code");
    }

    if (request.method === "GET" && url.pathname === "/admin/latest-link") {
      return latestField(url, env, "link");
    }

    if (request.method === "DELETE" && url.pathname === "/admin/messages") {
      return deleteMessages(url, env);
    }

    if (request.method === "POST" && url.pathname === "/admin/reindex") {
      return reindexMessages(url, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/stats") {
      return messageStats(env);
    }

    return text("Not found", 404);
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const recipient = normalizeEmail(message.to);
    const parts = splitEmail(recipient);
    if (!parts) {
      message.setReject("Invalid recipient.");
      return;
    }

    const domain = await getDomain(parts.domain, env);
    if (!domain || !domain.enabled) {
      const forward = await getForward(parts.domain, env);
      if (forward?.enabled && forward.destination) {
        await message.forward(forward.destination);
        return;
      }
      message.setReject("Recipient domain is not configured.");
      return;
    }

    await maybeDeleteExpiredMessages(env);

    const maxBytes = parseMaxRawBytes(env);
    if (message.rawSize > maxBytes) {
      message.setReject("Message too large.");
      return;
    }

    const raw = await new Response(message.raw).text();
    const parsed = await new PostalMime().parse(raw);
    const subject = parsed.subject ?? message.headers.get("subject") ?? "";
    const textBody = parsed.text ?? "";
    const htmlBody = parsed.html ?? "";
    // Extract from decoded bodies only. The raw MIME source carries tracking ids,
    // quoted-printable soft breaks, and xmlns URLs that masquerade as codes/links.
    const readable = textBody.trim() || stripHtml(htmlBody);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const sender = normalizeEmail(parsed.from?.address ?? message.from);
    const messageId = message.headers.get("message-id") ?? "";
    const headersJson = JSON.stringify({
      from: message.from,
      to: message.to,
      date: message.headers.get("date") ?? "",
      message_id: messageId,
      subject,
    });

    await env.DB.prepare(
      `INSERT INTO messages
       (id, recipient, domain, local_part, sender, subject, received_at, raw_size, raw_truncated,
        raw, text_body, html_body, code, link, message_id, headers_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    ).bind(
      id,
      recipient,
      parts.domain,
      parts.localPart,
      sender,
      subject,
      now,
      message.rawSize,
      raw,
      textBody,
      htmlBody,
      extractCode(readable, subject),
      extractLink(readable, htmlBody),
      messageId,
      headersJson,
    ).run();
  },
} satisfies ExportedHandler<Env>;

async function maybeDeleteExpiredMessages(env: Env): Promise<void> {
  const now = Date.now();
  const claimed = await env.DB.prepare(
    `INSERT INTO maintenance_state (key, value)
     VALUES ('last_message_cleanup', ?1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value
     WHERE CAST(maintenance_state.value AS INTEGER) <= ?2
     RETURNING value`,
  ).bind(String(now), String(now - CLEANUP_INTERVAL_MS)).first();
  if (!claimed) return;

  const configured = Number.parseInt(env.RETENTION_HOURS ?? "", 10);
  const retentionHours = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RETENTION_HOURS;
  const cutoff = new Date(now - retentionHours * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM messages WHERE received_at < ?1").bind(cutoff).run();
}

async function listDomains(env: Env): Promise<Response> {
  const result = await env.DB.prepare("SELECT * FROM domains ORDER BY domain ASC").all<DomainRow>();
  return json({ ok: true, items: result.results ?? [] });
}

async function listForwards(env: Env): Promise<Response> {
  const result = await env.DB.prepare("SELECT * FROM forwards ORDER BY domain ASC").all<ForwardRow>();
  return json({ ok: true, items: result.results ?? [] });
}

async function upsertDomain(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ domain?: string; zone?: string; enabled?: boolean | number }>(request);
  const domain = normalizeDomain(body?.domain ?? "");
  if (!domain) return json({ ok: false, error: "domain_required" }, 400);
  const zone = normalizeDomain(body?.zone ?? "") || domain;
  const enabled = body?.enabled === undefined ? 1 : Number(Boolean(body.enabled));
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO domains (domain, zone, enabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(domain) DO UPDATE SET
       zone = excluded.zone,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).bind(domain, zone, enabled, now).run();

  return json({ ok: true, domain, zone, enabled: Boolean(enabled) });
}

async function upsertForward(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ domain?: string; zone?: string; destination?: string; enabled?: boolean | number }>(
    request,
  );
  const domain = normalizeDomain(body?.domain ?? "");
  const destination = normalizeEmail(body?.destination ?? "");
  if (!domain) return json({ ok: false, error: "domain_required" }, 400);
  if (!destination || !splitEmail(destination)) return json({ ok: false, error: "destination_required" }, 400);
  const zone = normalizeDomain(body?.zone ?? "") || domain;
  const enabled = body?.enabled === undefined ? 1 : Number(Boolean(body.enabled));
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO forwards (domain, zone, destination, enabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(domain) DO UPDATE SET
       zone = excluded.zone,
       destination = excluded.destination,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).bind(domain, zone, destination, enabled, now).run();

  return json({ ok: true, domain, zone, destination, enabled: Boolean(enabled) });
}

async function listMessages(url: URL, env: Env): Promise<Response> {
  const email = normalizeEmail(url.searchParams.get("email") ?? "");
  const domain = normalizeDomain(url.searchParams.get("domain") ?? "");
  const limit = clampLimit(url.searchParams.get("limit"));

  if (email) {
    const result = await env.DB.prepare(
      `SELECT ${messageProjection()} FROM messages
       WHERE recipient = ?1
       ORDER BY received_at DESC
       LIMIT ?2`,
    ).bind(email, limit).all<MessageRow>();
    return json({ ok: true, items: result.results ?? [] });
  }

  if (domain) {
    const result = await env.DB.prepare(
      `SELECT ${messageProjection()} FROM messages
       WHERE domain = ?1
       ORDER BY received_at DESC
       LIMIT ?2`,
    ).bind(domain, limit).all<MessageRow>();
    return json({ ok: true, items: result.results ?? [] });
  }

  return json({ ok: false, error: "email_or_domain_required" }, 400);
}

async function latestField(url: URL, env: Env, field: "code" | "link"): Promise<Response> {
  const email = normalizeEmail(url.searchParams.get("email") ?? "");
  if (!email) return json({ ok: false, error: "email_required" }, 400);

  const row = await env.DB.prepare(
    `SELECT id, recipient, subject, received_at, ${field}
     FROM messages
     WHERE recipient = ?1 AND ${field} != ''
     ORDER BY received_at DESC
     LIMIT 1`,
  ).bind(email).first<Record<string, string>>();

  // Say so explicitly. Callers must be able to tell "no code in this mailbox"
  // apart from success, otherwise an empty string reads as a valid answer.
  if (!row) {
    return json({ ok: false, error: `no_${field}_found`, item: null, [field]: "" }, 404);
  }

  return json({ ok: true, item: row, [field]: row[field] });
}

async function deleteMessages(url: URL, env: Env): Promise<Response> {
  const email = normalizeEmail(url.searchParams.get("email") ?? "");
  if (!email) return json({ ok: false, error: "email_required" }, 400);
  const result = await env.DB.prepare("DELETE FROM messages WHERE recipient = ?1").bind(email).run();
  return json({ ok: true, changes: result.meta.changes ?? 0 });
}

/**
 * Per-domain counters for dashboards.
 *
 * Aggregates in SQL so callers never download message bodies just to count them:
 * fetching every row to compute totals does not survive real mail volume.
 */
async function messageStats(env: Env): Promise<Response> {
  const now = new Date();
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const weekStart = new Date(now.getTime() - 7 * 86400_000).toISOString();

  const result = await env.DB.prepare(
    `SELECT domain,
            COUNT(*) AS messages,
            COUNT(DISTINCT recipient) AS mailboxes,
            SUM(CASE WHEN code != '' THEN 1 ELSE 0 END) AS codes,
            SUM(CASE WHEN code != '' AND received_at >= ?1 THEN 1 ELSE 0 END) AS codes_today,
            SUM(CASE WHEN code != '' AND received_at >= ?2 THEN 1 ELSE 0 END) AS codes_week,
            MAX(received_at) AS last_activity
     FROM messages
     GROUP BY domain`,
  )
    .bind(dayStart, weekStart)
    .all<Record<string, string | number>>();

  return json({ ok: true, items: result.results ?? [] });
}

/**
 * Recompute code/link for stored messages using the current extractor.
 *
 * Needed because rows written before the extractor was fixed hold values scraped
 * from raw MIME (tracking ids, CSS colours, truncated xmlns URLs). Runs the same
 * code path as ingestion, so results cannot drift from live behaviour.
 * Pass ?dry=1 to preview the changes without writing.
 */
async function reindexMessages(url: URL, env: Env): Promise<Response> {
  const dry = url.searchParams.get("dry") === "1";
  const requested = Number(url.searchParams.get("limit") ?? 500);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(1000, Math.trunc(requested))) : 500;
  const email = normalizeEmail(url.searchParams.get("email") ?? "");

  const rows = email
    ? await env.DB.prepare(
        "SELECT id, subject, text_body, html_body, code, link FROM messages WHERE recipient = ?1 ORDER BY received_at DESC LIMIT ?2",
      )
        .bind(email, limit)
        .all<MessageRow>()
    : await env.DB.prepare(
        "SELECT id, subject, text_body, html_body, code, link FROM messages ORDER BY received_at DESC LIMIT ?1",
      )
        .bind(limit)
        .all<MessageRow>();

  const changed: Array<{ id: string; code: [string, string]; link: [string, string] }> = [];
  const updates: D1PreparedStatement[] = [];

  for (const row of rows.results ?? []) {
    const subject = String(row.subject ?? "");
    const html = String(row.html_body ?? "");
    const readable = String(row.text_body ?? "").trim() || stripHtml(html);
    const code = extractCode(readable, subject);
    const link = extractLink(readable, html);
    const oldCode = String(row.code ?? "");
    const oldLink = String(row.link ?? "");
    if (code === oldCode && link === oldLink) continue;

    changed.push({ id: String(row.id), code: [oldCode, code], link: [oldLink, link] });
    updates.push(
      env.DB.prepare("UPDATE messages SET code = ?1, link = ?2 WHERE id = ?3").bind(code, link, row.id),
    );
  }

  if (!dry && updates.length > 0) await env.DB.batch(updates);

  return json({
    ok: true,
    dry,
    scanned: (rows.results ?? []).length,
    updated: dry ? 0 : changed.length,
    changes: changed.slice(0, 50),
  });
}

async function getDomain(domain: string, env: Env): Promise<DomainRow | null> {
  return env.DB.prepare("SELECT * FROM domains WHERE domain = ?1 LIMIT 1").bind(domain).first<DomainRow>();
}

async function getForward(domain: string, env: Env): Promise<ForwardRow | null> {
  return env.DB.prepare("SELECT * FROM forwards WHERE domain = ?1 LIMIT 1").bind(domain).first<ForwardRow>();
}

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/iu.exec(header);
  if (!match || !(await timingSafeEqual(match[1], env.MAIL_ADMIN_TOKEN))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return left.length === right.length && diff === 0;
}

function messageProjection(): string {
  return [
    "id",
    "recipient",
    "domain",
    "local_part",
    "sender",
    "subject",
    "received_at",
    "raw_size",
    "raw_truncated",
    "text_body",
    "html_body",
    "code",
    "link",
    "message_id",
  ].join(", ");
}

function splitEmail(email: string): { localPart: string; domain: string } | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return { localPart: email.slice(0, at), domain: normalizeDomain(email.slice(at + 1)) };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeDomain(domain: string): string {
  return String(domain).trim().toLowerCase().replace(/^@/u, "");
}

function clampLimit(input: string | null): number {
  const value = Number(input ?? DEFAULT_LIMIT);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
}

function parseMaxRawBytes(env: Env): number {
  const value = Number(env.MAX_RAW_BYTES ?? DEFAULT_MAX_RAW_BYTES);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_MAX_RAW_BYTES;
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
