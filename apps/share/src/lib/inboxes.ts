/**
 * The one thing agents use: make an address, then read what arrives there.
 *
 * Both agent surfaces (/mcp and /api/v1) call these, so the rules live here once:
 * an address belongs to the tenant that created it, permanently; a tenant sees
 * only mail received after it created the address; and wait hands out the newest
 * mail it has not handed out before, with its exact received time, leaving
 * "is this the code I just asked for" to the agent.
 */

import { listDomains, messagesByMailbox, toLatest } from "./intake";
import { isFresh, MAX_WAIT_SECONDS, pollFresh, randomLocalPart, secureRandomInt } from "./receive";
import * as store from "./store";
import { inScope } from "./tenants";
import type { Env, IntakeMessage, Tenant } from "./types";
import { normalizeLocalPart, normalizeMailbox } from "./validate";

export const DEFAULT_READ = 5;
export const MAX_READ = 20;
export const MAX_TEXT = 4000;

/**
 * Role names that prove control of a domain: certificate authorities and other
 * services send ownership checks to them. A tenant must never receive those.
 */
const RESERVED = new Set([
  "abuse",
  "admin",
  "administrator",
  "hostmaster",
  "mailer-daemon",
  "noc",
  "postmaster",
  "root",
  "security",
  "webmaster",
]);

/** A rejected request: a stable code, an HTTP status, and the literal fix. */
export class InboxError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409 | 503;
  readonly hint: string;

  constructor(code: string, status: 400 | 404 | 409 | 503, hint: string) {
    super(code);
    this.name = "InboxError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export type Mail = {
  id: string | null;
  from: string;
  subject: string;
  received_at: string;
  age_seconds: number;
  code: string | null;
  link: string | null;
  text: string;
};

export type WaitResult = ({ status: "received" } & Mail) | { status: "waiting"; hint: string };

type Clock = { now?: () => number; sleep?: (ms: number) => Promise<void> };

export async function createInbox(env: Env, tenant: Tenant, name?: unknown): Promise<{ email: string; created_at: string }> {
  const wanted = name === undefined || name === null || name === "" ? null : normalizeLocalPart(name);
  if (wanted === "") {
    throw new InboxError(
      "invalid_name",
      400,
      "name is 1-40 of a-z 0-9 . _ - and starts and ends with a letter or digit. Omit it for a random address.",
    );
  }
  if (wanted && RESERVED.has(wanted)) {
    throw new InboxError("name_reserved", 409, "Role names such as admin and postmaster are reserved. Pick another name, or omit it.");
  }

  const domains = (await listDomains(env))
    .filter((d) => d.enabled && inScope(d.domain, tenant.domains))
    .map((d) => d.domain);
  if (!domains.length) {
    throw new InboxError("no_domains_available", 503, "No receiving domain is enabled for this token. Ask the operator.");
  }

  const createdAt = new Date().toISOString();
  if (wanted) {
    const taken = await takenDomains(env, wanted);
    for (const domain of shuffle(domains.filter((d) => !taken.has(d)))) {
      const email = `${wanted}@${domain}`;
      if (await store.isOperatorMailbox(env, email)) continue;
      if (await claim(env, email, tenant.id, createdAt)) return { email, created_at: createdAt };
    }
    throw new InboxError("name_taken", 409, "That name is taken on every domain this token can use. Pick another name, or omit it.");
  }

  // Twelve random characters: a collision is practically impossible, but the claim stays atomic anyway.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const email = `${randomLocalPart(secureRandomInt)}@${domains[secureRandomInt(domains.length)]}`;
    if (await claim(env, email, tenant.id, createdAt)) return { email, created_at: createdAt };
  }
  throw new Error("random_address_collision");
}

/**
 * The newest mail this tenant has not been handed yet, held open up to `timeoutSeconds`.
 *
 * Each answer moves the inbox past that mail, so the next call returns only
 * something newer: a resend is simply another call.
 */
export async function waitForEmail(
  env: Env,
  tenant: Tenant,
  email: unknown,
  timeoutSeconds?: unknown,
  clock: Clock = {},
): Promise<WaitResult> {
  const inbox = await ownedInbox(env, tenant, email);
  const waitMs = clamp(timeoutSeconds, 0, MAX_WAIT_SECONDS, MAX_WAIT_SECONDS) * 1000;
  const since = inbox.deliveredAt ? Date.parse(inbox.deliveredAt) + 1 : Date.parse(inbox.createdAt);

  const item = await pollFresh(async () => (await messagesByMailbox(env, inbox.email, 1))[0] ?? null, {
    since,
    waitMs,
    ...clock,
  });
  if (!item?.received_at) {
    return { status: "waiting", hint: `Nothing new in ${waitMs / 1000}s. Call again with the same email; some senders take a minute.` };
  }

  await env.DB.prepare("UPDATE inboxes SET delivered_at = ?1 WHERE email = ?2 AND (delivered_at IS NULL OR delivered_at < ?1)")
    .bind(item.received_at, inbox.email)
    .run();
  return { status: "received", ...toMail(item, inbox.email, (clock.now ?? Date.now)()) };
}

/** Recent mail, newest first. Reading never moves what wait hands out next. */
export async function readInbox(env: Env, tenant: Tenant, email: unknown, limit?: unknown): Promise<{ messages: Mail[] }> {
  const inbox = await ownedInbox(env, tenant, email);
  const items = await messagesByMailbox(env, inbox.email, clamp(limit, 1, MAX_READ, DEFAULT_READ));
  const createdAt = Date.parse(inbox.createdAt);
  const now = Date.now();
  return {
    messages: items.filter((m) => isFresh(m.received_at, createdAt)).map((m) => toMail(m, inbox.email, now)),
  };
}

async function ownedInbox(
  env: Env,
  tenant: Tenant,
  email: unknown,
): Promise<{ email: string; createdAt: string; deliveredAt: string | null }> {
  const address = normalizeMailbox(email);
  if (!address) throw new InboxError("invalid_email", 400, "Pass the email that create_inbox returned.");
  const row = await env.DB.prepare("SELECT created_at, delivered_at FROM inboxes WHERE email = ?1 AND tenant_id = ?2")
    .bind(address, tenant.id)
    .first<{ created_at: string; delivered_at: string | null }>();
  if (!row) {
    throw new InboxError("inbox_not_found", 404, "This token can only read addresses it created. Call create_inbox for a new one.");
  }
  return { email: address, createdAt: row.created_at, deliveredAt: row.delivered_at };
}

/** First come, first served, for good: the insert either takes the address or changes nothing. */
async function claim(env: Env, email: string, tenantId: string, createdAt: string): Promise<boolean> {
  const result = await env.DB.prepare("INSERT INTO inboxes (email, tenant_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING")
    .bind(email, tenantId, createdAt)
    .run();
  return result.meta.changes > 0;
}

/** Domains on which some tenant already owns `<name>@`. */
async function takenDomains(env: Env, name: string): Promise<Set<string>> {
  const pattern = `${name.replace(/[\\%_]/g, (ch) => `\\${ch}`)}@%`;
  const { results } = await env.DB.prepare("SELECT email FROM inboxes WHERE email LIKE ?1 ESCAPE '\\'")
    .bind(pattern)
    .all<{ email: string }>();
  return new Set(results.map((row) => row.email.slice(row.email.indexOf("@") + 1)));
}

function toMail(item: IntakeMessage, mailbox: string, now: number): Mail {
  const mail = toLatest(item, mailbox);
  return {
    id: mail.id,
    from: mail.from,
    subject: mail.subject,
    received_at: mail.receivedAt,
    age_seconds: Math.max(0, Math.round((now - Date.parse(mail.receivedAt)) / 1000)),
    code: mail.code ?? null,
    link: mail.link ?? null,
    text: mail.text.length > MAX_TEXT ? `${mail.text.slice(0, MAX_TEXT)}…` : mail.text,
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = secureRandomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
