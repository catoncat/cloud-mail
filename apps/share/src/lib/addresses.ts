import { guessService, listDomains, mailboxSummaries } from "./intake";
import * as store from "./store";
import type { AddressRecord, AddressView, Env, LinkView, MailboxSummary } from "./types";
import { normalizeDomain, normalizeLocalPart, normalizeMailbox } from "./validate";

const ADJECTIVES = ["bright", "calm", "clear", "fresh", "kind", "lucky", "swift", "tidy"];
const NOUNS = ["birch", "comet", "field", "harbor", "maple", "orbit", "pixel", "river"];
const SAFE_CHARS = "23456789abcdefghjkmnpqrstuvwxyz";

export class AddressModelError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 503 = 400) {
    super(code);
  }
}

export type CreateAddressInput = {
  domain?: unknown;
  localPart?: unknown;
  label?: unknown;
  service?: unknown;
  note?: unknown;
};

export type UpdateAddressInput = {
  label?: unknown;
  service?: unknown;
  note?: unknown;
};

function groupLinks(links: LinkView[]): Map<string, LinkView[]> {
  const grouped = new Map<string, LinkView[]>();
  for (const link of links) grouped.set(link.mailbox, [...(grouped.get(link.mailbox) ?? []), link]);
  return grouped;
}

function viewFor(
  mailbox: string,
  record: AddressRecord | undefined,
  summary: MailboxSummary | undefined,
  shares: LinkView[],
  publicMailboxes: Set<string>,
): AddressView {
  const at = mailbox.lastIndexOf("@");
  const latestSender = summary?.latestSender ?? "";
  const latestSubject = summary?.latestSubject ?? "";
  return {
    mailbox,
    localPart: summary?.localPart ?? mailbox.slice(0, at),
    domain: summary?.domain ?? mailbox.slice(at + 1),
    label: record?.label,
    service: cleanField(record?.service, 48) ?? guessService(latestSender, latestSubject),
    note: record?.note,
    createdAt: record?.createdAt ?? shares.at(-1)?.createdAt ?? null,
    updatedAt: record?.updatedAt ?? null,
    registered: Boolean(record),
    publicAccess: publicMailboxes.has(mailbox),
    messages: summary?.messages ?? 0,
    codes: summary?.codes ?? 0,
    lastActivity: summary?.lastActivity ?? null,
    lastCode: summary?.lastCode ?? null,
    lastCodeAt: summary?.lastCodeAt ?? null,
    latestSender,
    latestSubject,
    shares,
  };
}

export async function listAddressViews(env: Env, origin: string): Promise<AddressView[]> {
  const [records, summaries, links, publicMailboxes] = await Promise.all([
    store.listAddresses(env),
    mailboxSummaries(env),
    store.listLinks(env, origin),
    store.listPublicMailboxes(env),
  ]);

  const recordByMailbox = new Map(records.map((record) => [record.mailbox, record]));
  const summaryByMailbox = new Map(summaries.map((summary) => [summary.mailbox, summary]));
  const linksByMailbox = groupLinks(links);
  const mailboxes = new Set([
    ...recordByMailbox.keys(),
    ...summaryByMailbox.keys(),
    ...linksByMailbox.keys(),
    ...publicMailboxes,
  ]);

  return [...mailboxes]
    .map((mailbox) => viewFor(
      mailbox,
      recordByMailbox.get(mailbox),
      summaryByMailbox.get(mailbox),
      linksByMailbox.get(mailbox) ?? [],
      publicMailboxes,
    ))
    .sort((a, b) => {
      const aTime = a.lastActivity && a.createdAt ? (a.lastActivity > a.createdAt ? a.lastActivity : a.createdAt) : a.lastActivity ?? a.createdAt ?? "";
      const bTime = b.lastActivity && b.createdAt ? (b.lastActivity > b.createdAt ? b.lastActivity : b.createdAt) : b.lastActivity ?? b.createdAt ?? "";
      return bTime.localeCompare(aTime) || a.mailbox.localeCompare(b.mailbox);
    });
}

export async function createAddress(env: Env, origin: string, input: CreateAddressInput): Promise<AddressView> {
  const [domains, addresses, links, publicMailboxes] = await Promise.all([
    listDomains(env),
    store.listAddresses(env),
    store.listLinks(env, origin),
    store.listPublicMailboxes(env),
  ]);
  const enabledDomains = domains.filter((item) => item.enabled).map((item) => item.domain);
  if (enabledDomains.length === 0) throw new AddressModelError("no_domains_available", 503);

  const requestedDomainText = String(input.domain ?? "").trim();
  const requestedDomain = normalizeDomain(requestedDomainText);
  if (requestedDomainText && !requestedDomain) throw new AddressModelError("invalid_domain");
  if (requestedDomain && !enabledDomains.includes(requestedDomain)) {
    throw new AddressModelError("domain_not_available");
  }

  const counts = new Map<string, number>();
  for (const address of addresses) {
    const at = address.mailbox.lastIndexOf("@");
    const domainName = at >= 0 ? address.mailbox.slice(at + 1) : "";
    if (domainName) counts.set(domainName, (counts.get(domainName) ?? 0) + 1);
  }
  for (const link of links) {
    const at = link.mailbox.lastIndexOf("@");
    const domainName = at >= 0 ? link.mailbox.slice(at + 1) : "";
    if (domainName) counts.set(domainName, (counts.get(domainName) ?? 0) + 1);
  }
  const domain = requestedDomain || [...enabledDomains].sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || a.localeCompare(b))[0];

  const rawLocalPart = String(input.localPart ?? "").trim();
  const requestedLocalPart = rawLocalPart ? normalizeLocalPart(rawLocalPart) : "";
  if (rawLocalPart && !requestedLocalPart) throw new AddressModelError("invalid_local_part");

  const registered = new Set(addresses.map((item) => item.mailbox));
  const used = new Set([
    ...registered,
    ...links.map((item) => item.mailbox),
    ...publicMailboxes,
  ]);
  let localPart = requestedLocalPart;
  if (localPart && registered.has(`${localPart}@${domain}`)) throw new AddressModelError("address_exists", 409);

  if (!localPart) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = suggestedLocalPart(input.service);
      if (!used.has(`${candidate}@${domain}`)) {
        localPart = candidate;
        break;
      }
    }
  }
  if (!localPart) throw new AddressModelError("address_generation_failed", 503);

  const now = new Date().toISOString();
  const record: AddressRecord = {
    mailbox: `${localPart}@${domain}`,
    label: cleanField(input.label, 80),
    service: cleanField(input.service, 48),
    note: cleanField(input.note, 240),
    createdAt: now,
    updatedAt: now,
  };
  await store.putAddress(env, record);

  // Fresh create: no mail yet, no share links — skip a full listAddressViews rescan.
  return viewFor(record.mailbox, record, undefined, [], publicMailboxes);
}

/** Single mailbox view without scanning every address. */
export async function getAddressView(env: Env, origin: string, mailboxInput: unknown): Promise<AddressView | null> {
  const mailbox = normalizeMailbox(mailboxInput);
  if (!mailbox) return null;

  const [record, links, publicMailboxes, summaries] = await Promise.all([
    store.getAddress(env, mailbox),
    store.listLinks(env, origin),
    store.listPublicMailboxes(env),
    mailboxSummaries(env).catch(() => [] as MailboxSummary[]),
  ]);
  const summary = summaries.find((item) => item.mailbox === mailbox);
  const shares = links.filter((link) => link.mailbox === mailbox);
  if (!record && !summary && shares.length === 0 && !publicMailboxes.has(mailbox)) return null;
  return viewFor(mailbox, record ?? undefined, summary, shares, publicMailboxes);
}

export async function updateAddress(
  env: Env,
  mailboxInput: unknown,
  input: UpdateAddressInput,
): Promise<AddressRecord> {
  const mailbox = normalizeMailbox(mailboxInput);
  if (!mailbox) throw new AddressModelError("invalid_mailbox");

  const now = new Date().toISOString();
  const existing = await store.getAddress(env, mailbox);
  const record: AddressRecord = {
    mailbox,
    label: input.label === undefined ? existing?.label : cleanField(input.label, 80),
    service: input.service === undefined ? existing?.service : cleanField(input.service, 48),
    note: input.note === undefined ? existing?.note : cleanField(input.note, 240),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await store.putAddress(env, record);
  return record;
}

function cleanField(value: unknown, max: number): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : undefined;
}

function suggestedLocalPart(serviceInput: unknown): string {
  const service = String(serviceInput ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 22);
  if (service) return `${service}-${randomToken(4)}`;
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomToken(2)}`;
}

function pick<T>(items: T[]): T {
  return items[randomNumber(items.length)];
}

function randomToken(length: number): string {
  return Array.from({ length }, () => SAFE_CHARS[randomNumber(SAFE_CHARS.length)]).join("");
}

function randomNumber(max: number): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % max;
}
