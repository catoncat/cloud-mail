import PostalMime from "postal-mime";
import { extractCode, extractLink, stripHtml } from "./extract";

/**
 * Subset of the Workers Rate Limiting API we depend on.
 *
 * Declared locally rather than imported so the Worker still type-checks and
 * deploys on configs that predate the `ratelimits` binding.
 */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  DB: D1Database;
  MAIL_ADMIN_TOKEN: string;
  MAX_RAW_BYTES?: string;
  RETENTION_HOURS?: string;
  /** Optional: absent on deployments whose wrangler config has no `ratelimits` entry. */
  ADMIN_RATE_LIMIT?: RateLimiter;
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

interface MailboxSummaryRow {
  recipient: string;
  domain: string;
  local_part: string;
  messages: number;
  codes: number;
  last_activity: string;
  last_code: string;
  last_code_at: string;
  latest_sender: string;
  latest_subject: string;
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
/** Keep each DELETE bounded so a long-idle database cannot produce one huge statement. */
const CLEANUP_BATCH_SIZE = 500;
const CLEANUP_MAX_BATCHES = 20;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // D1 and JSON parsing both throw. Without this the runtime turns any failure
    // into an opaque 1101, so callers cannot tell a bug from a bad request.
    try {
      return await route(request, env);
    } catch (error) {
      console.error("request_failed", {
        method: request.method,
        path: new URL(request.url).pathname,
        error: errorMessage(error),
      });
      return json({ ok: false, error: "internal_error" }, 500);
    }
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    try {
      await handleEmail(message, env);
    } catch (error) {
      // Rethrow so Cloudflare retries genuinely transient failures (for example a
      // D1 outage), but leave a breadcrumb first: a silent retry loop is unreadable.
      console.error("email_failed", { recipient: message.to, error: errorMessage(error) });
      throw error;
    }
  },

  /**
   * Retention is a promise about data at rest, so it cannot depend on new mail arriving.
   * The cron trigger is what makes `RETENTION_HOURS` true for idle domains; the
   * ingestion path keeps its own throttled sweep as a backstop.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const deleted = await deleteExpiredMessages(env);
      await recordCleanupRun(env);
      if (deleted > 0) console.log("scheduled_cleanup", { deleted });
    } catch (error) {
      console.error("scheduled_cleanup_failed", { error: errorMessage(error) });
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
    return json({ ok: true, service: "cloud-mail-intake" });
  }

  if (!url.pathname.startsWith("/admin/")) {
    return text("Not found", 404);
  }

  // Before auth on purpose: this is what caps token guessing.
  const rateLimited = await enforceRateLimit(request, env);
  if (rateLimited) return rateLimited;

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

  if (request.method === "GET" && url.pathname === "/admin/recent-messages") {
    return listRecentMessages(url, env);
  }

  if (request.method === "GET" && url.pathname === "/admin/mailboxes") {
    return listMailboxes(url, env);
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
}

async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
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

  const maxBytes = parseMaxRawBytes(env);
  if (message.rawSize > maxBytes) {
    message.setReject("Message too large.");
    return;
  }

  const raw = await new Response(message.raw).text();
  // A message we cannot parse is still a message worth storing: the raw source is
  // kept and headers stand in for the envelope. Throwing here would hand the mail
  // back to the sender for endless redelivery, which no retry can fix.
  let parsed: Awaited<ReturnType<PostalMime["parse"]>> | null = null;
  try {
    parsed = await new PostalMime().parse(raw);
  } catch (error) {
    console.error("mime_parse_failed", { recipient, error: errorMessage(error) });
  }

  const subject = parsed?.subject ?? message.headers.get("subject") ?? "";
  const textBody = parsed?.text ?? "";
  const htmlBody = parsed?.html ?? "";
  // Extract from decoded bodies only. The raw MIME source carries tracking ids,
  // quoted-printable soft breaks, and xmlns URLs that masquerade as codes/links.
  const readable = textBody.trim() || stripHtml(htmlBody);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const sender = normalizeEmail(parsed?.from?.address ?? message.from);
  const messageId = message.headers.get("message-id") ?? "";
  const headersJson = JSON.stringify({
    from: message.from,
    to: message.to,
    date: message.headers.get("date") ?? "",
    message_id: messageId,
    subject,
  });

  // DO NOTHING makes redelivery idempotent against the (recipient, message_id)
  // unique index. Cloudflare retries on any thrown error, and a duplicated OTP
  // row is indistinguishable from a second real login attempt.
  await env.DB.prepare(
    `INSERT INTO messages
       (id, recipient, domain, local_part, sender, subject, received_at, raw_size, raw_truncated,
        raw, text_body, html_body, code, link, message_id, headers_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       ON CONFLICT DO NOTHING`,
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

  // After the write, so a cleanup failure can never cost us the message.
  await maybeDeleteExpiredMessages(env);
}

/**
 * Opportunistic sweep on the ingestion path, throttled across isolates by a CAS
 * on `maintenance_state`. The cron trigger is the guarantee; this only shortens
 * the window between scheduled runs on a busy deployment.
 */
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

  await deleteExpiredMessages(env);
}

/** Unconditional retention sweep. Returns the number of rows removed. */
async function deleteExpiredMessages(env: Env): Promise<number> {
  const cutoff = retentionCutoff(env);
  let deleted = 0;

  for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
    const result = await env.DB.prepare(
      `DELETE FROM messages
       WHERE id IN (SELECT id FROM messages WHERE received_at < ?1 LIMIT ?2)`,
    ).bind(cutoff, CLEANUP_BATCH_SIZE).run();
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < CLEANUP_BATCH_SIZE) break;
  }

  return deleted;
}

/** Keeps the ingestion-path throttle in step with cron-driven sweeps. */
async function recordCleanupRun(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO maintenance_state (key, value)
     VALUES ('last_message_cleanup', ?1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(String(Date.now())).run();
}

function retentionCutoff(env: Env): string {
  const configured = Number.parseInt(env.RETENTION_HOURS ?? "", 10);
  const retentionHours = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RETENTION_HOURS;
  return new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();
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

async function listRecentMessages(url: URL, env: Env): Promise<Response> {
  const limit = clampLimit(url.searchParams.get("limit"));
  const result = await env.DB.prepare(
    `SELECT ${messageProjection()} FROM messages
     ORDER BY received_at DESC
     LIMIT ?1`,
  ).bind(limit).all<MessageRow>();
  return json({ ok: true, items: result.results ?? [] });
}

/**
 * One compact row per observed recipient.
 *
 * The human console treats an address as the durable object. Keep this
 * aggregation next to D1 so callers never download every message body and
 * rebuild the same address book themselves.
 */
async function listMailboxes(url: URL, env: Env): Promise<Response> {
  const limit = clampLimit(url.searchParams.get("limit"), 1000);
  const result = await env.DB.prepare(
    `WITH ranked AS (
       SELECT id,
              recipient,
              domain,
              local_part,
              sender,
              subject,
              received_at,
              code,
              ROW_NUMBER() OVER (
                PARTITION BY recipient
                ORDER BY received_at DESC, id DESC
              ) AS latest_rank,
              ROW_NUMBER() OVER (
                PARTITION BY recipient
                ORDER BY CASE WHEN code != '' THEN 0 ELSE 1 END,
                         received_at DESC,
                         id DESC
              ) AS code_rank
       FROM messages
     )
     SELECT recipient,
            domain,
            local_part,
            COUNT(*) AS messages,
            SUM(CASE WHEN code != '' THEN 1 ELSE 0 END) AS codes,
            MAX(received_at) AS last_activity,
            MAX(CASE WHEN code_rank = 1 AND code != '' THEN code ELSE '' END) AS last_code,
            MAX(CASE WHEN code_rank = 1 AND code != '' THEN received_at ELSE '' END) AS last_code_at,
            MAX(CASE WHEN latest_rank = 1 THEN sender ELSE '' END) AS latest_sender,
            MAX(CASE WHEN latest_rank = 1 THEN subject ELSE '' END) AS latest_subject
     FROM ranked
     GROUP BY recipient, domain, local_part
     ORDER BY last_activity DESC
     LIMIT ?1`,
  ).bind(limit).all<MailboxSummaryRow>();

  return json({ ok: true, items: result.results ?? [] });
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
  const expected = typeof env.MAIL_ADMIN_TOKEN === "string" ? env.MAIL_ADMIN_TOKEN : "";
  // Fail closed, and say why. An unset secret used to be encoded as the literal
  // string "undefined", so `Authorization: Bearer undefined` authenticated. A 401
  // here would look like a wrong token and send operators hunting the wrong bug.
  if (!expected) {
    console.error("admin_token_not_configured");
    return json({ ok: false, error: "admin_token_not_configured" }, 503);
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/iu.exec(header);
  if (!match || !(await timingSafeEqual(match[1], expected))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

/**
 * Caps `/admin/*` traffic when a `ratelimits` binding is configured.
 *
 * Keyed by client IP because this runs before auth, where the caller's identity is
 * exactly what is still unproven. No-ops when the binding is absent so existing
 * deployments keep working without a config change.
 */
async function enforceRateLimit(request: Request, env: Env): Promise<Response | null> {
  const limiter = env.ADMIN_RATE_LIMIT;
  if (!limiter) return null;

  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key });
  if (success) return null;

  return json({ ok: false, error: "rate_limited" }, 429);
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

function clampLimit(input: string | null, max = MAX_LIMIT): number {
  const value = Number(input ?? DEFAULT_LIMIT);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(max, Math.trunc(value)));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
