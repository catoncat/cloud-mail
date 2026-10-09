# cloud-mail

Self-hosted, receive-only mail platform on Cloudflare. Bring your own domains, receive mail
at any address on them, and read verification codes / magic links from a UI, an API, or a CLI.

Built for three audiences at once:

| Role | Surface | Entry point |
| --- | --- | --- |
| **Agent** | Remote MCP (any agent, one line of config), or plain HTTP with the same token | `https://inbox.example.com/mcp`, `https://inbox.example.com/api/v1/help` |
| **Operator** (you) | Admin PWA — domains, mailboxes, inbox; CLI — tenants | `https://inbox.example.com` |
| **Recipient** (teammate / end user) | Single shareable OTP inbox link, no login | `https://inbox.example.com/s/<token>` |

## For agents

Most callers are agents. Connect one to the MCP endpoint and it can make an address,
sign up with it, and receive the code — no repo, no CLI, nothing installed.

### Give an agent access

Each agent (or each person) gets its own tenant token:

```bash
cloud-mail tenants create --name mbp-claude          # prints the token once, plus setup for each client
claude mcp add --transport http --scope user cloud-mail https://inbox.example.com/mcp \
  --header "Authorization: Bearer cm_…"
```

The answer also carries the Pi, Codex (config.toml) and Cursor setup. `--domains kada.cam` limits which
domains the tenant's new addresses use (a zone covers its subdomains); by default it
is every enabled domain. `tenants rotate`, `tenants disable` and `tenants set-domains`
manage it afterwards; `tenants list` shows them all.

### What the agent gets

Three tools. The server instructions explain the flow, so the agent needs no skill:

| Tool | Input | Answer |
| --- | --- | --- |
| `create_inbox` | optional `name` (random otherwise) | `{email, created_at}` |
| `wait_for_email` | `email`, optional `timeout_seconds` (≤ 45) | the newest mail not yet handed out: `{status:"received", code, link, subject, from, received_at, age_seconds, text}`, or `{status:"waiting"}` |
| `read_inbox` | `email`, optional `limit` | recent mail, newest first; does not affect `wait_for_email` |

The rules:

- An address belongs to the tenant that created it, permanently, so the agent can
  log in with it again months later. It is never handed to anyone else.
- A tenant reads only its own addresses, and only mail that arrived after it created them.
- Chosen names are first come, first served; role names such as `admin@` and
  `postmaster@`, and addresses the operator manages in the console, are refused.
- `wait_for_email` gives the exact `received_at`; if a mail predates the moment the
  agent triggered it, the agent calls again and gets only newer mail.

Agents without an MCP client use the same token over plain HTTP; `GET /api/v1/help`
documents it. Scripts on this machine can keep using the operator CLI
(`cloud-mail new-address`, `cloud-mail latest-code`, see `cloud-mail help`).

## What it's for

Signup flows increasingly authenticate by emailing a code or a magic link. If the mailbox
behind an account is a shared team resource, everyone who needs to sign in also needs to
see that mail — without handing out mailbox credentials or admin access.

Typical uses:

- **Shared team accounts** — one SaaS subscription, several people who each need the login code
- **CI / integration tests** — assert on a real verification email without a mail provider SDK
- **Disposable addresses** — a fresh address per signup, on a domain you control
- **Account handoff** — give someone a single link to one inbox, revocable, nothing else exposed
- **Your own re-login** — read the code on your phone without an email client

## Console workflow

The admin PWA is organized around the address used for an account, not the storage tables behind it:

1. Create an address for a service. It is copied immediately and starts listening for mail.
2. Paste it into the signup or login flow. The next code or magic link appears in the live view.
3. Keep the address as an account identity with a label, note, history, and access grants.
4. Share or revoke that address from its detail page. Domain routing and agent usage stay under System.

Created addresses are private metadata. They do not become publicly readable until the operator explicitly creates an opaque share link or enables the stable `?mail=` entry.

It receives and stores mail only. It cannot send, so it cannot be used to spoof or spam.
Stored mail expires automatically (`RETENTION_HOURS`, default 6), swept by a cron trigger so the window holds even for domains that have stopped receiving mail.

## Layout

```
apps/
  intake/   Receive-only Worker. Email Routing -> D1. Owns domains and mail.
            Its JSON API is served on an internal entrypoint (InternalApi).
  share/    Hono + React admin PWA, public share links, and every public API:
            /mcp and /api/v1 for agents (tenants in its own D1), /admin/api for you.
            Reads intake through a Service Binding. Deployed at e.g. inbox.example.com
skills/
  cloud-mail-intake/   Agent skill (installed by `npm run install:global`)
```

Two Workers, one product. `intake` is the source of truth for domains and mail;
`share` is the only front door — for people, agents, and the `cloud-mail` CLI.

```
browser PWA ─┐ OPERATOR_KEY                       ┌─ Email Routing (catch-all)
cloud-mail  ─┘                                    ▼
agents ─── cm_ tenant token ─▶ share ─(Service Binding)─▶ intake ─▶ D1 (mail)
          (/mcp, /api/v1)        └─▶ D1 (tenants, address ownership)
```

## Quick start

Deploy intake first; share reads mail through it. No Cloudflare token lives on
your machine: wrangler's OAuth login deploys, and share holds the one API token.

```bash
npx wrangler login

# 1. receive-only mail Worker: D1 + migrations + deploy
cd apps/intake
npm install
node scripts/cli.mjs setup

# 2. admin PWA, share links, MCP + HTTP API, tenants D1; writes .secrets/cloud-mail.env
cd ../share
npm install
npm run setup -- --host inbox.example.com
npx wrangler secret put CF_API_TOKEN     # Zone Read, Zone Settings Edit, Email Routing Rules Edit

# 3. put the CLI on PATH and link the agent skill
cd ../intake
npm run install:global

# 4. receive mail on a domain in that Cloudflare account
cloud-mail domains add --domain mailbox.example.com   # read .dnsReady; else run .followUp.command
cloud-mail health

# 5. give an agent access (prints its token and client setup once)
cloud-mail tenants create --name my-agent
```

Both setups are idempotent. Domains live in intake's D1, not in a local file;
`cloud-mail domains add` (or System in the admin PWA) routes and enables one.

Local development and redeploys:

```bash
cd apps/share && npm run dev       # admin UI at :5173
cd apps/share && npm run deploy    # builds web/ into dist/ then deploys
cloud-mail deploy                  # intake
```

## Configuration

Two secrets, both on the share Worker:

| Secret | Who uses it | Where |
| --- | --- | --- |
| `OPERATOR_KEY` | admin PWA, `cloud-mail` CLI | `/admin/api/*` |
| `CF_API_TOKEN` | share itself, to route new domains (Zone Read, Zone Settings Edit, Email Routing Rules Edit) | Cloudflare API |

Agents do not use a shared secret: each tenant has its own `cm_` token for `/mcp` and
`/api/v1`, issued with `cloud-mail tenants create`. Share's D1 stores only its SHA-256.

Intake needs no secret and has no public URL: share reaches it through a Service
Binding, which is not reachable from the internet.

Local files (all gitignored):

- `.secrets/cloud-mail.env` — `CLOUD_MAIL_ORIGIN`, `OPERATOR_KEY`; written by `apps/share` setup, read by the CLI (override the path with `CLOUD_MAIL_SECRETS`)
- `apps/share/wrangler.toml` — routes, KV, D1 (tenants), `INTAKE` binding (see `wrangler.example.toml`)
- `apps/intake/wrangler.jsonc` — D1, cron (see `wrangler.example.jsonc`)

Secrets stay out of git. Never print a key.
