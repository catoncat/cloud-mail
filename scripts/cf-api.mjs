import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const API_BASE = "https://api.cloudflare.com/client/v4";

export function cfHeaders(extra = {}) {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      ...extra,
    };
  }

  if (process.env.CLOUDFLARE_EMAIL && process.env.CLOUDFLARE_GLOBAL_API_KEY) {
    return {
      "x-auth-email": process.env.CLOUDFLARE_EMAIL,
      "x-auth-key": process.env.CLOUDFLARE_GLOBAL_API_KEY,
      ...extra,
    };
  }

  throw new Error(
    "Missing Cloudflare auth. Set CLOUDFLARE_API_TOKEN, or CLOUDFLARE_EMAIL + CLOUDFLARE_GLOBAL_API_KEY.",
  );
}

export async function cfFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: cfHeaders({
      "content-type": "application/json",
      ...(options.headers ?? {}),
    }),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok || body.success === false) {
    const error = JSON.stringify(body.errors ?? body, null, 2);
    throw new Error(`Cloudflare API ${options.method ?? "GET"} ${path} failed: ${error}`);
  }
  return body;
}

export function run(command, args, options = {}) {
  const label = [command, ...args].join(" ");
  console.log(`$ ${label}`);
  return execFileSync(command, args, {
    stdio: options.input ? ["pipe", "pipe", "pipe"] : "pipe",
    encoding: options.encoding ?? "utf8",
    input: options.input,
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

export function normalizeDomain(domain) {
  return String(domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@/u, "")
    .replace(/\.$/u, "");
}

export function loadConfig(pathname) {
  const config = JSON.parse(readFile(pathname));
  config.api_host = normalizeDomain(config.api_host);
  config.worker_name = String(config.worker_name ?? "cloud-mail-intake").trim();
  config.database_name = String(config.database_name ?? config.worker_name).trim();
  config.database_id = String(config.database_id ?? "").trim();
  config.domains = (config.domains ?? []).map((entry) => ({
    ...entry,
    domain: normalizeDomain(entry.domain),
    zone: normalizeDomain(entry.zone),
    enabled: entry.enabled !== false,
    configure_dns: entry.configure_dns !== false,
  }));
  if (!config.api_host) throw new Error("config.api_host is required");
  if (!config.worker_name) throw new Error("config.worker_name is required");
  if (!config.domains.length) throw new Error("config.domains must contain at least one domain");
  return config;
}

export async function resolveZone(domain, explicitZone) {
  const wanted = normalizeDomain(explicitZone || domain);
  let response = await cfFetch(`/zones?name=${encodeURIComponent(wanted)}`);
  let zone = response.result?.[0];
  if (zone) return zone;

  const labels = domain.split(".");
  for (let index = 1; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join(".");
    response = await cfFetch(`/zones?name=${encodeURIComponent(candidate)}`);
    zone = response.result?.[0];
    if (zone) return zone;
  }

  throw new Error(`No Cloudflare zone found for ${domain}`);
}

export async function upsertDnsRecord(zoneId, record) {
  const name = normalizeDomain(record.name);
  const type = String(record.type).toUpperCase();
  const content = String(record.content);
  const params = new URLSearchParams({ type, name });
  const existing = await cfFetch(`/zones/${zoneId}/dns_records?${params.toString()}`);
  const matched = (existing.result ?? []).find((item) => {
    if (item.content !== content) return false;
    return true;
  });
  if (matched) return matched;

  const body = {
    type,
    name,
    content,
    ttl: 1,
    proxied: false,
    comment: "managed by cloud-mail-intake",
  };
  if (type === "MX") body.priority = Number(record.priority);

  const created = await cfFetch(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return created.result;
}

export async function warnConflictingMx(zoneId, domain) {
  const params = new URLSearchParams({ type: "MX", name: domain });
  const existing = await cfFetch(`/zones/${zoneId}/dns_records?${params.toString()}`);
  const conflicts = (existing.result ?? []).filter(
    (item) => !String(item.content).endsWith(".mx.cloudflare.net"),
  );
  if (conflicts.length) {
    console.warn(`[warn] ${domain} has non-Cloudflare MX records; mail delivery may not go only to this Worker.`);
  }
}

export const CLOUDFLARE_MX = [
  { content: "route1.mx.cloudflare.net", priority: 35 },
  { content: "route2.mx.cloudflare.net", priority: 48 },
  { content: "route3.mx.cloudflare.net", priority: 64 },
];

function readFile(pathname) {
  return readFileSync(pathname, "utf8");
}
