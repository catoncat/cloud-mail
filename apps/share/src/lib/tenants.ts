import type { Env, Tenant } from "./types";
import { normalizeDomain } from "./validate";

/** Tenant names: 3-40 chars of letters, digits and ._-, alphanumeric at both ends. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/;
const TOKEN_PREFIX = "cm_";

/** A rejected tenant operation: a stable code, an HTTP status, and the literal fix. */
export class TenantError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409;
  readonly hint: string;

  constructor(code: string, status: 400 | 404 | 409, hint: string) {
    super(code);
    this.name = "TenantError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export type TenantSummary = {
  name: string;
  domains: string[] | null;
  created_at: string;
  disabled_at: string | null;
  inboxes: number;
  last_inbox_at: string | null;
};

export function normalizeTenantName(value: unknown): string {
  const v = String(value ?? "").trim().toLowerCase();
  return NAME_RE.test(v) ? v : "";
}

/**
 * A domain scope as the operator writes it: a list or a comma/space separated string.
 *
 * Absent, empty or "all" means every enabled domain (null). Each entry is a
 * domain that also covers its subdomains, so a zone name scopes the whole zone.
 */
export function parseScope(raw: unknown): { ok: true; scope: string[] | null } | { ok: false; invalid: string[] } {
  if (raw === undefined || raw === null) return { ok: true, scope: null };
  const items = (Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/u))
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  if (items.length === 0 || (items.length === 1 && items[0].toLowerCase() === "all")) return { ok: true, scope: null };
  const scope = items.map(normalizeDomain);
  const invalid = items.filter((_, i) => !scope[i]);
  return invalid.length ? { ok: false, invalid } : { ok: true, scope: [...new Set(scope)].sort() };
}

export function inScope(domain: string, scope: string[] | null): boolean {
  return scope === null || scope.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

function storedScope(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return TOKEN_PREFIX + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The tenant a token belongs to, or null when it is unknown or disabled. */
export async function findTenantByToken(env: Env, token: string): Promise<Tenant | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await env.DB.prepare("SELECT id, name, domains FROM tenants WHERE token_hash = ?1 AND disabled_at IS NULL")
    .bind(await hashToken(token))
    .first<{ id: string; name: string; domains: string | null }>();
  return row ? { id: row.id, name: row.name, domains: storedScope(row.domains) } : null;
}

export async function createTenant(
  env: Env,
  name: string,
  domains: string[] | null,
): Promise<{ name: string; token: string; domains: string[] | null; created_at: string }> {
  const token = newToken();
  const createdAt = new Date().toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO tenants (id, name, token_hash, domains, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
  )
    .bind(crypto.randomUUID(), name, await hashToken(token), domains ? JSON.stringify(domains) : null, createdAt)
    .run();
  if (!result.meta.changes) {
    throw new TenantError("tenant_exists", 409, `Issue it a new token instead: cloud-mail tenants rotate --name ${name}`);
  }
  return { name, token, domains, created_at: createdAt };
}

/** A fresh token for an existing tenant. The old one stops working, and a disabled tenant is enabled again. */
export async function rotateTenant(env: Env, name: string): Promise<{ name: string; token: string }> {
  const token = newToken();
  const result = await env.DB.prepare("UPDATE tenants SET token_hash = ?1, disabled_at = NULL WHERE name = ?2")
    .bind(await hashToken(token), name)
    .run();
  if (!result.meta.changes) throw notFound(name);
  return { name, token };
}

/** Stops the token. The tenant's addresses stay theirs and are never handed to anyone else. */
export async function disableTenant(env: Env, name: string): Promise<{ name: string; disabled_at: string }> {
  await env.DB.prepare("UPDATE tenants SET disabled_at = ?1 WHERE name = ?2 AND disabled_at IS NULL")
    .bind(new Date().toISOString(), name)
    .run();
  const row = await env.DB.prepare("SELECT disabled_at FROM tenants WHERE name = ?1")
    .bind(name)
    .first<{ disabled_at: string | null }>();
  if (!row?.disabled_at) throw notFound(name);
  return { name, disabled_at: row.disabled_at };
}

/** Which domains new addresses may use. Existing addresses stay readable whatever the scope. */
export async function setTenantDomains(
  env: Env,
  name: string,
  domains: string[] | null,
): Promise<{ name: string; domains: string[] | null }> {
  const result = await env.DB.prepare("UPDATE tenants SET domains = ?1 WHERE name = ?2")
    .bind(domains ? JSON.stringify(domains) : null, name)
    .run();
  if (!result.meta.changes) throw notFound(name);
  return { name, domains };
}

export async function listTenants(env: Env): Promise<TenantSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.name, t.domains, t.created_at, t.disabled_at,
            COUNT(i.email) AS inboxes, MAX(i.created_at) AS last_inbox_at
       FROM tenants t LEFT JOIN inboxes i ON i.tenant_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at, t.name`,
  ).all<{ name: string; domains: string | null; created_at: string; disabled_at: string | null; inboxes: number; last_inbox_at: string | null }>();
  return results.map((row) => ({ ...row, domains: storedScope(row.domains), inboxes: Number(row.inboxes ?? 0) }));
}

/** Ready-to-paste client setup for a freshly issued token. */
export function connectInfo(origin: string, token: string) {
  const url = `${origin}/mcp`;
  return {
    mcp_url: url,
    connect: {
      claude_code: `claude mcp add --transport http --scope user cloud-mail ${url} --header "Authorization: Bearer ${token}"`,
      pi: `pi mcp add cloud-mail --url ${url} --header "Authorization=Bearer ${token}"`,
      // `codex mcp add` only takes the token from an env var; static headers in the config need no shell setup.
      codex_config_toml: `[mcp_servers.cloud-mail]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`,
      cursor: { mcpServers: { "cloud-mail": { url, headers: { Authorization: `Bearer ${token}` } } } },
      http: `${origin}/api/v1/help`,
    },
  };
}

function notFound(name: string): TenantError {
  return new TenantError("tenant_not_found", 404, `No tenant named ${name}. List them with: cloud-mail tenants list`);
}
