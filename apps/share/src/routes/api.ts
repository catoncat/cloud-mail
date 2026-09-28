import { Hono } from "hono";
import { createAddress, AddressModelError, getAddressView, listAddressViews, updateAddress } from "../lib/addresses";
import { domainStats, mailboxStats, overview } from "../lib/aggregate";
import { requireSecret } from "../lib/auth";
import {
  deleteMailboxMessages,
  forwardToIntake,
  listDomains,
  messagesByDomain,
  messagesByMailbox,
  recentMessages,
  toLatest,
  upsertIntakeDomain,
} from "../lib/intake";
import {
  CloudflareError,
  enableEmailRouting,
  findZone,
  getCatchAll,
  hasRoutingMx,
  listZones,
  setCatchAll,
} from "../lib/cloudflare";
import { type Check, followUpFor, readiness, type RoutingStatus } from "../lib/domains";
import * as store from "../lib/store";
import type { Env } from "../lib/types";
import { createLinkId, isValidLinkId, normalizeDomain, normalizeMailbox, splitMailboxes } from "../lib/validate";

/** Body parsing must never throw; missing fields are validated downstream. */
async function body<T extends object>(c: { req: { json: <U>() => Promise<U> } }): Promise<Partial<T>> {
  try {
    return await c.req.json<Partial<T>>();
  } catch {
    return {};
  }
}

export const api = new Hono<{ Bindings: Env }>();

api.use("*", requireSecret("OPERATOR_KEY"));

/** Intake's own JSON API, relayed verbatim for the `cloud-mail` CLI. */
api.all("/intake/*", (c) => forwardToIntake(c.env, c.req.raw, c.req.path.slice("/admin/api/intake".length)));

api.get("/overview", async (c) => {
  const origin = new URL(c.req.url).origin;
  const links = await store.listLinks(c.env, origin);
  return c.json(await overview(c.env, origin, links.length));
});

api.get("/addresses", async (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({ addresses: await listAddressViews(c.env, origin) });
});

api.post("/addresses", async (c) => {
  const input = await body<{ domain: string; localPart: string; label: string; service: string; note: string }>(c);
  try {
    return c.json(await createAddress(c.env, new URL(c.req.url).origin, input), 201);
  } catch (error) {
    return addressError(c, error);
  }
});

api.patch("/addresses/:mailbox", async (c) => {
  const input = await body<{ label: string; service: string; note: string }>(c);
  try {
    await updateAddress(c.env, c.req.param("mailbox"), input);
    const origin = new URL(c.req.url).origin;
    const address = await getAddressView(c.env, origin, c.req.param("mailbox"));
    return address ? c.json(address) : c.json({ error: "address_not_found" }, 404);
  } catch (error) {
    return addressError(c, error);
  }
});

api.delete("/addresses/:mailbox/messages", async (c) => {
  const mailbox = normalizeMailbox(c.req.param("mailbox"));
  if (!mailbox) return c.json({ error: "invalid_mailbox" }, 400);
  try {
    return c.json({ ok: true, changes: await deleteMailboxMessages(c.env, mailbox) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "intake_delete_failed" }, 502);
  }
});

api.get("/domains", async (c) => c.json({ domains: await domainStats(c.env) }));

/** Cloudflare zones available for adding new mail domains. */
api.get("/zones", async (c) => {
  try {
    const [zones, configured] = await Promise.all([listZones(c.env), listDomains(c.env)]);
    return c.json({ zones, configured: configured.map((d) => d.domain) });
  } catch (err) {
    const message = err instanceof CloudflareError ? err.message : "cloudflare_error";
    return c.json({ error: message, zones: [] }, message === "cloudflare_token_missing" ? 501 : 502);
  }
});

/**
 * Register a mail domain in the intake allowlist and configure Email Routing.
 *
 * When `CF_API_TOKEN` is available:
 * 1. Find the Cloudflare zone that owns the domain.
 * 2. Enable Email Routing DNS records for the domain.
 * 3. Point the zone catch-all at the intake Worker (idempotent PUT).
 * 4. Confirm public DNS shows the Cloudflare MX records for the domain.
 * 5. Register the domain in the intake allowlist.
 *
 * `dnsReady` needs both the catch-all and the MX records.
 *
 * When `CF_API_TOKEN` is absent or Cloudflare refuses a step, the domain is still
 * allowlisted and `followUp` names the fix. Every step is idempotent, so rerunning
 * after the fix is always safe.
 */
api.post("/domains", async (c) => {
  const input = await body<{ domain: string }>(c);
  const domain = normalizeDomain(input.domain);
  if (!domain) return c.json({ ok: false, error: "invalid_domain" }, 400);

  const checks: Check[] = [];
  let zoneName = domain;
  let routed = false;
  let mxReady = false;

  try {
    const zone = await findZone(c.env, domain);
    if (!zone) {
      return c.json({ ok: false, error: "zone_not_found", hint: "No active zone in this Cloudflare account owns this domain. List them with: cloud-mail zones" }, 400);
    }
    zoneName = zone.name;
    checks.push({ step: "zone", ok: true, detail: zone.name });

    // Step 2: Enable Email Routing DNS
    try {
      await enableEmailRouting(c.env, zone, domain);
      checks.push({ step: "email_routing_dns", ok: true });
    } catch (err) {
      // Some zones already have routing enabled — a 4xx here is not fatal.
      const detail = err instanceof Error ? err.message : "unknown";
      checks.push({ step: "email_routing_dns", ok: false, detail });
    }

    // Step 3: Set catch-all → intake Worker
    try {
      await setCatchAll(c.env, zone);
      routed = true;
      checks.push({ step: "catch_all", ok: true, detail: "enabled -> cloud-mail-intake" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown";
      checks.push({ step: "catch_all", ok: false, detail });
      // Still check current state — maybe it was already set.
      const catchAll = await getCatchAll(c.env, zone.id);
      routed = catchAll?.enabled === true && catchAll.target === "cloud-mail-intake";
    }

    try {
      mxReady = await hasRoutingMx(domain);
      checks.push({ step: "mx", ok: mxReady, detail: mxReady ? "route*.mx.cloudflare.net" : "no_cloudflare_mx" });
    } catch (err) {
      checks.push({ step: "mx", ok: false, detail: err instanceof Error ? err.message : "dns_lookup_failed" });
    }
  } catch (err) {
    // CF_API_TOKEN missing → graceful degradation.
    const detail = err instanceof Error ? err.message : "cloudflare_error";
    checks.push({ step: "zone", ok: false, detail });
  }

  try {
    await upsertIntakeDomain(c.env, domain, zoneName);
    checks.push({ step: "allowlist", ok: true });
  } catch (err) {
    checks.push({ step: "allowlist", ok: false, detail: err instanceof Error ? err.message : "unknown" });
    return c.json({ ok: false, error: "allowlist_failed", checks }, 502);
  }

  const dnsReady = routed && mxReady;
  return c.json(
    {
      ok: true,
      domain,
      zone: zoneName,
      dnsReady,
      checks,
      followUp: dnsReady ? null : followUpFor(domain, checks),
    },
    201,
  );
});

/**
 * Live routing health for one domain.
 *
 * "No mail yet" and "mail cannot arrive" look identical in the message counts,
 * so read Email Routing directly. Without this a misrouted domain silently looks
 * like an idle one. `ready` also requires the intake allowlist to accept it.
 */
api.get("/domains/:domain/health", async (c) => {
  const domain = normalizeDomain(c.req.param("domain"));
  if (!domain) return c.json({ ok: false, error: "invalid_domain" }, 400);

  const [routing, domains] = await Promise.all([routingHealth(c.env, domain), listDomains(c.env)]);
  const allowlist = domains.find((entry) => entry.domain === domain);
  return c.json({ domain, ...routing, ...readiness(routing.status, allowlist) });
});

async function routingHealth(env: Env, domain: string): Promise<{ status: RoutingStatus; zone?: string; detail: string }> {
  try {
    const zone = await findZone(env, domain);
    if (!zone) return { status: "unknown", detail: "zone_not_found" };

    const catchAll = await getCatchAll(env, zone.id);
    if (!catchAll) return { status: "unrouted", zone: zone.name, detail: "not_configured" };

    const routed = catchAll.enabled && catchAll.target === "cloud-mail-intake";
    const rule = `${catchAll.enabled ? "enabled" : "disabled"} -> ${catchAll.target || "none"}`;
    if (!routed) return { zone: zone.name, status: "unrouted", detail: rule };

    const mx = await hasRoutingMx(domain).catch(() => null);
    if (mx === null) return { zone: zone.name, status: "unknown", detail: `${rule}; dns_lookup_failed` };
    return mx
      ? { zone: zone.name, status: "routed", detail: rule }
      : { zone: zone.name, status: "unrouted", detail: `${rule}; no_cloudflare_mx` };
  } catch (err) {
    // Cannot verify is not the same as broken; do not cry wolf.
    return { status: "unknown", detail: err instanceof CloudflareError ? err.message : "cloudflare_error" };
  }
}

api.get("/domains/:domain/mailboxes", async (c) => {
  const domain = normalizeDomain(c.req.param("domain"));
  if (!domain) return c.json({ error: "invalid_domain" }, 400);
  const origin = new URL(c.req.url).origin;
  return c.json({ domain, mailboxes: await mailboxStats(c.env, domain, origin) });
});

api.get("/mailboxes/:mailbox/latest", async (c) => {
  const mailbox = normalizeMailbox(c.req.param("mailbox"));
  if (!mailbox) return c.json({ error: "invalid_mailbox" }, 400);
  const [item] = await messagesByMailbox(c.env, mailbox, 1);
  return c.json({ mailbox, latest: item ? toLatest(item, mailbox) : null });
});

api.get("/usage", async (c) => c.json(await store.usageSnapshot(c.env, 30)));

/** Flat, paginated message feed across all domains. */
api.get("/messages", async (c) => {
  const domain = c.req.query("domain");
  const mailbox = c.req.query("mailbox");
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const size = Math.min(Math.max(Number(c.req.query("size")) || 25, 5), 100);

  let items: Awaited<ReturnType<typeof messagesByDomain>> = [];
  if (mailbox) {
    items = await messagesByMailbox(c.env, mailbox, 200);
  } else if (domain) {
    items = await messagesByDomain(c.env, domain, 500);
  } else {
    items = await recentMessages(c.env, 100);
  }

  items.sort((a, b) => String(b.received_at ?? "").localeCompare(String(a.received_at ?? "")));
  const total = items.length;
  const slice = items.slice((page - 1) * size, page * size);

  return c.json({
    total,
    page,
    size,
    pages: Math.max(Math.ceil(total / size), 1),
    messages: slice.map((m) => ({
      ...toLatest(m, m.recipient ?? ""),
      domain: m.domain ?? String(m.recipient ?? "").split("@")[1] ?? "",
    })),
  });
});

function addressError(
  c: { json: (body: { error: string }, status: 400 | 404 | 409 | 503) => Response },
  error: unknown,
): Response {
  if (error instanceof AddressModelError) return c.json({ error: error.code }, error.status);
  return c.json({ error: "address_operation_failed" }, 503);
}

api.get("/links", async (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({ links: await store.listLinks(c.env, origin) });
});

api.post("/links", async (c) => {
  const input = await body<{ mailbox: string; label: string; id: string }>(c);
  const mailbox = normalizeMailbox(input.mailbox);
  if (!mailbox) return c.json({ error: "invalid_mailbox" }, 400);
  const id = input.id && isValidLinkId(input.id) ? input.id : createLinkId();
  const record = { mailbox, label: String(input.label ?? "").trim() || undefined, createdAt: new Date().toISOString() };
  await store.putLink(c.env, id, record);
  return c.json(store.linkView(new URL(c.req.url).origin, id, record), 201);
});

api.delete("/links/:id", async (c) => {
  const id = c.req.param("id");
  if (!isValidLinkId(id)) return c.json({ error: "invalid_id" }, 400);
  await store.deleteLink(c.env, id);
  return c.json({ ok: true });
});

api.get("/mailboxes", async (c) => {
  const origin = new URL(c.req.url).origin;
  const records = await store.listPublicMailboxRecords(c.env);
  return c.json({
    mailboxes: records.map((rec) => ({
      ...rec,
      url: `${origin}/?mail=${encodeURIComponent(rec.mailbox)}`,
    })),
  });
});

api.post("/mailboxes", async (c) => {
  const input = await body<{ mailbox: string; mailboxes: unknown; label: string }>(c);
  const raw = splitMailboxes(input.mailboxes ?? input.mailbox);
  if (!raw.length) return c.json({ error: "invalid_mailbox" }, 400);
  const createdAt = new Date().toISOString();
  const label = String(input.label ?? "").trim() || undefined;
  const origin = new URL(c.req.url).origin;
  const created: unknown[] = [];
  const invalid: string[] = [];
  for (const item of raw) {
    const mailbox = normalizeMailbox(item);
    if (!mailbox) { invalid.push(item); continue; }
    await store.putMailbox(c.env, mailbox, { mailbox, label, createdAt });
    created.push({ mailbox, label, createdAt, url: `${origin}/?mail=${encodeURIComponent(mailbox)}` });
  }
  if (!created.length) return c.json({ error: "invalid_mailbox", invalid }, 400);
  return c.json({ created, invalid }, invalid.length ? 207 : 201);
});

api.delete("/mailboxes/:mailbox", async (c) => {
  const mailbox = normalizeMailbox(c.req.param("mailbox"));
  if (!mailbox) return c.json({ error: "invalid_mailbox" }, 400);
  await store.deleteMailbox(c.env, mailbox);
  return c.json({ ok: true, mailbox });
});
