import type { Env } from "./types";

const API = "https://api.cloudflare.com/client/v4";

export type Zone = { id: string; name: string; status: string };

type CFResponse<T> = { success: boolean; result: T; errors?: Array<{ message: string }> };

export class CloudflareError extends Error {}

async function cf<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  if (!env.CF_API_TOKEN) throw new CloudflareError("cloudflare_token_missing");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const data = (await res.json()) as CFResponse<T>;
  if (!res.ok || !data.success) {
    throw new CloudflareError(data.errors?.[0]?.message ?? `cloudflare_http_${res.status}`);
  }
  return data.result;
}

export async function listZones(env: Env): Promise<Zone[]> {
  const zones = await cf<Zone[]>(env, "/zones?per_page=100&status=active");
  return zones.map((z) => ({ id: z.id, name: z.name, status: z.status })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function findZone(env: Env, domain: string): Promise<Zone | null> {
  const zones = await listZones(env);
  // Longest suffix wins so foo.bar.example.com maps to bar.example.com over example.com.
  return zones
    .filter((z) => domain === z.name || domain.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

/** Enable Email Routing DNS for an apex or subdomain. */
export async function enableEmailRouting(env: Env, zone: Zone, domain: string): Promise<void> {
  const body = domain === zone.name ? {} : { name: domain };
  await cf(env, `/zones/${zone.id}/email/routing/dns`, { method: "POST", body: JSON.stringify(body) });
}

/** Point the zone catch-all at the intake Worker. */
export async function setCatchAll(env: Env, zone: Zone, workerName = "cloud-mail-intake"): Promise<void> {
  await cf(env, `/zones/${zone.id}/email/routing/rules/catch_all`, {
    method: "PUT",
    body: JSON.stringify({
      name: `cloud-mail-intake catch-all -> ${workerName}`,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [workerName] }],
    }),
  });
}

export async function getCatchAll(env: Env, zoneId: string): Promise<{ enabled: boolean; target: string } | null> {
  try {
    const r = await cf<{ enabled?: boolean; actions?: Array<{ type: string; value: string[] }> }>(
      env,
      `/zones/${zoneId}/email/routing/rules/catch_all`,
    );
    const worker = r.actions?.find((a) => a.type === "worker")?.value?.[0] ?? "";
    return { enabled: Boolean(r.enabled), target: worker };
  } catch {
    return null;
  }
}
