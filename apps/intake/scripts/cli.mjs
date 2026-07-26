#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig, normalizeDomain } from "./cf-api.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const args = process.argv.slice(2);
const command = args[0] ?? "help";

try {
  await main();
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

async function main() {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return help();
    case "config":
      return configCommand(args.slice(1));
    case "setup":
      return runNode("scripts/setup.mjs", args.slice(1));
    case "route":
    case "routes":
      return routeCommand(args.slice(1));
    case "deploy":
      return run("npx", ["wrangler", "deploy", ...args.slice(1)]);
    case "health":
      return printJson(await workerFetch("GET", "/healthz"));
    case "domains":
      return domainsCommand(args.slice(1));
    case "forwards":
      return forwardsCommand(args.slice(1));
    case "messages":
    case "mail":
      return messagesCommand(args.slice(1));
    case "latest-code":
    case "code":
      return latestCommand("latest-code", args.slice(1));
    case "latest-link":
    case "link":
      return latestCommand("latest-link", args.slice(1));
    case "clear":
      return clearCommand(args.slice(1));
    case "api":
      return apiCommand(args.slice(1));
    case "token-path":
      return console.log(resolve(repoRoot, ".secrets/mail-admin-token.txt"));
    default:
      throw new Error(`Unknown command: ${command}. Run: cloud-mail help`);
  }
}

function help() {
  console.log(`cloud-mail receive-only mail worker CLI

Config:
  cloud-mail config show
  cloud-mail config add --domain mailbox.example.com --zone example.com
  cloud-mail config remove --domain mailbox.example.com
  cloud-mail config set --api-host mail.example.com --worker-name cloud-mail-intake

Deploy/routing:
  cloud-mail setup
  cloud-mail setup --skip-deploy
  cloud-mail route setup
  cloud-mail deploy

Worker API:
  cloud-mail health
  cloud-mail domains list
  cloud-mail domains upsert --domain mailbox.example.com --zone example.com
  cloud-mail forwards list
  cloud-mail forwards upsert --domain example.com --zone example.com --destination you@gmail.com
  cloud-mail messages --email test@mailbox.example.com --limit 20
  cloud-mail messages --domain mailbox.example.com --limit 20
  cloud-mail latest-code --email test@mailbox.example.com
  cloud-mail latest-link --email test@mailbox.example.com
  cloud-mail clear --email test@mailbox.example.com
  cloud-mail api GET /admin/domains
  cloud-mail api POST /admin/domains --json '{"domain":"x.example.com","enabled":true}'
`);
}

async function configCommand(rest) {
  const sub = rest[0] ?? "show";
  if (sub === "show" || sub === "list") return printJson(loadConfig(configPath(rest.slice(1))));
  if (sub === "add") return addDomain(rest.slice(1));
  if (sub === "add-forward") return addForward(rest.slice(1));
  if (sub === "remove" || sub === "rm") return removeDomain(rest.slice(1));
  if (sub === "remove-forward" || sub === "rm-forward") return removeForward(rest.slice(1));
  if (sub === "set") return setConfig(rest.slice(1));
  throw new Error(`Unknown config command: ${sub}`);
}

function addDomain(rest) {
  const path = configPath(rest);
  const raw = readConfigRaw(path);
  const domain = normalizeDomain(requiredOption(rest, "--domain"));
  const zone = normalizeDomain(option(rest, "--zone") ?? "");
  const existing = (raw.domains ?? []).find((entry) => normalizeDomain(entry.domain) === domain);
  const next = {
    domain,
    zone,
    enabled: !has(rest, "--disabled"),
    configure_dns: !has(rest, "--no-dns"),
  };
  if (existing) Object.assign(existing, next);
  else raw.domains = [...(raw.domains ?? []), next];
  writeConfigRaw(path, raw);
  console.log(`[ok] config domain saved: ${domain}`);
}

function addForward(rest) {
  const path = configPath(rest);
  const raw = readConfigRaw(path);
  const domain = normalizeDomain(requiredOption(rest, "--domain"));
  const zone = normalizeDomain(option(rest, "--zone") ?? "");
  const destination = requiredOption(rest, "--destination").trim().toLowerCase();
  const existing = (raw.forwards ?? []).find((entry) => normalizeDomain(entry.domain) === domain);
  const next = {
    domain,
    zone,
    destination,
    enabled: !has(rest, "--disabled"),
    configure_dns: !has(rest, "--no-dns"),
  };
  if (existing) Object.assign(existing, next);
  else raw.forwards = [...(raw.forwards ?? []), next];
  writeConfigRaw(path, raw);
  console.log(`[ok] config forward saved: ${domain} -> ${destination}`);
}

function removeDomain(rest) {
  const path = configPath(rest);
  const raw = readConfigRaw(path);
  const domain = normalizeDomain(requiredOption(rest, "--domain"));
  raw.domains = (raw.domains ?? []).filter((entry) => normalizeDomain(entry.domain) !== domain);
  writeConfigRaw(path, raw);
  console.log(`[ok] config domain removed: ${domain}`);
}

function removeForward(rest) {
  const path = configPath(rest);
  const raw = readConfigRaw(path);
  const domain = normalizeDomain(requiredOption(rest, "--domain"));
  raw.forwards = (raw.forwards ?? []).filter((entry) => normalizeDomain(entry.domain) !== domain);
  writeConfigRaw(path, raw);
  console.log(`[ok] config forward removed: ${domain}`);
}

function setConfig(rest) {
  const path = configPath(rest);
  const raw = readConfigRaw(path);
  const apiHost = option(rest, "--api-host");
  const workerName = option(rest, "--worker-name");
  const databaseName = option(rest, "--database-name");
  const databaseId = option(rest, "--database-id");
  if (apiHost) raw.api_host = normalizeDomain(apiHost);
  if (workerName) raw.worker_name = workerName;
  if (databaseName) raw.database_name = databaseName;
  if (databaseId) raw.database_id = databaseId;
  writeConfigRaw(path, raw);
  console.log("[ok] config updated");
}

function routeCommand(rest) {
  const sub = rest[0] ?? "setup";
  if (sub !== "setup") throw new Error(`Unknown route command: ${sub}`);
  return runNode("scripts/setup-domain.mjs", rest.slice(1));
}

async function domainsCommand(rest) {
  const sub = rest[0] ?? "list";
  if (sub === "list") return printJson(await workerFetch("GET", "/admin/domains"));
  if (sub === "upsert" || sub === "add") {
    const body = {
      domain: requiredOption(rest, "--domain"),
      zone: option(rest, "--zone") ?? option(rest, "--domain"),
      enabled: !has(rest, "--disabled"),
    };
    return printJson(await workerFetch("POST", "/admin/domains", body));
  }
  throw new Error(`Unknown domains command: ${sub}`);
}

async function forwardsCommand(rest) {
  const sub = rest[0] ?? "list";
  if (sub === "list") return printJson(await workerFetch("GET", "/admin/forwards"));
  if (sub === "upsert" || sub === "add") {
    const body = {
      domain: requiredOption(rest, "--domain"),
      zone: option(rest, "--zone") ?? option(rest, "--domain"),
      destination: requiredOption(rest, "--destination"),
      enabled: !has(rest, "--disabled"),
    };
    return printJson(await workerFetch("POST", "/admin/forwards", body));
  }
  throw new Error(`Unknown forwards command: ${sub}`);
}

async function messagesCommand(rest) {
  const params = new URLSearchParams();
  const email = option(rest, "--email");
  const domain = option(rest, "--domain");
  const limit = option(rest, "--limit");
  if (email) params.set("email", email);
  if (domain) params.set("domain", domain);
  if (limit) params.set("limit", limit);
  return printJson(await workerFetch("GET", `/admin/messages?${params.toString()}`));
}

async function latestCommand(type, rest) {
  const email = requiredOption(rest, "--email");
  return printJson(await workerFetch("GET", `/admin/${type}?email=${encodeURIComponent(email)}`));
}

async function clearCommand(rest) {
  const email = requiredOption(rest, "--email");
  return printJson(await workerFetch("DELETE", `/admin/messages?email=${encodeURIComponent(email)}`));
}

async function apiCommand(rest) {
  const method = (rest[0] ?? "GET").toUpperCase();
  const path = rest[1] ?? "";
  if (!path.startsWith("/")) throw new Error("API path must start with /");
  const jsonBody = option(rest, "--json");
  return printJson(await workerFetch(method, path, jsonBody ? JSON.parse(jsonBody) : undefined));
}

async function workerFetch(method, path, body) {
  const config = loadConfig(configPath(args));
  const token = adminToken();
  const curlConfig = [
    "fail-with-body",
    "silent",
    "show-error",
    "retry = 3",
    "retry-all-errors",
    "retry-delay = 1",
    `request = "${method}"`,
    `url = "https://${config.api_host}${path}"`,
    `header = "Authorization: Bearer ${token}"`,
    ...(body === undefined ? [] : [`header = "content-type: application/json"`]),
    "",
  ].join("\n");
  const curlArgs = ["--config", "-"];
  if (body !== undefined) curlArgs.push("--data-binary", JSON.stringify(body));
  const response = spawnSync("curl", curlArgs, {
    input: curlConfig,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const text = response.stdout;
  const parsed = text ? safeJson(text) : null;
  if (response.status !== 0) {
    throw new Error(`Worker API ${method} ${path} failed: ${response.stderr || text}`);
  }
  return parsed ?? text;
}

function readConfigRaw(path) {
  if (!existsSync(path)) {
    return {
      api_host: "mail.example.com",
      worker_name: "cloud-mail-intake",
      database_name: "cloud-mail-intake",
      database_id: "",
      domains: [],
      forwards: [],
    };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeConfigRaw(path, config) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function configPath(rest) {
  return option(rest, "--config") ?? "config/domains.json";
}

function adminToken() {
  const tokenPath = ".secrets/mail-admin-token.txt";
  if (!existsSync(tokenPath)) {
    throw new Error("Missing .secrets/mail-admin-token.txt. Run: cloud-mail setup");
  }
  return readFileSync(tokenPath, "utf8").trim();
}

function requiredOption(rest, name) {
  const value = option(rest, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function option(rest, name) {
  const index = rest.indexOf(name);
  if (index < 0) return null;
  const value = rest[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function has(rest, name) {
  return rest.includes(name);
}

function runNode(script, rest) {
  return run("node", [script, ...rest]);
}

function run(commandName, commandArgs) {
  const result = spawnSync(commandName, commandArgs, {
    stdio: "inherit",
    env: process.env,
    cwd: repoRoot,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
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
