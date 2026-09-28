/** Pure helpers behind POST /domains and GET /domains/:domain/health. */

export type Check = { step: string; ok: boolean; detail?: string };

export type FollowUp = { reason: string; command: string; hint: string };

/**
 * What to do when onboarding stopped short of routing mail.
 *
 * Callers are mostly agents, so the reason is a stable code and the command is
 * the literal next step rather than prose.
 */
export function followUpFor(domain: string, checks: Check[]): FollowUp {
  const failed = (step: string) => checks.find((check) => check.step === step && !check.ok);
  const rerun = `cloud-mail domains add --domain ${domain}`;

  if (checks.some((check) => check.detail === "cloudflare_token_missing")) {
    return {
      reason: "cloudflare_token_missing",
      command: "cd apps/share && npx wrangler secret put CF_API_TOKEN",
      hint: `share needs CF_API_TOKEN (${TOKEN_PERMISSIONS}) to route domains; then rerun: ${rerun}`,
    };
  }
  const dns = failed("email_routing_dns");
  if (dns && failed("mx")) {
    return {
      reason: "email_routing_dns_failed",
      command: rerun,
      hint: `Cloudflare refused to enable Email Routing DNS for ${domain} (${dns.detail ?? "failed"}). "Authentication error" means CF_API_TOKEN lacks Zone Settings Edit; grant it, or enable Email Routing for ${domain} in the dashboard, then rerun.`,
    };
  }
  if (failed("mx") && !failed("catch_all")) {
    return {
      reason: "dns_propagating",
      command: `cloud-mail domains check --domain ${domain}`,
      hint: "Routing is configured but public DNS does not show the Cloudflare MX records yet. Poll the command until .ready is true.",
    };
  }
  const problems = checks.filter((check) => !check.ok).map((check) => `${check.step}: ${check.detail ?? "failed"}`);
  return {
    reason: "routing_incomplete",
    command: rerun,
    hint: `Cloudflare rejected part of the setup (${problems.join("; ") || "unknown"}). Fix the cause, then rerun the command; every step is idempotent.`,
  };
}

/** What share's CF_API_TOKEN must be allowed to do on each mail zone. */
export const TOKEN_PERMISSIONS = "Zone Read, Zone Settings Edit, Email Routing Rules Edit";

/** One MX answer in DoH form, e.g. "35 route1.mx.cloudflare.net." */
export function isRoutingMx(data: string): boolean {
  return /\.mx\.cloudflare\.net\.?$/iu.test(data.trim());
}

export type RoutingStatus = "routed" | "unrouted" | "unknown";

/**
 * Mail lands only when both halves agree: Cloudflare routes the domain to intake
 * (catch-all plus MX), and intake's allowlist accepts it. Either alone looks fine
 * and drops mail.
 */
export function readiness(status: RoutingStatus, allowlist: { enabled: boolean } | undefined) {
  const allowlisted = Boolean(allowlist);
  const enabled = allowlist?.enabled === true;
  return { allowlisted, enabled, ready: status === "routed" && enabled };
}
