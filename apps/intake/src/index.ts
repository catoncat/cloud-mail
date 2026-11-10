import { WorkerEntrypoint } from "cloudflare:workers";
import PostalMime from "postal-mime";
import { extractCode, extractLink, stripHtml } from "./extract";
import { latestFieldFromMirror, rememberLatest } from "./mirror";
import { listingProjection } from "./projection";

interface Env {
  DB: D1Database;
  MAIL_CODES?: KVNamespace;
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
  /** 1 when the listing served a shortened body (see listingProjection). */
  body_truncated?: number;
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

/**
 * The console polls these two listings every couple of seconds, and the first is a
 * window-function GROUP BY over every message. At ~35,000 calls a day that was the
 * account's whole D1 row-read budget (5.83M rows on 2026-10-12, against a 5M free
 * limit), which took the mail down for the day. The Cache API is counted on its own
 * quota, so a poll inside the TTL costs no D1 rows at all.
 *
 * The TTL also decides how often the poll pays for a cache miss, and on the free
 * plan a miss has to fit in 10ms of CPU. A miss expensive enough to be killed can
 * never write its entry, so every poll after it misses too: on 2026-11-08 one such
 * miss turned into 2,752 killed requests in four hours. Keep the miss cheap
 * (listingProjection) and the TTL long.
 *
 * /admin/latest-code is deliberately NOT cached: a stale code is a failed login.
 */
const LISTING_TTL = { mailboxes: 300, recent: 300, stats: 30 };

/**
 * Cache hits are logged once every HIT_LOG_EVERY, misses always.
 *
 * The console polls a filtered listing every few seconds, so an unsampled hit log
 * is by far the largest source of log events here, and the free plan stops
 * recording after 200k events a day — the misses are the ones worth keeping.
 */
const HIT_LOG_EVERY = 20;
let cacheHits = 0;

/** One cached copy per URL and TTL. A miss (or a cache that cannot store) still serves. */
async function cachedListing(url: URL, ttlSeconds: number, produce: () => Promise<Response>): Promise<Response> {
  const key = new Request(`https://intake.internal${url.pathname}${url.search}`);
  let cached: Response | null = null;
  try {
    cached = (await caches.default.match(key)) ?? null;
  } catch {
    cached = null;
  }
  const at = Number(cached?.headers.get("x-intake-cached-at") ?? 0);
  const fresh = Boolean(cached && at && Date.now() - at < ttlSeconds * 1000);
  const ageSeconds = at ? Math.round((Date.now() - at) / 1000) : null;
  // The state is logged because "is this worker's cache doing anything at all" is
  // otherwise unanswerable from outside: the Cache API needs no quota, so a hit
  // shows up as zero D1 rows read, not as anything a caller can see.
  if (cached && fresh) {
    if ((cacheHits += 1) % HIT_LOG_EVERY === 0) {
      console.log("listing", { path: url.pathname, state: "hit", ageSeconds });
    }
    return answer(await cached.text(), at, "hit");
  }
  console.log("listing", { path: url.pathname, state: "miss", entry: Boolean(cached), ageSeconds });

  const produced = await produce();
  if (!produced.ok) return produced; // an error is never worth caching
  const body = await produced.text();
  const now = Date.now();
  try {
    await caches.default.put(key, new Response(body, {
      headers: { "content-type": "application/json; charset=utf-8", "x-intake-cached-at": String(now) },
    }));
  } catch (error) {
    console.log("listing_cache_write_failed", { path: url.pathname, error: errorMessage(error) });
  }
  return answer(body, now, "miss");
}

function answer(body: string, at: number, state: "hit" | "miss"): Response {
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-intake-cache": state,
      "x-intake-cached-at": String(at),
    },
  });
}

const DEFAULT_RETENTION_HOURS = 6;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
/** Keep each DELETE bounded so a long-idle database cannot produce one huge statement. */
const CLEANUP_BATCH_SIZE = 500;
const CLEANUP_MAX_BATCHES = 20;
const DEFAULT_LIMIT = 20;
/**
 * Hard cap for one listing request.
 *
 * 100 rows of listingProjection is ~90 KB of JSON for a real mailbox; the same 100
 * rows with full bodies measured 1.5 MB (2.4 MB during the 2026-11-08 flood), which
 * is 20-30 ms of CPU and over the free plan's 10 ms budget.
 */
const MAX_LIMIT = 100;

/**
 * The JSON API, reachable only through the share Worker's Service Binding.
 *
 * Named entrypoints are unreachable from the internet — only a binding that names
 * this class can call it — so the binding itself is the credential.
 */
export class InternalApi extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return handle(request, this.env);
  }
}

export default {
  /** No public HTTP surface: the Worker has no route, and this answers if one is ever added. */
  async fetch(): Promise<Response> {
    return text("Not found", 404);
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

async function handle(request: Request, env: Env): Promise<Response> {
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
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
    return json({ ok: true, service: "cloud-mail-intake" });
  }

  if (!url.pathname.startsWith("/admin/")) {
    return text("Not found", 404);
  }

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
    // Deliberately uncached. The console deletes rows from this same listing, and a
    // cached page would hand them straight back for the length of its TTL; the call
    // is made cheap by asking for one page of rows (see /admin/api/messages) and by
    // poll intervals that match it, not by serving stale mail.
    return listMessages(url, env);
  }

  if (request.method === "GET" && url.pathname === "/admin/recent-messages") {
    return cachedListing(url, LISTING_TTL.recent, () => listRecentMessages(url, env));
  }

  if (request.method === "GET" && url.pathname === "/admin/mailboxes") {
    return cachedListing(url, LISTING_TTL.mailboxes, () => listMailboxes(url, env));
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
    return cachedListing(url, LISTING_TTL.stats, () => messageStats(env));
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
  const code = extractCode(readable, subject);
  const link = extractLink(readable, htmlBody);

  // The mirror comes BEFORE the first database read, not merely before the write:
  // while the account's daily row-read quota is out, even the domain lookup below
  // throws, and a code that only lives in a failed write is a code nobody reads.
  // Never fatal: losing the mirror is worth less than losing the mail.
  try {
    // the same life as the row the database keeps, no longer, so the mirror can
    // never answer with a code the retention sweep has already deleted
    await rememberLatest(env.MAIL_CODES, recipient, { received_at: now, subject, code, link }, retentionHours(env) * 3600);
  } catch (error) {
    console.error("mirror_write_failed", { recipient, error: errorMessage(error) });
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
    code,
    link,
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

function retentionHours(env: Env): number {
  const configured = Number.parseInt(env.RETENTION_HOURS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RETENTION_HOURS;
}

function retentionCutoff(env: Env): string {
  return new Date(Date.now() - retentionHours(env) * 60 * 60 * 1000).toISOString();
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
      `SELECT ${listingProjection()} FROM messages
       WHERE recipient = ?1
       ORDER BY received_at DESC
       LIMIT ?2`,
    ).bind(email, limit).all<MessageRow>();
    return json({ ok: true, items: result.results ?? [] });
  }

  if (domain) {
    const result = await env.DB.prepare(
      `SELECT ${listingProjection()} FROM messages
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
    `SELECT ${listingProjection()} FROM messages
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

  let row: Record<string, string> | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT id, recipient, subject, received_at, ${field}
       FROM messages
       WHERE recipient = ?1 AND ${field} != ''
       ORDER BY received_at DESC
       LIMIT 1`,
    ).bind(email).first<Record<string, string>>();
  } catch (error) {
    // Out of the account's daily row-read quota, which takes the database away for
    // hours: the KV mirror of the newest code/link answers instead, so an
    // unattended sign-in still gets what arrived after this deploy.
    const answer = await latestFieldFromMirror(env.MAIL_CODES, email, field);
    console.error("db_read_failed", { email, field, mirrored: answer.status === 200, error: errorMessage(error) });
    return json(answer.body, answer.status);
  }

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
