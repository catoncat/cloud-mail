#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const skipDeploy = args.has("--skip-deploy");

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: cloud-mail setup [--skip-deploy]

Creates the D1 database named in wrangler.jsonc if it is missing, replays every
migration, and deploys the intake Worker. Needs only \`npx wrangler login\`.

Domains are not configured here. They live in intake's D1 and are routed by
share: cloud-mail domains add --domain D`);
  process.exit(0);
}

ensureWranglerConfig();
await ensureDependencies();
const databaseName = wranglerValue("database_name");
const databaseId = ensureD1Database(databaseName, wranglerValue("database_id"));
setDatabaseId(databaseId);
applyMigrations(databaseName);

if (!skipDeploy) {
  run("npx", ["wrangler", "deploy"]);
}

console.log("[done] intake deployed. It has no public URL; check it through share with: cloud-mail health");

function run(command, commandArgs) {
  console.log(`$ ${[command, ...commandArgs].join(" ")}`);
  return execFileSync(command, commandArgs, { stdio: "pipe", encoding: "utf8", env: process.env });
}

/** First `"key": "value"` in wrangler.jsonc; the D1 binding is the only one with these keys. */
function wranglerValue(key) {
  const match = new RegExp(`"${key}":\\s*"([^"]*)"`, "u").exec(readFileSync("wrangler.jsonc", "utf8"));
  if (!match) throw new Error(`Could not find "${key}" in wrangler.jsonc`);
  return match[1];
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
  if (configuredId && !configuredId.startsWith("REPLACE_WITH")) {
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

function setDatabaseId(databaseId) {
  const text = readFileSync("wrangler.jsonc", "utf8");
  writeFileSync("wrangler.jsonc", text.replace(/"database_id":\s*"[^"]*"/u, `"database_id": "${databaseId}"`));
  console.log("[ok] wrangler.jsonc database_id set");
}
