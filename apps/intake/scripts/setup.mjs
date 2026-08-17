#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadConfig, run } from "./cf-api.mjs";

const args = new Set(process.argv.slice(2));
const configPath = valueAfter("--config") ?? "config/domains.json";
const skipDeploy = args.has("--skip-deploy");
const skipEmailRouting = args.has("--skip-email-routing");
const config = loadConfig(configPath);

mkdirSync(".secrets", { recursive: true });
ensureWranglerConfig();
ensureAdminToken();
await ensureDependencies();
const databaseId = ensureD1Database(config.database_name, config.database_id);
updateWrangler(config, databaseId);
applyMigrations(config.database_name);
seedConfiguredDomains(config);
seedConfiguredForwards(config);
putSecret("MAIL_ADMIN_TOKEN", readFileSync(".secrets/mail-admin-token.txt", "utf8").trim());

if (!skipDeploy) {
  run("npx", ["wrangler", "deploy"]);
}

if (!skipEmailRouting) {
  run("node", ["scripts/setup-domain.mjs", "--config", configPath, "--skip-worker-admin"]);
}

console.log(`[done] https://${config.api_host}/healthz`);

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function ensureAdminToken() {
  if (existsSync(".secrets/mail-admin-token.txt")) return;
  writeFileSync(".secrets/mail-admin-token.txt", `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  console.log("[ok] generated .secrets/mail-admin-token.txt");
}

function ensureWranglerConfig() {
  if (existsSync("wrangler.jsonc")) return;
  if (!existsSync("wrangler.example.jsonc")) {
    throw new Error("Missing wrangler.jsonc and wrangler.example.jsonc");
  }
  writeFileSync("wrangler.jsonc", readFileSync("wrangler.example.jsonc", "utf8"));
  console.log("[ok] created wrangler.jsonc from wrangler.example.jsonc");
}

async function ensureDependencies() {
  if (existsSync("node_modules")) return;
  run("npm", ["install"]);
}

/**
 * Replays every migration in filename order.
 *
 * There is no ledger of applied migrations on purpose: databases created before
 * this directory existed have no such ledger to read, and inventing one would make
 * them look unmigrated. Instead every migration is written to be idempotent, so a
 * full replay converges to the same schema from any starting point. See
 * migrations/README.md.
 */
function applyMigrations(databaseName) {
  const files = readdirSync("migrations")
    .filter((file) => /^\d+_.*\.sql$/u.test(file))
    .sort();

  if (files.length === 0) throw new Error("No migrations found in migrations/");

  for (const file of files) {
    run("npx", ["wrangler", "d1", "execute", databaseName, "--remote", "--file", `migrations/${file}`]);
    console.log(`[ok] migration applied: ${file}`);
  }
}

function ensureD1Database(name, configuredId) {
  const listRaw = run("npx", ["wrangler", "d1", "list", "--json"]);
  const list = JSON.parse(listRaw);
  if (configuredId) {
    const configured = list.find((database) => database.uuid === configuredId);
    if (!configured) throw new Error(`Configured D1 database_id was not found: ${configuredId}`);
    console.log(`[ok] D1 configured: ${configured.name}`);
    return configured.uuid;
  }

  const existing = list.find((database) => database.name === name);
  if (existing?.uuid) {
    console.log(`[ok] D1 exists: ${name}`);
    return existing.uuid;
  }

  const createdRaw = run("npx", ["wrangler", "d1", "create", name]);
  const match = createdRaw.match(/database_id\s*=\s*"([^"]+)"/u) ?? createdRaw.match(/([0-9a-f]{8}-[0-9a-f-]{27,})/iu);
  if (!match) throw new Error(`Could not parse D1 database id from wrangler output:\n${createdRaw}`);
  console.log(`[ok] D1 created: ${name}`);
  return match[1];
}

function updateWrangler(currentConfig, databaseId) {
  let text = readFileSync("wrangler.jsonc", "utf8");
  // Anchored to the top-level key at its own indentation. A bare /"name":/ would
  // also match nested bindings such as ratelimits[].name and rewrite the wrong one.
  text = replaceTopLevel(text, "name", currentConfig.worker_name);
  text = text.replace(/"pattern":\s*"[^"]+"/u, `"pattern": "${currentConfig.api_host}"`);
  text = text.replace(/"database_name":\s*"[^"]+"/u, `"database_name": "${currentConfig.database_name}"`);
  text = text.replace(/"database_id":\s*"[^"]+"/u, `"database_id": "${databaseId}"`);
  writeFileSync("wrangler.jsonc", text);
  console.log("[ok] wrangler.jsonc updated");
}

function replaceTopLevel(text, key, value) {
  const pattern = new RegExp(`^(\\s{0,2}"${key}":\\s*)"[^"]*"`, "mu");
  if (!pattern.test(text)) throw new Error(`Could not find top-level "${key}" in wrangler.jsonc`);
  return text.replace(pattern, `$1"${value}"`);
}

function seedConfiguredDomains(currentConfig) {
  const now = new Date().toISOString();
  for (const entry of currentConfig.domains) {
    const domain = sqlString(entry.domain);
    const zone = sqlString(entry.zone || entry.domain);
    const enabled = entry.enabled ? 1 : 0;
    const timestamp = sqlString(now);
    run("npx", [
      "wrangler",
      "d1",
      "execute",
      currentConfig.database_name,
      "--remote",
      "--command",
      `INSERT INTO domains (domain, zone, enabled, created_at, updated_at)
       VALUES (${domain}, ${zone}, ${enabled}, ${timestamp}, ${timestamp})
       ON CONFLICT(domain) DO UPDATE SET
         zone = excluded.zone,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    ]);
    console.log(`[ok] D1 domain allowlist: ${entry.domain}`);
  }
}

function seedConfiguredForwards(currentConfig) {
  const now = new Date().toISOString();
  for (const entry of currentConfig.forwards ?? []) {
    const domain = sqlString(entry.domain);
    const zone = sqlString(entry.zone || entry.domain);
    const destination = sqlString(entry.destination);
    const enabled = entry.enabled !== false ? 1 : 0;
    const timestamp = sqlString(now);
    run("npx", [
      "wrangler",
      "d1",
      "execute",
      currentConfig.database_name,
      "--remote",
      "--command",
      `INSERT INTO forwards (domain, zone, destination, enabled, created_at, updated_at)
       VALUES (${domain}, ${zone}, ${destination}, ${enabled}, ${timestamp}, ${timestamp})
       ON CONFLICT(domain) DO UPDATE SET
         zone = excluded.zone,
         destination = excluded.destination,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    ]);
    console.log(`[ok] D1 forward domain: ${entry.domain} -> ${entry.destination}`);
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function putSecret(name, value) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: `${value}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler secret put ${name} failed:\n${result.stderr || result.stdout}`);
  }
  console.log(`[ok] secret uploaded: ${name}`);
}
