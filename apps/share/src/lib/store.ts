import type { AddressRecord, ClaimRecord, DomainMeta, DomainUsage, Env, LinkRecord, LinkView, ServiceUsage } from "./types";
import { normalizeDomain, normalizeMailbox, normalizePurpose } from "./validate";

const LINK = "link:";
const MAILBOX = "mailbox:";
const ADDRESS = "address:";
const DOMAIN_META = "domainmeta:";

/** Single-key indexes. Read paths must not list() the free-tier KV namespace. */
const IDX_LINKS = "idx:links";
const IDX_MAILBOXES = "idx:mailboxes";
const IDX_ADDRESSES = "idx:addresses";
const IDX_CLAIMS = "idx:claims";
const IDX_STATS = "idx:stats";

const CLAIMS_KEEP = 100;

type LinkIndex = Record<string, LinkRecord>;
type MailboxIndex = Record<string, LinkRecord>;
type AddressIndex = Record<string, AddressRecord>;
type StatsIndex = Record<string, StatRow>;

type StatRow = { service: string; domain: string; claims: number; lastAt: string };

function statKey(service: string, domain: string): string {
  return `${service}:${domain}`;
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.SHARE_LINKS.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.SHARE_LINKS.put(key, JSON.stringify(value));
}

/**
 * One-shot rebuild when an index is missing (legacy data written before indexes).
 * Uses list() only here — never on the hot path.
 */
async function rebuildFromPrefix<T>(
  env: Env,
  prefix: string,
  parse: (name: string, raw: string) => [string, T] | null,
): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  let cursor: string | undefined;
  do {
    const page = await env.SHARE_LINKS.list({ prefix, limit: 1000, cursor });
    for (const key of page.keys) {
      const raw = await env.SHARE_LINKS.get(key.name);
      if (!raw) continue;
      const parsed = parse(key.name, raw);
      if (parsed) out[parsed[0]] = parsed[1];
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function loadLinkIndex(env: Env): Promise<LinkIndex> {
  const cached = await readJson<LinkIndex>(env, IDX_LINKS);
  if (cached) return cached;
  const rebuilt = await rebuildFromPrefix<LinkRecord>(env, LINK, (name, raw) => {
    const id = name.slice(LINK.length);
    try {
      const parsed = JSON.parse(raw) as LinkRecord;
      const mailbox = normalizeMailbox(parsed.mailbox);
      return mailbox ? [id, { ...parsed, mailbox }] : null;
    } catch {
      return null;
    }
  });
  await writeJson(env, IDX_LINKS, rebuilt);
  return rebuilt;
}

async function loadMailboxIndex(env: Env): Promise<MailboxIndex> {
  const cached = await readJson<MailboxIndex>(env, IDX_MAILBOXES);
  if (cached) return cached;
  const rebuilt = await rebuildFromPrefix<LinkRecord>(env, MAILBOX, (name, raw) => {
    const mailbox = normalizeMailbox(name.slice(MAILBOX.length));
    if (!mailbox) return null;
    try {
      const parsed = JSON.parse(raw) as LinkRecord;
      return normalizeMailbox(parsed.mailbox) === mailbox ? [mailbox, { ...parsed, mailbox }] : null;
    } catch {
      return null;
    }
  });
  await writeJson(env, IDX_MAILBOXES, rebuilt);
  return rebuilt;
}

async function loadAddressIndex(env: Env): Promise<AddressIndex> {
  const cached = await readJson<AddressIndex>(env, IDX_ADDRESSES);
  if (cached) return cached;
  const rebuilt = await rebuildFromPrefix<AddressRecord>(env, ADDRESS, (name, raw) => {
    const mailbox = normalizeMailbox(name.slice(ADDRESS.length));
    if (!mailbox) return null;
    try {
      const parsed = JSON.parse(raw) as AddressRecord;
      return normalizeMailbox(parsed.mailbox) === mailbox ? [mailbox, { ...parsed, mailbox }] : null;
    } catch {
      return null;
    }
  });
  await writeJson(env, IDX_ADDRESSES, rebuilt);
  return rebuilt;
}

async function loadClaimsIndex(env: Env): Promise<ClaimRecord[]> {
  const cached = await readJson<ClaimRecord[]>(env, IDX_CLAIMS);
  if (cached) return cached;

  // Legacy: claim: keys were append-only with reverse-timestamp names.
  const rows: ClaimRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.SHARE_LINKS.list({ prefix: "claim:", limit: 1000, cursor });
    for (const key of page.keys) {
      const raw = await env.SHARE_LINKS.get(key.name);
      if (!raw) continue;
      try {
        rows.push(JSON.parse(raw) as ClaimRecord);
      } catch {
        /* skip */
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  rows.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  const kept = rows.slice(0, CLAIMS_KEEP);
  await writeJson(env, IDX_CLAIMS, kept);
  return kept;
}

async function loadStatsIndex(env: Env): Promise<StatsIndex> {
  const cached = await readJson<StatsIndex>(env, IDX_STATS);
  if (cached) return cached;

  const rebuilt = await rebuildFromPrefix<StatRow>(env, "svc:", (_name, raw) => {
    try {
      const row = JSON.parse(raw) as StatRow;
      if (!row.service || !row.domain) return null;
      return [statKey(row.service, row.domain), row];
    } catch {
      return null;
    }
  });
  await writeJson(env, IDX_STATS, rebuilt);
  return rebuilt;
}

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
  const index = await loadLinkIndex(env);
  index[id] = record;
  await Promise.all([
    env.SHARE_LINKS.put(LINK + id, JSON.stringify(record)),
    writeJson(env, IDX_LINKS, index),
  ]);
}

export async function deleteLink(env: Env, id: string): Promise<void> {
  const index = await loadLinkIndex(env);
  delete index[id];
  await Promise.all([
    env.SHARE_LINKS.delete(LINK + id),
    writeJson(env, IDX_LINKS, index),
  ]);
}

export function linkView(origin: string, id: string, record: LinkRecord): LinkView {
  return { ...record, id, url: `${origin}/s/${id}`, jsonUrl: `${origin}/s/${id}?format=json` };
}

export async function listLinks(env: Env, origin: string): Promise<LinkView[]> {
  const index = await loadLinkIndex(env);
  return Object.entries(index)
    .map(([id, record]) => linkView(origin, id, record))
    .sort(byNewest);
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
  const index = await loadMailboxIndex(env);
  index[mailbox] = record;
  await Promise.all([
    env.SHARE_LINKS.put(MAILBOX + mailbox, JSON.stringify(record)),
    writeJson(env, IDX_MAILBOXES, index),
  ]);
}

export async function deleteMailbox(env: Env, mailbox: string): Promise<void> {
  const index = await loadMailboxIndex(env);
  delete index[mailbox];
  await Promise.all([
    env.SHARE_LINKS.delete(MAILBOX + mailbox),
    writeJson(env, IDX_MAILBOXES, index),
  ]);
}

export async function listPublicMailboxes(env: Env): Promise<Set<string>> {
  const index = await loadMailboxIndex(env);
  return new Set(Object.keys(index));
}

export async function listPublicMailboxRecords(env: Env): Promise<LinkRecord[]> {
  const index = await loadMailboxIndex(env);
  return Object.values(index).sort(byNewest);
}

export async function getAddress(env: Env, mailbox: string): Promise<AddressRecord | null> {
  const raw = await env.SHARE_LINKS.get(ADDRESS + mailbox);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AddressRecord;
    return normalizeMailbox(parsed.mailbox) === mailbox ? { ...parsed, mailbox } : null;
  } catch {
    return null;
  }
}

export async function putAddress(env: Env, record: AddressRecord): Promise<void> {
  const mailbox = normalizeMailbox(record.mailbox);
  if (!mailbox) throw new Error("invalid_mailbox");
  const normalized = { ...record, mailbox };
  const index = await loadAddressIndex(env);
  index[mailbox] = normalized;
  await Promise.all([
    env.SHARE_LINKS.put(ADDRESS + mailbox, JSON.stringify(normalized)),
    writeJson(env, IDX_ADDRESSES, index),
  ]);
}

export async function listAddresses(env: Env): Promise<AddressRecord[]> {
  const index = await loadAddressIndex(env);
  return Object.values(index).sort(byNewest);
}

export async function shareUrlByMailbox(env: Env, origin: string): Promise<Map<string, string>> {
  const index = await loadLinkIndex(env);
  const map = new Map<string, string>();
  for (const [id, rec] of Object.entries(index)) {
    if (!map.has(rec.mailbox)) map.set(rec.mailbox, `${origin}/s/${id}`);
  }
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

function byNewest(a: { createdAt?: string; mailbox: string }, b: { createdAt?: string; mailbox: string }): number {
  const ta = Date.parse(a.createdAt || "");
  const tb = Date.parse(b.createdAt || "");
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
  return a.mailbox.localeCompare(b.mailbox);
}

/** Append to a bounded claim log and bump the per-service rollup — no list(). */
export async function recordClaim(env: Env, service: string, domain: string): Promise<void> {
  const at = new Date().toISOString();
  const [claims, stats] = await Promise.all([loadClaimsIndex(env), loadStatsIndex(env)]);

  claims.unshift({ service, domain, at });
  const kept = claims.slice(0, CLAIMS_KEEP);

  const key = statKey(service, domain);
  const prev = stats[key];
  stats[key] = {
    service,
    domain,
    claims: (prev?.claims ?? 0) + 1,
    lastAt: at,
  };

  await Promise.all([
    writeJson(env, IDX_CLAIMS, kept),
    writeJson(env, IDX_STATS, stats),
  ]);
}

export async function listClaims(env: Env, limit = 50): Promise<ClaimRecord[]> {
  const claims = await loadClaimsIndex(env);
  return claims.slice(0, limit);
}

async function allStats(env: Env): Promise<StatRow[]> {
  return Object.values(await loadStatsIndex(env));
}

export async function serviceUsage(env: Env): Promise<ServiceUsage[]> {
  return serviceUsageFrom(await allStats(env));
}

export async function domainUsage(env: Env): Promise<DomainUsage[]> {
  return domainUsageFrom(await allStats(env));
}

/** One index read, three derived views — for admin /usage. */
export async function usageSnapshot(
  env: Env,
  recentLimit = 30,
): Promise<{ services: ServiceUsage[]; domains: DomainUsage[]; recent: ClaimRecord[] }> {
  const [stats, recent] = await Promise.all([allStats(env), listClaims(env, recentLimit)]);
  return {
    services: serviceUsageFrom(stats),
    domains: domainUsageFrom(stats),
    recent,
  };
}

function serviceUsageFrom(rows: StatRow[]): ServiceUsage[] {
  const grouped = new Map<string, ServiceUsage>();
  for (const r of rows) {
    const cur = grouped.get(r.service) ?? { service: r.service, domains: [], claims: 0, lastAt: "" };
    if (!cur.domains.includes(r.domain)) cur.domains.push(r.domain);
    cur.claims += r.claims;
    if (r.lastAt > cur.lastAt) cur.lastAt = r.lastAt;
    grouped.set(r.service, cur);
  }
  return [...grouped.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

function domainUsageFrom(rows: StatRow[]): DomainUsage[] {
  const grouped = new Map<string, DomainUsage>();
  for (const r of rows) {
    const cur = grouped.get(r.domain) ?? { domain: r.domain, services: [] };
    cur.services.push({ service: r.service, claims: r.claims, lastAt: r.lastAt });
    grouped.set(r.domain, cur);
  }
  for (const d of grouped.values()) d.services.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return [...grouped.values()];
}
