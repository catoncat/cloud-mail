import { Hono } from "hono";
import { listDomains } from "../lib/intake";
import * as store from "../lib/store";
import type { Env } from "../lib/types";
import { normalizeDomain } from "../lib/validate";

/** Public-facing API consumed by register bots. Auth is separate from the console key. */
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

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = [enc.encode(a), enc.encode(b)];
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

service.use("*", async (c, next) => {
  // Accept the dedicated service token, or fall back to the console key.
  const expected = [c.env.SERVICE_TOKEN, c.env.ADMIN_KEY].filter((v): v is string => Boolean(v));
  const header = c.req.header("authorization") ?? "";
  const provided = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? c.req.header("x-service-token") ?? "";
  if (!provided) return c.json({ error: "unauthorized" }, 401);
  for (const candidate of expected) {
    if (await constantTimeEqual(candidate, provided)) return next();
  }
  return c.json({ error: "unauthorized" }, 401);
});

/**
 * Claim domains for a registration run.
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
