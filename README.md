# cloud-mail

Self-hosted, receive-only mail platform on Cloudflare. Bring your own domains, receive mail
at any address on them, and read verification codes / magic links from a UI, an API, or a CLI.

Built for three audiences at once:

| Role | Surface | Entry point |
| --- | --- | --- |
| **Agent** | CLI + skill (JSON out, stable exit codes), or plain HTTP with no repo | `cloud-mail` CLI, `skills/cloud-mail-intake/SKILL.md`, `https://inbox.example.com/api/v1/help` |
| **Operator** (you) | Admin PWA — domains, mailboxes, inbox, services | `https://inbox.example.com` |
| **Recipient** (teammate / end user) | Single shareable OTP inbox link, no login | `https://inbox.example.com/s/<token>` |

## For agents

Most callers are agents. There are two ways in, depending on where the agent runs.

### On this machine: the CLI

One CLI that prints JSON and never asks the agent to handle a key:

```bash
email=$(cloud-mail new-address | jq -r .email)            # random address on an enabled domain
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)                      # now trigger the email
cloud-mail latest-code --email "$email" --since "$since" --wait 120 | jq -r .code
cloud-mail links create --email "$email" | jq -r .url     # hand the inbox to a human
```

Exit `0` means answered (read `.ok`), `1` failed (reason on stderr), `2` bad usage.
`cloud-mail help` lists every command with its output shape; the skill in
`skills/cloud-mail-intake/SKILL.md` is the full playbook.

### Anywhere else: HTTP, no repo

A remote agent needs no code: only the share URL, the `AUTOMATION_TOKEN`, and curl.
The API documents itself, so point the agent at the help page:

```bash
curl -s https://inbox.example.com/api/v1/help                  # public, no key; markdown usage
auth="Authorization: Bearer $CLOUD_MAIL_TOKEN"
email=$(curl -s -X POST -H "$auth" https://inbox.example.com/api/v1/addresses | jq -r .email)
curl -s -H "$auth" "https://inbox.example.com/api/v1/code?email=$email&since=$since&wait=60"
```

That token can create addresses and read their mail, nothing else: it cannot delete
mail, change domains, or open the console. Put it on the remote host as an environment
variable (for example `CLOUD_MAIL_TOKEN`), not in the agent's prompt, which ends up
in logs.

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
  share/    Hono + React admin PWA, public share links, and the only public API.
            Reads intake through a Service Binding. Deployed at e.g. inbox.example.com
skills/
  cloud-mail-intake/   Agent skill (installed by `npm run install:global`)
```

Two Workers, one product. `intake` is the source of truth for domains and mail;
`share` is the only front door — for people, agents, and the `cloud-mail` CLI.

```
browser PWA ─┐ OPERATOR_KEY                     ┌─ Email Routing (catch-all)
cloud-mail  ─┤                                  ▼
automation  ─┘ AUTOMATION_TOKEN ─▶ share ─(Service Binding)─▶ intake ─▶ D1
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

# 2. admin PWA, share links, and the public API; writes .secrets/cloud-mail.env
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

Three secrets, all on the share Worker:

| Secret | Who uses it | Where |
| --- | --- | --- |
| `OPERATOR_KEY` | admin PWA, `cloud-mail` CLI | `/admin/api/*` |
| `AUTOMATION_TOKEN` | remote agents and automation: receive-only (addresses, codes, links, messages) | `/api/v1/*` |
| `CF_API_TOKEN` | share itself, to route new domains (Zone Read, Zone Settings Edit, Email Routing Rules Edit) | Cloudflare API |

Intake needs no secret and has no public URL: share reaches it through a Service
Binding, which is not reachable from the internet.

Local files (all gitignored):

- `.secrets/cloud-mail.env` — `CLOUD_MAIL_ORIGIN`, `OPERATOR_KEY`, `AUTOMATION_TOKEN`; written by `apps/share` setup, read by the CLI (override the path with `CLOUD_MAIL_SECRETS`)
- `apps/share/wrangler.toml` — routes, KV, `INTAKE` binding (see `wrangler.example.toml`)
- `apps/intake/wrangler.jsonc` — D1, cron (see `wrangler.example.jsonc`)

Secrets stay out of git. Never print a key.
