// Links, public mailboxes and address notes. D1 rows, not KV index blobs: a KV
// upsert of a whole index cost two writes against a 1,000-a-day allowance and CPU
// proportional to the number of records already stored.
//
// KV is still read once per deployment to import records written before migration
// 0002. After that it can be removed from the bindings.
import type { AddressRecord, Env, LinkRecord, LinkView } from "./types";
import { normalizeMailbox } from "./validate";

type LinkRow = { id: string; mailbox: string; label: string | null; created_at: string };
type MailboxRow = { mailbox: string; label: string | null; created_at: string };
type AddressRow = {
  mailbox: string;
  label: string | null;
  service: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

const IMPORT_MARKER = "kv_imported";

/** One import attempt per deployment; a failed attempt is retried by the next request. */
const importedByEnv = new WeakMap<Env, Promise<void>>();

async function importLegacy(env: Env): Promise<void> {
  const kv = env.SHARE_LINKS;
  if (!kv) return;
  const done = await env.DB.prepare("SELECT value FROM share_meta WHERE key = ?1")
    .bind(IMPORT_MARKER)
    .first<{ value: string }>();
  if (done) return;

  const [links, mailboxes, addresses] = await Promise.all([
    dump<[string, LinkRecord]>(kv, "link:", (name, raw) => {
      const id = name.slice("link:".length);
      const record = parse<LinkRecord>(raw);
      const mailbox = normalizeMailbox(record?.mailbox);
      return record && mailbox ? [id, { ...record, mailbox }] : null;
    }),
    dump<[string, LinkRecord]>(kv, "mailbox:", (name, raw) => {
      const mailbox = normalizeMailbox(name.slice("mailbox:".length));
      const record = parse<LinkRecord>(raw);
      return record && mailbox && normalizeMailbox(record.mailbox) === mailbox
        ? [mailbox, { ...record, mailbox }]
        : null;
    }),
    dump<[string, AddressRecord]>(kv, "address:", (name, raw) => {
      const mailbox = normalizeMailbox(name.slice("address:".length));
      const record = parse<AddressRecord>(raw);
      if (!record || !mailbox || normalizeMailbox(record.mailbox) !== mailbox) return null;
      return [mailbox, { ...record, mailbox }];
    }),
  ]);

  const statements = [
    ...links.map(([id, record]) =>
      env.DB.prepare(
        "INSERT INTO share_links (id, mailbox, label, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO NOTHING",
      ).bind(id, record.mailbox, record.label ?? null, record.createdAt),
    ),
    ...mailboxes.map(([mailbox, record]) =>
      env.DB.prepare(
        "INSERT INTO share_mailboxes (mailbox, label, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(mailbox) DO NOTHING",
      ).bind(mailbox, record.label ?? null, record.createdAt),
    ),
    ...addresses.map(([mailbox, record]) =>
      env.DB.prepare(
        "INSERT INTO share_addresses (mailbox, label, service, note, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(mailbox) DO NOTHING",
      ).bind(
        mailbox,
        record.label ?? null,
        record.service ?? null,
        record.note ?? null,
        record.createdAt,
        record.updatedAt ?? record.createdAt,
      ),
    ),
  ];
  // D1 takes a batch atomically; chunk it so a large old index stays inside the
  // per-statement limits.
  for (let at = 0; at < statements.length; at += 50) {
    await env.DB.batch(statements.slice(at, at + 50));
  }
  await env.DB.prepare(
    "INSERT INTO share_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(IMPORT_MARKER, new Date().toISOString())
    .run();
  console.log("store", { imported: { links: links.length, mailboxes: mailboxes.length, addresses: addresses.length } });
}

/** Import the pre-D1 records once, before this deployment answers anything from D1. */
function ready(env: Env): Promise<void> {
  const pending = importedByEnv.get(env);
  if (pending) return pending;
  const attempt = importLegacy(env).catch((error: unknown) => {
    console.error("store: legacy KV import failed", error);
    // A later request may get further; nothing here is destructive.
    importedByEnv.delete(env);
    throw error;
  });
  importedByEnv.set(env, attempt);
  return attempt;
}

function parse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Every KV record under a prefix, parsed. Only ever called by the one-off import. */
async function dump<T>(kv: KVNamespace, prefix: string, read: (name: string, raw: string) => T | null): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, limit: 1000, cursor });
    const values = await Promise.all(page.keys.map((key) => kv.get(key.name)));
    page.keys.forEach((key, index) => {
      const raw = values[index];
      if (!raw) return;
      const parsed = read(key.name, raw);
      if (parsed) out.push(parsed);
    });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

function toLink(row: LinkRow): LinkRecord | null {
  const mailbox = normalizeMailbox(row.mailbox);
  if (!mailbox) return null;
  return { mailbox, label: row.label ?? undefined, createdAt: row.created_at };
}

function toMailbox(row: MailboxRow): LinkRecord | null {
  const mailbox = normalizeMailbox(row.mailbox);
  if (!mailbox) return null;
  return { mailbox, label: row.label ?? undefined, createdAt: row.created_at };
}

function toAddress(row: AddressRow): AddressRecord | null {
  const mailbox = normalizeMailbox(row.mailbox);
  if (!mailbox) return null;
  return {
    mailbox,
    label: row.label ?? undefined,
    service: row.service ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getLink(env: Env, id: string): Promise<LinkRecord | null> {
  await ready(env);
  const row = await env.DB.prepare("SELECT id, mailbox, label, created_at FROM share_links WHERE id = ?1")
    .bind(id)
    .first<LinkRow>();
  return row ? toLink(row) : null;
}

export async function putLink(env: Env, id: string, record: LinkRecord): Promise<void> {
  await ready(env);
  await env.DB.prepare(
    `INSERT INTO share_links (id, mailbox, label, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET mailbox = excluded.mailbox, label = excluded.label, created_at = excluded.created_at`,
  )
    .bind(id, record.mailbox, record.label ?? null, record.createdAt)
    .run();
}

export async function deleteLink(env: Env, id: string): Promise<void> {
  await ready(env);
  await env.DB.prepare("DELETE FROM share_links WHERE id = ?1").bind(id).run();
}

export function linkView(origin: string, id: string, record: LinkRecord): LinkView {
  return { ...record, id, url: `${origin}/s/${id}`, jsonUrl: `${origin}/s/${id}?format=json` };
}

export async function listLinks(env: Env, origin: string): Promise<LinkView[]> {
  await ready(env);
  const { results } = await env.DB.prepare(
    "SELECT id, mailbox, label, created_at FROM share_links ORDER BY created_at DESC, mailbox ASC",
  ).all<LinkRow>();
  return results.flatMap((row) => {
    const record = toLink(row);
    return record ? [linkView(origin, row.id, record)] : [];
  });
}

/** Sharing links for one address, without reading anybody else's. */
export async function listLinksForMailbox(env: Env, origin: string, mailbox: string): Promise<LinkView[]> {
  await ready(env);
  const { results } = await env.DB.prepare(
    "SELECT id, mailbox, label, created_at FROM share_links WHERE mailbox = ?1 ORDER BY created_at DESC",
  )
    .bind(mailbox)
    .all<LinkRow>();
  return results.flatMap((row) => {
    const record = toLink(row);
    return record ? [linkView(origin, row.id, record)] : [];
  });
}

export async function getMailbox(env: Env, mailbox: string): Promise<LinkRecord | null> {
  await ready(env);
  const row = await env.DB.prepare("SELECT mailbox, label, created_at FROM share_mailboxes WHERE mailbox = ?1")
    .bind(mailbox)
    .first<MailboxRow>();
  return row ? toMailbox(row) : null;
}

export async function putMailbox(env: Env, mailbox: string, record: LinkRecord): Promise<void> {
  await ready(env);
  await env.DB.prepare(
    `INSERT INTO share_mailboxes (mailbox, label, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(mailbox) DO UPDATE SET label = excluded.label, created_at = excluded.created_at`,
  )
    .bind(mailbox, record.label ?? null, record.createdAt)
    .run();
}

export async function deleteMailbox(env: Env, mailbox: string): Promise<void> {
  await ready(env);
  await env.DB.prepare("DELETE FROM share_mailboxes WHERE mailbox = ?1").bind(mailbox).run();
}

export async function listPublicMailboxes(env: Env): Promise<Set<string>> {
  await ready(env);
  const { results } = await env.DB.prepare("SELECT mailbox FROM share_mailboxes").all<{ mailbox: string }>();
  return new Set(results.map((row) => row.mailbox));
}

export async function listPublicMailboxRecords(env: Env): Promise<LinkRecord[]> {
  await ready(env);
  const { results } = await env.DB.prepare(
    "SELECT mailbox, label, created_at FROM share_mailboxes ORDER BY created_at DESC, mailbox ASC",
  ).all<MailboxRow>();
  return results.flatMap((row) => {
    const record = toMailbox(row);
    return record ? [record] : [];
  });
}

export async function getAddress(env: Env, mailbox: string): Promise<AddressRecord | null> {
  await ready(env);
  const row = await env.DB.prepare(
    "SELECT mailbox, label, service, note, created_at, updated_at FROM share_addresses WHERE mailbox = ?1",
  )
    .bind(mailbox)
    .first<AddressRow>();
  return row ? toAddress(row) : null;
}

export async function putAddress(env: Env, record: AddressRecord): Promise<void> {
  const mailbox = normalizeMailbox(record.mailbox);
  if (!mailbox) throw new Error("invalid_mailbox");
  await ready(env);
  await env.DB.prepare(
    `INSERT INTO share_addresses (mailbox, label, service, note, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(mailbox) DO UPDATE SET label = excluded.label, service = excluded.service, note = excluded.note,
       created_at = excluded.created_at, updated_at = excluded.updated_at`,
  )
    .bind(
      mailbox,
      record.label ?? null,
      record.service ?? null,
      record.note ?? null,
      record.createdAt,
      record.updatedAt ?? record.createdAt,
    )
    .run();
}

export async function listAddresses(env: Env): Promise<AddressRecord[]> {
  await ready(env);
  const { results } = await env.DB.prepare(
    "SELECT mailbox, label, service, note, created_at, updated_at FROM share_addresses ORDER BY created_at DESC, mailbox ASC",
  ).all<AddressRow>();
  return results.flatMap((row) => {
    const record = toAddress(row);
    return record ? [record] : [];
  });
}

/** One share URL per address: the newest one it has. */
export async function shareUrlByMailbox(env: Env, origin: string): Promise<Map<string, string>> {
  await ready(env);
  const { results } = await env.DB.prepare(
    "SELECT id, mailbox, label, created_at FROM share_links ORDER BY created_at DESC, mailbox ASC",
  ).all<LinkRow>();
  const map = new Map<string, string>();
  for (const row of results) {
    const record = toLink(row);
    if (record && !map.has(record.mailbox)) map.set(record.mailbox, `${origin}/s/${row.id}`);
  }
  return map;
}

/**
 * Addresses the operator manages in the console: saved, opened publicly, or shared by link.
 * A tenant may never claim one, or it would receive the operator's mail.
 */
export async function isOperatorMailbox(env: Env, mailbox: string): Promise<boolean> {
  await ready(env);
  const row = await env.DB.prepare(
    `SELECT
       (SELECT 1 FROM share_addresses WHERE mailbox = ?1) AS saved,
       (SELECT 1 FROM share_mailboxes WHERE mailbox = ?1) AS open,
       (SELECT 1 FROM share_links WHERE mailbox = ?1 LIMIT 1) AS shared`,
  )
    .bind(mailbox)
    .first<{ saved: number | null; open: number | null; shared: number | null }>();
  return Boolean(row && (row.saved || row.open || row.shared));
}
