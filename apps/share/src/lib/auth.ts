import type { MiddlewareHandler } from "hono";
import { findTenantByToken } from "./tenants";
import type { Env, Tenant } from "./types";

/** The operator surface has exactly one secret. Agents use tenant tokens instead (see requireTenant). */
export type SecretName = "OPERATOR_KEY";

/** Set by requireTenant for the handlers behind it. */
export type TenantVars = { tenant: Tenant };

export function bearerToken(header: string | undefined): string {
  return /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "";
}

/** Hash both sides first so timing reveals neither the content nor the length. */
export async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Bearer auth against one Worker secret.
 *
 * Fails closed with 503 when the secret is unset, so a missing deploy step reads
 * as misconfiguration rather than as a wrong key.
 */
export function requireSecret(name: SecretName, hint?: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const expected = c.env[name] ?? "";
    if (!expected) {
      console.error(JSON.stringify({ level: "error", message: "secret_not_configured", name }));
      return c.json({ error: `${name.toLowerCase()}_not_configured` }, 503);
    }
    const provided = bearerToken(c.req.header("authorization"));
    if (!provided || !(await secretMatches(provided, expected))) {
      return c.json(hint ? { error: "unauthorized", hint } : { error: "unauthorized" }, 401);
    }
    await next();
  };
}

/**
 * Bearer auth for the agent surfaces: the token must belong to an enabled tenant.
 *
 * Tokens are looked up by their SHA-256, so there is no secret to compare in
 * constant time; an unknown and a disabled token answer the same 401.
 */
export function requireTenant(hint: string): MiddlewareHandler<{ Bindings: Env; Variables: TenantVars }> {
  return async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    const tenant = token ? await findTenantByToken(c.env, token) : null;
    if (!tenant) return c.json({ error: "unauthorized", hint }, 401, { "www-authenticate": 'Bearer realm="cloud-mail"' });
    c.set("tenant", tenant);
    await next();
  };
}
