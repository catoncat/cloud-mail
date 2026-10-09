#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS_FILE = process.env.CLOUD_MAIL_SECRETS || resolve(repoRoot, "../../.secrets/cloud-mail.env");
const POLL_MS = 3000;
process.chdir(repoRoot);

const args = process.argv.slice(2);
const command = args[0] ?? "help";

/** Bad flags or an unknown command: the caller must change the call, not retry it. */
class UsageError extends Error {}

try {
  await main();
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof UsageError ? 2 : 1);
}

async function main() {
  const rest = args.slice(1);
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return help();
    case "new-address":
    case "address":
      return newAddressCommand(rest);
    case "latest-code":
    case "code":
      return latestCommand("code", rest);
    case "latest-link":
    case "link":
      return latestCommand("link", rest);
    case "messages":
    case "mail":
      return messagesCommand(rest);
    case "clear":
      return clearCommand(rest);
    case "links":
      return linksCommand(rest);
    case "tenants":
      return tenantsCommand(rest);
    case "domains":
      return domainsCommand(rest);
    case "zones":
      return printJson(shareFetch("GET", "/zones"));
    case "forwards":
      return forwardsCommand(rest);
    case "health":
      return printJson(workerFetch("GET", "/healthz"));
    case "setup":
      return run("node", ["scripts/setup.mjs", ...rest]);
    case "deploy":
      return run("npx", ["wrangler", "deploy", ...rest]);
    case "reindex":
      return reindexCommand(rest);
    case "api":
      return apiCommand(rest);
    case "keys-path":
    case "token-path":
      return console.log(SECRETS_FILE);
    case "config":
    case "route":
    case "routes":
      throw new UsageError(`${command} was removed: domains live in intake's D1 and are routed by share. Use: cloud-mail domains add --domain D`);
    default:
      throw new UsageError(`Unknown command: ${command}. Run: cloud-mail help`);
  }
}

function help() {
  console.log(`cloud-mail: receive-only mail for agents (OTP codes, magic links, shareable inboxes)

Receive a code (the common case):
  cloud-mail new-address [--domain D]                 -> {ok, email, domain}
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)                # just before triggering the email
  cloud-mail latest-code --email E --since "$since" --wait 120
                                                      -> {ok, code, item}
  cloud-mail latest-link --email E --since "$since" --wait 120
                                                      -> {ok, link, item}
    --since  ISO 8601 time, or a window such as 90s, 10m, 2h; older mail is ignored
    --wait   seconds to keep polling (every ${POLL_MS / 1000}s); default 0 = check once
    Nothing (fresh) found: {"ok":false,"error":"no_code_found","item":null,"code":""}, exit 0

Read and clean mail:
  cloud-mail messages --email E [--limit N]           -> {ok, items[]}
  cloud-mail messages --domain D [--limit N]
  cloud-mail clear --email E                          -> {ok, changes}

Share an inbox with a human (page auto-polls the latest code):
  cloud-mail links create --email E [--label L]       -> {id, url, jsonUrl, mailbox}
  cloud-mail links list                               -> {links[]}
  cloud-mail links delete --id ID                     -> {ok}

Give an agent its own access (MCP at <share>/mcp, or plain HTTP at <share>/api/v1):
  cloud-mail tenants create --name N [--domains D,D]  -> {name, token, mcp_url, connect{claude_code, pi, codex_config_toml, cursor}}
      the token is printed only here; --domains limits which domains new addresses use
      (each covers its subdomains, so a zone name scopes the zone); default is every enabled domain
  cloud-mail tenants list                             -> {tenants[{name, domains, inboxes, disabled_at}]}
  cloud-mail tenants rotate --name N                  -> new token; the old one stops working
  cloud-mail tenants disable --name N                 stops the token; its addresses stay its own
  cloud-mail tenants set-domains --name N --domains D,D|all

Domains:
  cloud-mail domains list                             -> {ok, items[{domain, zone, enabled}]}
  cloud-mail domains check --domain D                 -> {domain, status, ready, detail}
  cloud-mail domains add --domain D                   -> {ok, dnsReady, checks[], followUp}
      routes the zone to intake and enables D; if dnsReady is false, do followUp.command
  cloud-mail domains upsert --domain D [--zone Z] [--disabled]
      allowlist only, no Cloudflare changes; --disabled stops accepting mail for D
  cloud-mail zones                                    -> {zones[], configured[]}
  cloud-mail forwards list | upsert --domain D --destination you@example.com

Operate:
  cloud-mail health                                   -> {ok, service} proves key + share -> intake
  cloud-mail setup                                    create D1 if needed, migrate, deploy intake
  cloud-mail deploy                                   deploy intake only
  cloud-mail reindex [--dry] [--email E] [--limit N]  recompute stored code/link
  cloud-mail api METHOD PATH [--json '{...}']         raw call; /admin/api/* goes to share,
                                                      any other path to intake (e.g. /admin/stats)
  cloud-mail keys-path                                where the keys file lives

Output: one JSON document on stdout.
Exit:   0 answered (read .ok) | 1 failed, reason on stderr | 2 bad usage, fix the call
Keys:   CLOUD_MAIL_ORIGIN and OPERATOR_KEY from ${SECRETS_FILE}
        (override with CLOUD_MAIL_SECRETS). Never print them.
`);
}

async function newAddressCommand(rest) {
  const wanted = option(rest, "--domain");
  const { items = [] } = workerFetch("GET", "/admin/domains");
  const enabled = items.filter((item) => Number(item.enabled) === 1).map((item) => item.domain);
  let domain;
  if (wanted) {
    domain = wanted.trim().toLowerCase();
    if (!enabled.includes(domain)) {
      throw new Error(`${domain} is not an enabled intake domain. See: cloud-mail domains list`);
    }
  } else {
    if (!enabled.length) throw new Error("No enabled intake domains. Add one with: cloud-mail domains add --domain D");
    domain = enabled[randomInt(enabled.length)];
  }
  return printJson({ ok: true, email: `${randomLocalPart()}@${domain}`, domain });
}

/** Catch-all routing accepts any local part; start with a letter to satisfy picky signup forms. */
function randomLocalPart() {
  const letters = "abcdefghijkmnpqrstuvwxyz";
  const alphabet = `${letters}23456789`;
  let local = letters[randomInt(letters.length)];
  for (let index = 0; index < 11; index += 1) local += alphabet[randomInt(alphabet.length)];
  return local;
}

/**
 * Latest code or link for one mailbox, optionally polling for a fresh one.
 *
 * Without --since, any stored match counts, so a code from an earlier login would
 * satisfy --wait immediately. Agents should always pass --since.
 */
async function latestCommand(field, rest) {
  const email = requiredOption(rest, "--email");
  const since = parseSince(option(rest, "--since"));
  const waitSeconds = parseSeconds(option(rest, "--wait") ?? "0", "--wait");
  const deadline = Date.now() + waitSeconds * 1000;
  const notFound = `no_${field}_found`;
  const path = `/admin/latest-${field}?email=${encodeURIComponent(email)}`;

  for (;;) {
    const result = workerFetch("GET", path, undefined, { answers: [notFound] });
    const fresh = result?.ok === true && (since === null || Date.parse(result.item?.received_at ?? "") >= since);
    if (fresh) return printJson(result);
    if (Date.now() >= deadline) {
      return printJson({ ok: false, error: notFound, item: null, [field]: "" });
    }
    await sleep(Math.min(POLL_MS, deadline - Date.now()));
  }
}

function parseSince(value) {
  if (value === null) return null;
  const window = /^(\d+)([smh])$/u.exec(value);
  if (window) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000 }[window[2]];
    return Date.now() - Number(window[1]) * unit;
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new UsageError(`--since must be ISO 8601 (2026-01-02T03:04:05Z) or a window like 10m, got: ${value}`);
  return time;
}

function parseSeconds(value, name) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError(`${name} must be a number of seconds, got: ${value}`);
  return seconds;
}

function messagesCommand(rest) {
  const params = new URLSearchParams();
  const email = option(rest, "--email");
  const domain = option(rest, "--domain");
  const limit = option(rest, "--limit");
  if (!email && !domain) throw new UsageError("messages needs --email E or --domain D");
  if (email) params.set("email", email);
  if (domain) params.set("domain", domain);
  if (limit) params.set("limit", limit);
  return printJson(workerFetch("GET", `/admin/messages?${params.toString()}`));
}

function clearCommand(rest) {
  const email = requiredOption(rest, "--email");
  return printJson(workerFetch("DELETE", `/admin/messages?email=${encodeURIComponent(email)}`));
}

function linksCommand(rest) {
  const sub = rest[0] ?? "list";
  if (sub === "list") return printJson(shareFetch("GET", "/links"));
  if (sub === "create") {
    const body = { mailbox: requiredOption(rest, "--email"), label: option(rest, "--label") ?? undefined };
    return printJson(shareFetch("POST", "/links", body));
  }
  if (sub === "delete") {
    return printJson(shareFetch("DELETE", `/links/${encodeURIComponent(requiredOption(rest, "--id"))}`));
  }
  throw new UsageError(`Unknown links command: ${sub}. Use: list | create --email E | delete --id ID`);
}

/** Who may use the agent surfaces. A token exists in plain text only in the answer that issues it. */
function tenantsCommand(rest) {
  const sub = rest[0] ?? "list";
  if (sub === "list") return printJson(shareFetch("GET", "/tenants"));
  if (sub === "create") {
    return printJson(shareFetch("POST", "/tenants", { name: requiredOption(rest, "--name"), domains: option(rest, "--domains") ?? undefined }));
  }
  if (!["rotate", "disable", "set-domains"].includes(sub)) {
    throw new UsageError(`Unknown tenants command: ${sub}. Use: list | create | rotate | disable | set-domains`);
  }
  const path = `/tenants/${encodeURIComponent(requiredOption(rest, "--name"))}`;
  if (sub === "rotate") return printJson(shareFetch("POST", `${path}/rotate`));
  if (sub === "disable") return printJson(shareFetch("POST", `${path}/disable`));
  return printJson(shareFetch("POST", `${path}/domains`, { domains: requiredOption(rest, "--domains") }));
}

function domainsCommand(rest) {
  const sub = rest[0] ?? "list";
  if (sub === "list") return printJson(workerFetch("GET", "/admin/domains"));
  if (sub === "add") {
    if (has(rest, "--zone") || has(rest, "--disabled")) {
      throw new UsageError("domains add finds the zone itself and always enables. For allowlist-only changes use: cloud-mail domains upsert");
    }
    return printJson(shareFetch("POST", "/domains", { domain: requiredOption(rest, "--domain") }));
  }
  if (sub === "check") {
    return printJson(shareFetch("GET", `/domains/${encodeURIComponent(requiredOption(rest, "--domain"))}/health`));
  }
  if (sub === "upsert") {
    const body = {
      domain: requiredOption(rest, "--domain"),
      zone: option(rest, "--zone") ?? option(rest, "--domain"),
      enabled: !has(rest, "--disabled"),
    };
    return printJson(workerFetch("POST", "/admin/domains", body));
  }
  throw new UsageError(`Unknown domains command: ${sub}. Use: list | check | add | upsert`);
}

function forwardsCommand(rest) {
  const sub = rest[0] ?? "list";
  if (sub === "list") return printJson(workerFetch("GET", "/admin/forwards"));
  if (sub === "upsert") {
    const body = {
      domain: requiredOption(rest, "--domain"),
      zone: option(rest, "--zone") ?? option(rest, "--domain"),
      destination: requiredOption(rest, "--destination"),
      enabled: !has(rest, "--disabled"),
    };
    return printJson(workerFetch("POST", "/admin/forwards", body));
  }
  throw new UsageError(`Unknown forwards command: ${sub}. Use: list | upsert`);
}

/** Recompute stored code/link with the current extractor. */
function reindexCommand(rest) {
  const params = new URLSearchParams();
  if (has(rest, "--dry")) params.set("dry", "1");
  const email = option(rest, "--email");
  if (email) params.set("email", email);
  const limit = option(rest, "--limit");
  if (limit) params.set("limit", limit);
  const query = params.toString();
  return printJson(workerFetch("POST", `/admin/reindex${query ? `?${query}` : ""}`));
}

function apiCommand(rest) {
  const method = (rest[0] ?? "GET").toUpperCase();
  const path = rest[1] ?? "";
  if (!path.startsWith("/")) throw new UsageError("Usage: cloud-mail api METHOD /path [--json '{...}']");
  const jsonBody = option(rest, "--json");
  let body;
  try {
    body = jsonBody ? JSON.parse(jsonBody) : undefined;
  } catch {
    throw new UsageError("--json is not valid JSON");
  }
  const sharePath = path.startsWith("/admin/api/") ? path.slice("/admin/api".length) : `/intake${path}`;
  return printJson(shareFetch(method, sharePath, body));
}

/**
 * Intake's own API. Intake has no public URL; share relays its JSON verbatim, so
 * the output is exactly what intake returns.
 */
function workerFetch(method, path, body, options) {
  return shareFetch(method, `/intake${path}`, body, options);
}

/**
 * One call to share's operator API (/admin/api/*).
 *
 * A 2xx body is the answer. So is an error body the caller names in `answers`:
 * "no code in this mailbox yet" is a result to read, not a failure. Anything else
 * throws with the HTTP status and body, so the caller sees why.
 */
function shareFetch(method, apiPath, body, { answers = [] } = {}) {
  const response = shareRequest(method, apiPath, body);
  if (response.status >= 200 && response.status < 300) return response.body;
  if (answers.includes(response.body?.error)) return response.body;
  const detail = typeof response.body === "string" ? response.body.trim().slice(0, 500) : JSON.stringify(response.body);
  const hint = response.status === 401 ? ` (OPERATOR_KEY in ${SECRETS_FILE} was rejected)` : "";
  throw new Error(`${method} /admin/api${apiPath} -> HTTP ${response.status}: ${detail}${hint}`);
}

/** curl reads the key from stdin, so it never shows up in the process list. */
function shareRequest(method, apiPath, body) {
  const { origin, key } = shareCredentials();
  const url = `${origin}/admin/api${apiPath}`;
  const curlConfig = [
    "silent",
    "show-error",
    "retry = 3",
    "retry-delay = 1",
    `request = "${method}"`,
    `url = "${url}"`,
    `header = "Authorization: Bearer ${key}"`,
    ...(body === undefined ? [] : [`header = "content-type: application/json"`]),
    `write-out = "\\n%{http_code}"`,
    "",
  ].join("\n");
  const curlArgs = ["--config", "-"];
  if (body !== undefined) curlArgs.push("--data-binary", JSON.stringify(body));
  const result = spawnSync("curl", curlArgs, { input: curlConfig, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  if (result.error) throw new Error(`could not run curl: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${method} ${url} failed: ${result.stderr.trim() || `curl exit ${result.status}`}`);
  }
  const cut = result.stdout.lastIndexOf("\n");
  const text = result.stdout.slice(0, cut);
  return { status: Number(result.stdout.slice(cut + 1)), body: text ? (safeJson(text) ?? text) : null };
}

function shareCredentials() {
  const secrets = existsSync(SECRETS_FILE) ? parseEnv(readFileSync(SECRETS_FILE, "utf8")) : {};
  if (!secrets.CLOUD_MAIL_ORIGIN || !secrets.OPERATOR_KEY) {
    throw new Error(`Missing CLOUD_MAIL_ORIGIN or OPERATOR_KEY in ${SECRETS_FILE}. Run: cd apps/share && npm run setup -- --host <share host>`);
  }
  return { origin: secrets.CLOUD_MAIL_ORIGIN.replace(/\/+$/u, ""), key: secrets.OPERATOR_KEY };
}

function parseEnv(text) {
  return Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
      return match ? [[match[1], match[2].trim()]] : [];
    }),
  );
}

function requiredOption(rest, name) {
  const value = option(rest, name);
  if (!value) throw new UsageError(`${name} is required`);
  return value;
}

function option(rest, name) {
  const index = rest.indexOf(name);
  if (index < 0) return null;
  const value = rest[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${name} requires a value`);
  return value;
}

function has(rest, name) {
  return rest.includes(name);
}

function run(commandName, commandArgs) {
  const result = spawnSync(commandName, commandArgs, {
    stdio: "inherit",
    env: process.env,
    cwd: repoRoot,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
