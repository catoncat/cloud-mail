#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const flags = new Set(args);
const skipDeploy = flags.has("--skip-deploy");

const shareHost = valueAfter("--host");
const workerName = valueAfter("--name") ?? "cloud-mail-share";
const kvTitle = valueAfter("--kv-title") ?? `${workerName}-links`;
const d1Name = valueAfter("--d1-name") ?? workerName;

if (flags.has("--help") || flags.has("-h")) {
  console.log(`Usage: node scripts/setup.mjs [options]

  --host <domain>            Custom domain for the share UI, e.g. inbox.example.com
  --name <worker-name>       Worker name (default: cloud-mail-share)
  --kv-title <title>         KV namespace title (default: <worker-name>-links)
  --d1-name <name>           D1 database for tenants (default: <worker-name>)
  --skip-deploy              Configure everything but do not deploy

Requires \`npx wrangler login\` (no local Cloudflare token), an account id
(CLOUDFLARE_ACCOUNT_ID or account_id in wrangler.toml), and a deployed intake
Worker (share reaches it through the INTAKE Service Binding).

Generates OPERATOR_KEY once, uploads it, and keeps it in .secrets/cloud-mail.env
at the repo root for the cloud-mail CLI. Creates the tenants D1 database and
applies its migrations. Agents get their own tokens afterwards:
cloud-mail tenants create --name <name>.`);
  process.exit(0);
}

/** Single local secrets file for the whole project; the CLI reads it too. */
const SECRETS_FILE = "../../.secrets/cloud-mail.env";

ensureWranglerConfig();
await ensureDependencies();

const accountId = resolveAccountId();
const kvId = ensureKvNamespace(kvTitle);
const d1Id = ensureD1Database(d1Name);
updateWrangler({ accountId, kvId, d1Id, d1Name, workerName, shareHost });
run("npx", ["wrangler", "d1", "migrations", "apply", d1Name, "--remote"]);

const secrets = ensureSecrets();
putSecret("OPERATOR_KEY", secrets.OPERATOR_KEY);

run("npm", ["run", "build"]);

if (!skipDeploy) {
  run("npx", ["wrangler", "deploy"]);
}

console.log(`
[done] share UI configured.

  Admin page:  ${shareHost ? `https://${shareHost}/admin` : "<your share host>/admin"}
  Agents:      ${shareHost ? `https://${shareHost}/mcp` : "<your share host>/mcp"}  (token: cloud-mail tenants create --name <name>)
  Keys:        .secrets/cloud-mail.env at the repo root (mode 600, gitignored)

Needed to add mail domains (cloud-mail domains add, or the admin UI):
  CF_API_TOKEN    Cloudflare API token with Zone Read, Email Routing Rules Edit
                  and Zone Settings Edit on the zones that receive mail

    npx wrangler secret put CF_API_TOKEN

Check: cloud-mail health && cloud-mail zones`);

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function run(command, commandArgs, options = {}) {
  console.log(`$ ${[command, ...commandArgs].join(" ")}`);
  return execFileSync(command, commandArgs, {
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    env: process.env,
  });
}

function capture(command, commandArgs) {
  return run(command, commandArgs, { capture: true });
}

function ensureWranglerConfig() {
  if (existsSync("wrangler.toml")) return;
  if (!existsSync("wrangler.example.toml")) {
    throw new Error("Missing wrangler.toml and wrangler.example.toml");
  }
  writeFileSync("wrangler.toml", readFileSync("wrangler.example.toml", "utf8"));
  console.log("[ok] created wrangler.toml from wrangler.example.toml");
}

async function ensureDependencies() {
  if (existsSync("node_modules")) return;
  run("npm", ["install"]);
}

/** OPERATOR_KEY, generated once and reused on every run. */
function ensureSecrets() {
  const values = existsSync(SECRETS_FILE) ? parseEnv(readFileSync(SECRETS_FILE, "utf8")) : {};
  values.OPERATOR_KEY ||= randomBytes(32).toString("base64url");
  if (shareHost) values.CLOUD_MAIL_ORIGIN = `https://${shareHost}`;

  const body = ["CLOUD_MAIL_ORIGIN", "OPERATOR_KEY"]
    .filter((name) => values[name])
    .map((name) => `${name}=${values[name]}\n`)
    .join("");
  mkdirSync(dirname(SECRETS_FILE), { recursive: true });
  writeFileSync(SECRETS_FILE, body, { mode: 0o600 });
  console.log(`[ok] wrote ${SECRETS_FILE}`);
  if (!values.CLOUD_MAIL_ORIGIN) {
    console.log("[warn] no CLOUD_MAIL_ORIGIN yet; rerun with --host so the CLI knows where share lives");
  }
  return values;
}

function parseEnv(text) {
  return Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
      return match ? [[match[1], match[2].trim()]] : [];
    }),
  );
}

function resolveAccountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID.trim();
  const current = /account_id\s*=\s*"([^"]+)"/u.exec(readFileSync("wrangler.toml", "utf8"));
  if (current && !current[1].startsWith("REPLACE_WITH")) return current[1];
  throw new Error("Missing account id. Set CLOUDFLARE_ACCOUNT_ID or fill account_id in wrangler.toml.");
}

/** An id already in wrangler.toml, unless it is still the example placeholder. */
function configuredId(pattern) {
  const id = pattern.exec(readFileSync("wrangler.toml", "utf8"))?.[1] ?? "";
  return id && !id.startsWith("REPLACE_WITH") ? id : null;
}

/**
 * The configured namespace wins over a lookup by title: a live deployment may
 * use a namespace with another title, and swapping it would hide all its data.
 */
function ensureKvNamespace(title) {
  const configured = configuredId(/binding = "SHARE_LINKS", id = "([^"]*)"/u);
  if (configured) {
    console.log(`[ok] KV configured: ${configured}`);
    return configured;
  }
  const list = JSON.parse(capture("npx", ["wrangler", "kv", "namespace", "list"]));
  const existing = list.find((ns) => ns.title === title);
  if (existing) {
    console.log(`[ok] KV exists: ${title}`);
    return existing.id;
  }
  const created = capture("npx", ["wrangler", "kv", "namespace", "create", title]);
  const match = /id\s*=\s*"([0-9a-f]{32})"/iu.exec(created) ?? /([0-9a-f]{32})/iu.exec(created);
  if (!match) throw new Error(`Could not parse KV namespace id from wrangler output:\n${created}`);
  console.log(`[ok] KV created: ${title}`);
  return match[1];
}

function ensureD1Database(name) {
  const configured = configuredId(/database_id = "([^"]*)"/u);
  if (configured) {
    console.log(`[ok] D1 configured: ${configured}`);
    return configured;
  }
  const list = JSON.parse(capture("npx", ["wrangler", "d1", "list", "--json"]));
  const existing = list.find((db) => db.name === name);
  if (existing) {
    console.log(`[ok] D1 exists: ${name}`);
    return existing.uuid;
  }
  const created = capture("npx", ["wrangler", "d1", "create", name]);
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu.exec(created);
  if (!match) throw new Error(`Could not parse D1 database id from wrangler output:\n${created}`);
  console.log(`[ok] D1 created: ${name}`);
  return match[1];
}

function updateWrangler({ accountId, kvId, d1Id, d1Name: database, workerName: name, shareHost: host }) {
  let text = readFileSync("wrangler.toml", "utf8");
  text = text.replace(/^name\s*=\s*"[^"]*"/mu, `name = "${name}"`);
  text = text.replace(/^account_id\s*=\s*"[^"]*"/mu, `account_id = "${accountId}"`);
  text = text.replace(/(binding = "SHARE_LINKS", id = ")[^"]*"/u, `$1${kvId}"`);
  // Configs written before tenants existed have no D1 block yet.
  if (!/^d1_databases\s*=/mu.test(text)) {
    text = text.replace(
      /^(kv_namespaces = \[[\s\S]*?\n\]\n)/mu,
      `$1\n# Tenants and the addresses they own. Strongly consistent: names are claimed first come, first served.\nd1_databases = [\n  { binding = "DB", database_name = "${database}", database_id = "${d1Id}", migrations_dir = "migrations" }\n]\n`,
    );
  }
  text = text.replace(/database_name = "[^"]*", database_id = "[^"]*"/u, `database_name = "${database}", database_id = "${d1Id}"`);
  if (host) {
    // Drop the placeholder route carried over from wrangler.example.toml.
    text = text.replace(/^\s*\{ pattern = "inbox\.example\.com".*\},?\n/mu, "");
    text = text.replace(/,(\s*\n\])/u, "$1");
    // Only add the host if missing. Existing routes may serve live traffic.
    if (!text.includes(`"${host}"`)) {
      text = text.replace(/routes = \[\n?/u, `routes = [\n  { pattern = "${host}", custom_domain = true \},\n`);
      text = text.replace(/,(\s*\n\])/u, "$1");
    }
  }
  writeFileSync("wrangler.toml", text);
  console.log("[ok] wrangler.toml updated");
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
