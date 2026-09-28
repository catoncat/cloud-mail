import type { MiddlewareHandler } from "hono";
import type { Env } from "./types";

/** Each surface has exactly one secret; there is no fallback to another key. */
export type SecretName = "OPERATOR_KEY" | "AUTOMATION_TOKEN";

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
