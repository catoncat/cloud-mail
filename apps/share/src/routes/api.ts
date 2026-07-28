import { Hono } from "hono";
import { createAddress, AddressModelError, getAddressView, listAddressViews, updateAddress } from "../lib/addresses";
import { domainStats, mailboxStats, overview } from "../lib/aggregate";
import {
  deleteMailboxMessages,
  listDomains,
  messagesByDomain,
  messagesByMailbox,
  recentMessages,
  toLatest,
  upsertIntakeDomain,
} from "../lib/intake";
import { CloudflareError, findZone, getCatchAll, listZones } from "../lib/cloudflare";
import * as store from "../lib/store";
import type { Env } from "../lib/types";
import { createLinkId, isValidLinkId, normalizeDomain, normalizeMailbox, splitMailboxes } from "../lib/validate";

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = [enc.encode(a), enc.encode(b)];
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Body parsing must never throw; missing fields are validated downstream. */
async function body<T extends object>(c: { req: { json: <U>() => Promise<U> } }): Promise<Partial<T>> {
  try {
    return await c.req.json<Partial<T>>();
  } catch {
    return {};
  }
}

export const api = new Hono<{ Bindings: Env }>();

api.use("*", async (c, next) => {
  const expected = c.env.ADMIN_KEY ?? "";
  const header = c.req.header("authorization") ?? "";
  const provided = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? c.req.header("x-admin-key") ?? "";
  if (!expected || !(await timingSafeEqual(expected, provided))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

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
 * Register a mail domain in the intake allowlist.
 *
 * DNS + catch-all still require the account-owner credential, which is
 * intentionally not stored in this Worker. We verify current state and tell
 * the operator exactly what is missing.
 */
api.post("/domains", async (c) => {
  const input = await body<{ domain: string }>(c);
  const domain = normalizeDomain(input.domain);
  if (!domain) return c.json({ error: "invalid_domain" }, 400);

  const checks: Array<{ step: string; ok: boolean; detail?: string }> = [];
  let zoneName = domain;
  let dnsReady = false;

  try {
    const zone = await findZone(c.env, domain);
    if (!zone) {
      return c.json({ error: "zone_not_found", hint: "该域名不在此 Cloudflare 账号下" }, 400);
    }
    zoneName = zone.name;
    checks.push({ step: "zone", ok: true, detail: zone.name });

    const catchAll = await getCatchAll(c.env, zone.id);
    dnsReady = catchAll?.enabled === true && catchAll.target === "cloud-mail-intake";
    checks.push({
      step: "catch_all",
      ok: dnsReady,
      detail: catchAll ? `${catchAll.enabled ? "enabled" : "disabled"} -> ${catchAll.target || "none"}` : "not_configured",
    });
  } catch (err) {
    checks.push({ step: "zone", ok: false, detail: err instanceof Error ? err.message : "cloudflare_error" });
  }

  try {
    await upsertIntakeDomain(c.env, domain, zoneName);
    checks.push({ step: "allowlist", ok: true });
  } catch (err) {
    checks.push({ step: "allowlist", ok: false, detail: err instanceof Error ? err.message : "unknown" });
    return c.json({ error: "allowlist_failed", checks }, 502);
  }

  return c.json(
    {
      ok: true,
      domain,
      zone: zoneName,
      dnsReady,
      checks,
      followUp: dnsReady
        ? null
        : {
            reason: "Email Routing DNS 需要账号级凭据，Worker 不持有",
            command: "cd apps/intake && cloud-mail setup",
          },
    },
    201,
  );
});

/**
 * Live routing health for one domain.
 *
 * "No mail yet" and "mail cannot arrive" look identical in the message counts,
 * so read Email Routing directly. Without this a misrouted domain silently looks
 * like an idle one.
 */
api.get("/domains/:domain/health", async (c) => {
  const domain = normalizeDomain(c.req.param("domain"));
  if (!domain) return c.json({ error: "invalid_domain" }, 400);

  try {
    const zone = await findZone(c.env, domain);
    if (!zone) return c.json({ domain, status: "unknown", detail: "zone_not_found" });

    const catchAll = await getCatchAll(c.env, zone.id);
    if (!catchAll) return c.json({ domain, status: "unrouted", zone: zone.name, detail: "not_configured" });

    const routed = catchAll.enabled && catchAll.target === "cloud-mail-intake";
    return c.json({
      domain,
      zone: zone.name,
      status: routed ? "routed" : "unrouted",
      detail: `${catchAll.enabled ? "enabled" : "disabled"} -> ${catchAll.target || "none"}`,
    });
  } catch (err) {
    const message = err instanceof CloudflareError ? err.message : "cloudflare_error";
    // Cannot verify is not the same as broken; do not cry wolf.
    return c.json({ domain, status: "unknown", detail: message });
  }
});

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
