import type { ClaimRecord, DomainMeta, DomainUsage, Env, LinkRecord, LinkView, ServiceUsage } from "./types";
import { normalizeDomain, normalizeMailbox, normalizePurpose } from "./validate";

const LINK = "link:";
const MAILBOX = "mailbox:";
const DOMAIN_META = "domainmeta:";
const CLAIM = "claim:";
const SERVICE_STAT = "svc:";

export async function getLink(env: Env, id: string): Promise<LinkRecord | null> {
  const raw = await env.SHARE_LINKS.get(LINK + id);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LinkRecord;
    const mailbox = normalizeMailbox(parsed.mailbox);
    return mailbox ? { ...parsed, mailbox } : null;
  } catch {
    return null;
  }
}

export async function putLink(env: Env, id: string, record: LinkRecord): Promise<void> {
  await env.SHARE_LINKS.put(LINK + id, JSON.stringify(record));
}

export async function deleteLink(env: Env, id: string): Promise<void> {
  await env.SHARE_LINKS.delete(LINK + id);
}

export function linkView(origin: string, id: string, record: LinkRecord): LinkView {
  return { ...record, id, url: `${origin}/s/${id}`, jsonUrl: `${origin}/s/${id}?format=json` };
}

export async function listLinks(env: Env, origin: string): Promise<LinkView[]> {
  const { keys } = await env.SHARE_LINKS.list({ prefix: LINK, limit: 1000 });
  const items = await Promise.all(
    keys.map(async (k) => {
      const id = k.name.slice(LINK.length);
      const rec = await getLink(env, id);
      return rec ? linkView(origin, id, rec) : null;
    }),
  );
  return items.filter((x): x is LinkView => x !== null).sort(byNewest);
}

export async function getMailbox(env: Env, mailbox: string): Promise<LinkRecord | null> {
  const raw = await env.SHARE_LINKS.get(MAILBOX + mailbox);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LinkRecord;
    return normalizeMailbox(parsed.mailbox) === mailbox ? { ...parsed, mailbox } : null;
  } catch {
    return null;
  }
}

export async function putMailbox(env: Env, mailbox: string, record: LinkRecord): Promise<void> {
  await env.SHARE_LINKS.put(MAILBOX + mailbox, JSON.stringify(record));
}

export async function deleteMailbox(env: Env, mailbox: string): Promise<void> {
  await env.SHARE_LINKS.delete(MAILBOX + mailbox);
}

export async function shareUrlByMailbox(env: Env, origin: string): Promise<Map<string, string>> {
  const { keys } = await env.SHARE_LINKS.list({ prefix: LINK, limit: 1000 });
  const map = new Map<string, string>();
  await Promise.all(
    keys.map(async (k) => {
      const id = k.name.slice(LINK.length);
      const rec = await getLink(env, id);
      if (rec) map.set(rec.mailbox, `${origin}/s/${id}`);
    }),
  );
  return map;
}

export async function getDomainMeta(env: Env, domain: string): Promise<DomainMeta | null> {
  const raw = await env.SHARE_LINKS.get(DOMAIN_META + domain);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DomainMeta;
    return { ...parsed, domain, purpose: normalizePurpose(parsed.purpose) };
  } catch {
    return null;
  }
}

export async function putDomainMeta(env: Env, meta: DomainMeta): Promise<void> {
  const domain = normalizeDomain(meta.domain);
  if (!domain) return;
  await env.SHARE_LINKS.put(DOMAIN_META + domain, JSON.stringify({ ...meta, domain }));
}

function byNewest(a: LinkRecord, b: LinkRecord): number {
  const ta = Date.parse(a.createdAt || "");
  const tb = Date.parse(b.createdAt || "");
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  return a.mailbox.localeCompare(b.mailbox);
}

/** Append-only claim log plus a per-service rollup for fast reads. */
export async function recordClaim(env: Env, service: string, domain: string): Promise<void> {
  const at = new Date().toISOString();
  // Reverse-timestamp key keeps KV list() newest-first without sorting.
  const seq = (9_999_999_999_999 - Date.now()).toString().padStart(13, "0");
  await env.SHARE_LINKS.put(
    `${CLAIM}${seq}:${crypto.randomUUID().slice(0, 8)}`,
    JSON.stringify({ service, domain, at } satisfies ClaimRecord),
    { expirationTtl: 60 * 60 * 24 * 90 },
  );

  const statKey = `${SERVICE_STAT}${service}:${domain}`;
  const prev = await env.SHARE_LINKS.get(statKey);
  const claims = prev ? (JSON.parse(prev) as { claims: number }).claims + 1 : 1;
  await env.SHARE_LINKS.put(statKey, JSON.stringify({ service, domain, claims, lastAt: at }));
}

export async function listClaims(env: Env, limit = 50): Promise<ClaimRecord[]> {
  const { keys } = await env.SHARE_LINKS.list({ prefix: CLAIM, limit });
  const items = await Promise.all(
    keys.map(async (k) => {
      const raw = await env.SHARE_LINKS.get(k.name);
      if (!raw) return null;
      try { return JSON.parse(raw) as ClaimRecord; } catch { return null; }
    }),
  );
  return items.filter((x): x is ClaimRecord => x !== null);
}

type StatRow = { service: string; domain: string; claims: number; lastAt: string };

async function allStats(env: Env): Promise<StatRow[]> {
  const { keys } = await env.SHARE_LINKS.list({ prefix: SERVICE_STAT, limit: 1000 });
  const rows = await Promise.all(
    keys.map(async (k) => {
      const raw = await env.SHARE_LINKS.get(k.name);
      if (!raw) return null;
      try { return JSON.parse(raw) as StatRow; } catch { return null; }
    }),
  );
  return rows.filter((x): x is StatRow => x !== null);
}

export async function serviceUsage(env: Env): Promise<ServiceUsage[]> {
  const grouped = new Map<string, ServiceUsage>();
  for (const r of await allStats(env)) {
    const cur = grouped.get(r.service) ?? { service: r.service, domains: [], claims: 0, lastAt: "" };
    if (!cur.domains.includes(r.domain)) cur.domains.push(r.domain);
    cur.claims += r.claims;
    if (r.lastAt > cur.lastAt) cur.lastAt = r.lastAt;
    grouped.set(r.service, cur);
  }
  return [...grouped.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export async function domainUsage(env: Env): Promise<DomainUsage[]> {
  const grouped = new Map<string, DomainUsage>();
  for (const r of await allStats(env)) {
    const cur = grouped.get(r.domain) ?? { domain: r.domain, services: [] };
    cur.services.push({ service: r.service, claims: r.claims, lastAt: r.lastAt });
    grouped.set(r.domain, cur);
  }
  for (const d of grouped.values()) d.services.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return [...grouped.values()];
}
