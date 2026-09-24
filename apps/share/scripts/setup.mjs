#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flags = new Set(args);
const skipDeploy = flags.has("--skip-deploy");

const shareHost = valueAfter("--host");
const intakeOrigin = valueAfter("--intake-origin");
const workerName = valueAfter("--name") ?? "cloud-mail-share";
const kvTitle = valueAfter("--kv-title") ?? `${workerName}-links`;

if (flags.has("--help") || flags.has("-h")) {
  console.log(`Usage: node scripts/setup.mjs [options]

  --host <domain>            Custom domain for the share UI, e.g. inbox.example.com
  --intake-origin <url>      Intake Worker origin, e.g. https://mail.example.com
  --name <worker-name>       Worker name (default: cloud-mail-share)
  --kv-title <title>         KV namespace title (default: <worker-name>-links)
  --skip-deploy              Configure everything but do not deploy

Requires Cloudflare credentials in the environment (CLOUDFLARE_API_TOKEN, or
CLOUDFLARE_EMAIL + CLOUDFLARE_GLOBAL_API_KEY), and a deployed intake Worker.`);
  process.exit(0);
}

mkdirSync(".secrets", { recursive: true });
ensureWranglerConfig();
await ensureDependencies();

const accountId = resolveAccountId();
const kvId = ensureKvNamespace(kvTitle);
const origin = resolveIntakeOrigin();
updateWrangler({ accountId, kvId, origin, workerName, shareHost });

const adminKey = ensureAdminKey();
putSecret("ADMIN_KEY", adminKey);
putSecret("MAIL_INTAKE_ADMIN_TOKEN", resolveIntakeToken());

run("npm", ["run", "build"]);

if (!skipDeploy) {
  run("npx", ["wrangler", "deploy"]);
}

console.log(`
[done] share UI configured.

  Admin page:  ${shareHost ? `https://${shareHost}/admin` : "<your share host>/admin"}
  Admin key:   .secrets/share-admin.credentials (mode 600, gitignored)

Optional secrets, upload only if you need them:
  CF_API_TOKEN    lets the admin UI list zones and add mail domains itself
  SERVICE_TOKEN   separate auth for the /api/v1 automation surface

    npx wrangler secret put CF_API_TOKEN`);

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

/** The admin key authenticates the operator console; it is not the intake token. */
function ensureAdminKey() {
  const path = ".secrets/share-admin.credentials";
  if (existsSync(path)) {
    const existing = /^CLOUD_MAIL_SHARE_ADMIN_KEY=(.+)$/mu.exec(readFileSync(path, "utf8"));
    if (existing) {
      console.log("[ok] reusing existing admin key");
      return existing[1].trim();
    }
  }
  const key = randomBytes(32).toString("base64url");
  const originLine = shareHost ? `CLOUD_MAIL_SHARE_ORIGIN=https://${shareHost}\n` : "";
  writeFileSync(path, `CLOUD_MAIL_SHARE_ADMIN_KEY=${key}\n${originLine}`, { mode: 0o600 });
  console.log(`[ok] generated ${path}`);
  return key;
}

/** The share Worker reads mail through intake, so it needs intake's admin token. */
function resolveIntakeToken() {
  if (process.env.MAIL_INTAKE_ADMIN_TOKEN) return process.env.MAIL_INTAKE_ADMIN_TOKEN.trim();
  const intakeToken = "../intake/.secrets/mail-admin-token.txt";
  if (existsSync(intakeToken)) {
    console.log("[ok] read intake admin token from apps/intake/.secrets");
    return readFileSync(intakeToken, "utf8").trim();
  }
  throw new Error(
    "Cannot find the intake admin token. Run `cloud-mail setup` in apps/intake first, " +
      "or set MAIL_INTAKE_ADMIN_TOKEN in the environment.",
  );
}

function resolveIntakeOrigin() {
  if (intakeOrigin) return intakeOrigin.replace(/\/+$/u, "");
  const configPath = "../intake/config/domains.json";
  if (existsSync(configPath)) {
    const apiHost = JSON.parse(readFileSync(configPath, "utf8")).api_host;
    if (apiHost) {
      console.log(`[ok] intake origin from apps/intake config: ${apiHost}`);
      return `https://${apiHost}`;
    }
  }
  throw new Error("Missing --intake-origin and could not read it from apps/intake/config/domains.json");
}

function resolveAccountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID.trim();
  const current = /account_id\s*=\s*"([^"]+)"/u.exec(readFileSync("wrangler.toml", "utf8"));
  if (current && !current[1].startsWith("REPLACE_WITH")) return current[1];
  throw new Error("Missing account id. Set CLOUDFLARE_ACCOUNT_ID or fill account_id in wrangler.toml.");
}

function ensureKvNamespace(title) {
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

function updateWrangler({ accountId, kvId, origin, workerName: name, shareHost: host }) {
  let text = readFileSync("wrangler.toml", "utf8");
  text = text.replace(/^name\s*=\s*"[^"]*"/mu, `name = "${name}"`);
  text = text.replace(/^account_id\s*=\s*"[^"]*"/mu, `account_id = "${accountId}"`);
  text = text.replace(/id = "[^"]*" \}/u, `id = "${kvId}" }`);
  text = text.replace(/^INTAKE_ORIGIN\s*=\s*"[^"]*"/mu, `INTAKE_ORIGIN = "${origin}"`);
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
