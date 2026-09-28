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

if (flags.has("--help") || flags.has("-h")) {
  console.log(`Usage: node scripts/setup.mjs [options]

  --host <domain>            Custom domain for the share UI, e.g. inbox.example.com
  --name <worker-name>       Worker name (default: cloud-mail-share)
  --kv-title <title>         KV namespace title (default: <worker-name>-links)
  --skip-deploy              Configure everything but do not deploy

Requires Cloudflare credentials in the environment (CLOUDFLARE_API_TOKEN, or
CLOUDFLARE_EMAIL + CLOUDFLARE_GLOBAL_API_KEY), and a deployed intake Worker
(share reaches it through the INTAKE Service Binding).`);
  process.exit(0);
}

/** Single local secrets file for the whole project; the CLI reads it too. */
const SECRETS_FILE = "../../.secrets/cloud-mail.env";

ensureWranglerConfig();
await ensureDependencies();

const accountId = resolveAccountId();
const kvId = ensureKvNamespace(kvTitle);
updateWrangler({ accountId, kvId, workerName, shareHost });

const secrets = ensureSecrets();
putSecret("OPERATOR_KEY", secrets.OPERATOR_KEY);
putSecret("AUTOMATION_TOKEN", secrets.AUTOMATION_TOKEN);

run("npm", ["run", "build"]);

if (!skipDeploy) {
  run("npx", ["wrangler", "deploy"]);
}

console.log(`
[done] share UI configured.

  Admin page:  ${shareHost ? `https://${shareHost}/admin` : "<your share host>/admin"}
  Keys:        .secrets/cloud-mail.env at the repo root (mode 600, gitignored)

Optional secret, upload only if you need it:
  CF_API_TOKEN    lets the admin UI list zones and add mail domains itself

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

/** OPERATOR_KEY and AUTOMATION_TOKEN, generated once and reused on every run. */
function ensureSecrets() {
  const values = existsSync(SECRETS_FILE) ? parseEnv(readFileSync(SECRETS_FILE, "utf8")) : {};
  values.OPERATOR_KEY ||= randomBytes(32).toString("base64url");
  values.AUTOMATION_TOKEN ||= randomBytes(32).toString("base64url");
  if (shareHost) values.CLOUD_MAIL_ORIGIN = `https://${shareHost}`;

  const body = ["CLOUD_MAIL_ORIGIN", "OPERATOR_KEY", "AUTOMATION_TOKEN"]
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

function updateWrangler({ accountId, kvId, workerName: name, shareHost: host }) {
  let text = readFileSync("wrangler.toml", "utf8");
  text = text.replace(/^name\s*=\s*"[^"]*"/mu, `name = "${name}"`);
  text = text.replace(/^account_id\s*=\s*"[^"]*"/mu, `account_id = "${accountId}"`);
  text = text.replace(/id = "[^"]*" \}/u, `id = "${kvId}" }`);
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
