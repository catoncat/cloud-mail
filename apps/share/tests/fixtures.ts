// Test-only bindings: real SQLite behind a D1-shaped facade, a fake intake behind
// the Service Binding, and an in-memory KV. Enough to run the share app end to end.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createTenant } from "../src/lib/tenants.ts";
import type { Env, IntakeMessage, Tenant } from "../src/lib/types.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

/** D1's prepare/bind/first/all/run over node:sqlite, with every migration applied. */
export function memoryD1(): Env["DB"] {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    bind: (...args: SQLInputValue[]) => statement(sql, args),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as Env["DB"];
}

export type Domain = { domain: string; enabled: boolean };

export const DOMAINS: Domain[] = [
  { domain: "a.example.com", enabled: true },
  { domain: "b.example.com", enabled: true },
  { domain: "off.example.com", enabled: false },
];

/** Bindings plus a way to make mail arrive. `intakeDown` makes every intake call fail. */
export function fakeEnv({ domains = DOMAINS, intakeDown = false }: { domains?: Domain[]; intakeDown?: boolean } = {}) {
  const mail = new Map<string, IntakeMessage[]>();
  const calls: string[] = [];
  const INTAKE = {
    async fetch(input: string) {
      const url = new URL(input);
      calls.push(`${url.pathname}${url.search}`);
      if (intakeDown) return new Response("boom", { status: 500 });
      if (url.pathname === "/admin/domains") {
        return Response.json({ ok: true, items: domains.map((d) => ({ domain: d.domain, enabled: d.enabled ? 1 : 0 })) });
      }
      if (url.pathname === "/admin/messages") {
        const items = [...(mail.get(url.searchParams.get("email") ?? "") ?? [])]
          .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))
          .slice(0, Number(url.searchParams.get("limit") ?? 1));
        return Response.json({ ok: true, items });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  };
  const kv = new Map<string, string>();
  const SHARE_LINKS = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => void kv.set(key, value),
    delete: async (key: string) => void kv.delete(key),
    list: async () => ({ keys: [], list_complete: true }),
  };
  const env = { INTAKE, SHARE_LINKS, DB: memoryD1(), OPERATOR_KEY: "op-key" } as unknown as Env;

  let seq = 0;
  /** Store a mail for `to`, received `offsetMs` from now (negative is in the past). */
  function deliver(to: string, fields: Partial<IntakeMessage> = {}, offsetMs = 0): IntakeMessage {
    seq += 1;
    const item: IntakeMessage = {
      id: `m${seq}`,
      recipient: to,
      sender: "no-reply@service.example",
      subject: `Message ${seq}`,
      received_at: new Date(Date.now() + offsetMs).toISOString(),
      text_body: `Body ${seq}`,
      ...fields,
    };
    mail.set(to, [...(mail.get(to) ?? []), item]);
    return item;
  }

  return { env, deliver, calls, kv };
}

/** A tenant row plus its token, the way the operator would issue one. */
export async function addTenant(env: Env, name: string, domains: string[] | null = null): Promise<{ tenant: Tenant; token: string }> {
  const created = await createTenant(env, name, domains);
  const row = await env.DB.prepare("SELECT id FROM tenants WHERE name = ?1").bind(name).first<{ id: string }>();
  return { tenant: { id: row!.id, name, domains }, token: created.token };
}
