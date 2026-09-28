import { type Context, Hono } from "hono";
import { requireSecret } from "../lib/auth";
import { automationHelp } from "../lib/help";
import { latestField, listDomains, messagesByMailbox } from "../lib/intake";
import {
  domainNotAvailable,
  type Field,
  isFresh,
  parseLatestQuery,
  parseMessagesQuery,
  pickAddress,
  pollFresh,
  secureRandomInt,
} from "../lib/receive";
import * as store from "../lib/store";
import type { Env } from "../lib/types";
import { normalizeDomain } from "../lib/validate";

/** Service API for automation clients. Auth is separate from the operator key. */
export const service = new Hono<{ Bindings: Env }>();

const SERVICE_RE = /^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/i;

/** Body parsing must never throw; fields are validated below. */
async function body<T extends object>(c: { req: { json: <U>() => Promise<U> } }): Promise<Partial<T>> {
  try {
    return await c.req.json<Partial<T>>();
  } catch {
    return {};
  }
}

/** Public on purpose: an agent handed only the URL must be able to learn the API. */
const help = (c: Context<{ Bindings: Env }>) =>
  c.body(automationHelp(new URL(c.req.url).origin), 200, { "content-type": "text/markdown; charset=utf-8" });
service.get("/", help);
service.get("/help", help);

service.use("*", requireSecret("AUTOMATION_TOKEN", "Send Authorization: Bearer <token>. Usage: GET /api/v1/help"));

async function enabledDomains(env: Env): Promise<string[]> {
  return (await listDomains(env)).filter((d) => d.enabled).map((d) => d.domain);
}

/** A random address on an enabled domain. Catch-all routing means it already receives mail. */
service.post("/addresses", async (c) => {
  const input = await body<{ domain: string }>(c);
  const address = pickAddress(await enabledDomains(c.env), input.domain, secureRandomInt);
  return c.json(address, address.ok ? 200 : 400);
});

/**
 * Newest code or link for one address, optionally held open until a fresh one lands.
 * "Nothing yet" is an answer, so it is 200 with ok:false rather than an HTTP error.
 */
async function latest(c: Context<{ Bindings: Env }>, field: Field) {
  const query = parseLatestQuery(c.req.query(), Date.now());
  if (!query.ok) return c.json(query, 400);
  const unavailable = domainNotAvailable(query.email, await enabledDomains(c.env));
  if (unavailable) return c.json(unavailable, 400);

  const item = await pollFresh(() => latestField(c.env, query.email, field), query);
  if (!item) return c.json({ ok: false, error: `no_${field}_found`, item: null, [field]: "" });
  return c.json({ ok: true, [field]: item[field] ?? "", item });
}

service.get("/code", (c) => latest(c, "code"));
service.get("/link", (c) => latest(c, "link"));

/** Full stored mail for one address. Only by address: this token cannot browse a domain. */
service.get("/messages", async (c) => {
  const query = parseMessagesQuery(c.req.query(), Date.now());
  if (!query.ok) return c.json(query, 400);
  const unavailable = domainNotAvailable(query.email, await enabledDomains(c.env));
  if (unavailable) return c.json(unavailable, 400);

  const items = await messagesByMailbox(c.env, query.email, query.limit);
  return c.json({ ok: true, items: items.filter((m) => isFresh(m.received_at, query.since)) });
});

/**
 * Claim domains for an automation run.
 * Domains are shared: claiming records attribution, it does not lock anything.
 */
service.post("/domains/claim", async (c) => {
  const input = await body<{ service: string; count: number; domain: string }>(c);

  const name = String(input.service ?? "").trim();
  if (!SERVICE_RE.test(name)) {
    return c.json({ error: "invalid_service", hint: "3-40 chars, letters/digits/._-" }, 400);
  }

  const available = (await listDomains(c.env)).filter((d) => d.enabled).map((d) => d.domain);
  if (available.length === 0) return c.json({ error: "no_domains_available" }, 503);

  // Explicit request for one domain.
  const wanted = normalizeDomain(input.domain);
  if (wanted) {
    if (!available.includes(wanted)) return c.json({ error: "domain_not_available", available }, 400);
    await store.recordClaim(c.env, name, wanted);
    return c.json({ service: name, domains: [wanted] });
  }

  const count = Math.min(Math.max(Number(input.count) || 1, 1), 20);

  // Prefer least-recently-used domains so traffic spreads across the pool.
  const usage = await store.domainUsage(c.env);
  const lastUse = new Map(usage.map((u) => [u.domain, u.services[0]?.lastAt ?? ""]));
  const ordered = [...available].sort((a, b) => (lastUse.get(a) ?? "").localeCompare(lastUse.get(b) ?? ""));

  const picked = Array.from({ length: count }, (_, i) => ordered[i % ordered.length]);
  await Promise.all([...new Set(picked)].map((d) => store.recordClaim(c.env, name, d)));

  return c.json({ service: name, domains: picked });
});

/** Full pool without recording a claim. */
service.get("/domains", async (c) => {
  const domains = (await listDomains(c.env)).filter((d) => d.enabled).map((d) => d.domain);
  return c.json({ domains });
});
