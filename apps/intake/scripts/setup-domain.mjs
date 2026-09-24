#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  cfFetch,
  loadConfig,
  resolveZone,
} from "./cf-api.mjs";

const args = new Set(process.argv.slice(2));
const configPath = valueAfter("--config") ?? "config/domains.json";
const skipDns = args.has("--skip-dns");
const skipWorkerAdmin = args.has("--skip-worker-admin");
const config = loadConfig(configPath);

await configureWorkerDomains();
await configureCloudflareDomains();

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function configureWorkerDomains() {
  if (skipWorkerAdmin) return;
  const token = readFileSync(".secrets/mail-admin-token.txt", "utf8").trim();
  for (const entry of config.domains) {
    const response = await fetch(`https://${config.api_host}/admin/domains`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        domain: entry.domain,
        zone: entry.zone || entry.domain,
        enabled: entry.enabled,
      }),
    });
    if (!response.ok) {
      throw new Error(`Worker admin upsert failed for ${entry.domain}: ${response.status} ${await response.text()}`);
    }
    console.log(`[ok] worker domain allowlist: ${entry.domain}`);
  }
}

async function configureCloudflareDomains() {
  const zones = new Map();
  for (const entry of [...config.domains, ...(config.forwards ?? [])]) {
    const zone = await resolveZone(entry.domain, entry.zone);
    zones.set(zone.id, { zone, entries: [...(zones.get(zone.id)?.entries ?? []), entry] });
  }

  for (const { zone, entries } of zones.values()) {
    console.log(`[zone] ${zone.name} (${zone.id})`);
    if (!skipDns) {
      for (const entry of entries) {
        await configureDnsForDomain(zone.id, entry.domain, zone.name, entry.configure_dns);
      }
    }
    await configureCatchAll(zone.id, config.worker_name);
  }
}

async function configureDnsForDomain(zoneId, domain, zoneName, enabled) {
  if (!enabled) return;

  if (domain === zoneName) {
    await cfFetch(`/zones/${zoneId}/email/routing/dns`, { method: "POST", body: "{}" });
    console.log(`[ok] email routing DNS enabled for apex ${domain}`);
    return;
  }

  await cfFetch(`/zones/${zoneId}/email/routing/dns`, {
    method: "POST",
    body: JSON.stringify({ name: domain }),
  });
  console.log(`[ok] email routing enabled for subdomain ${domain}`);
}

async function configureCatchAll(zoneId, workerName) {
  const body = {
    name: `cloud-mail-intake catch-all -> ${workerName}`,
    enabled: true,
    matchers: [{ type: "all" }],
    actions: [{ type: "worker", value: [workerName] }],
  };

  try {
    const existing = await cfFetch(`/zones/${zoneId}/email/routing/rules/catch_all`);
    if (existing.result?.tag) {
      await cfFetch(`/zones/${zoneId}/email/routing/rules/catch_all`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      console.log(`[ok] catch-all updated for zone ${zoneId}`);
      return;
    }
  } catch {
    // Some accounts return 404 until catch-all is created.
  }

  await cfFetch(`/zones/${zoneId}/email/routing/rules/catch_all`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  console.log(`[ok] catch-all created for zone ${zoneId}`);
}
