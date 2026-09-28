# cloud-mail

Self-hosted, receive-only mail platform on Cloudflare. Bring your own domains, receive mail
at any address on them, and read verification codes / magic links from a UI, an API, or a CLI.

Built for three audiences at once:

| Role | Surface | Entry point |
| --- | --- | --- |
| **Agent** | CLI + REST API + skill | `cloud-mail` CLI, share `/admin/api/*` and `/api/v1/*` |
| **Operator** (you) | Admin PWA — domains, mailboxes, inbox, services | `https://inbox.example.com` |
| **Recipient** (teammate / end user) | Single shareable OTP inbox link, no login | `https://inbox.example.com/s/<token>` |

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

Deploy intake first; share reads mail through it.

```bash
# 1. receive-only mail Worker
cd apps/intake
npm install
cp config/domains.example.json config/domains.json   # list your domains
node scripts/cli.mjs setup

# 2. admin PWA + share links
cd ../share
npm install
npm run setup -- --host inbox.example.com
```

Both setups are idempotent and need Cloudflare credentials in the environment
(`CLOUDFLARE_API_TOKEN`, or `CLOUDFLARE_EMAIL` + `CLOUDFLARE_GLOBAL_API_KEY`).

Local development and redeploys:

```bash
cd apps/share && npm run dev       # admin UI at :5173
cd apps/share && npm run deploy    # builds web/ into dist/ then deploys
```

## Configuration

Three secrets, all on the share Worker:

| Secret | Who uses it | Where |
| --- | --- | --- |
| `OPERATOR_KEY` | admin PWA, `cloud-mail` CLI | `/admin/api/*` |
| `AUTOMATION_TOKEN` | automation clients | `/api/v1/*` |
| `CF_API_TOKEN` | share itself, to configure Email Routing | Cloudflare API |

Intake needs no secret: share reaches it through a Service Binding, which is not
reachable from the internet. (Until the migration finishes, intake's legacy public
`/admin/*` still answers to `MAIL_ADMIN_TOKEN`; the CLI only uses it when
`.secrets/cloud-mail.env` is absent.)

Local files (all gitignored):

- `.secrets/cloud-mail.env` — `CLOUD_MAIL_ORIGIN`, `OPERATOR_KEY`, `AUTOMATION_TOKEN`; written by `apps/share` setup, read by the CLI
- `apps/share/wrangler.toml` — routes, KV, `INTAKE` binding (see `wrangler.example.toml`)
- `apps/intake/wrangler.jsonc` — D1, cron (see `wrangler.example.jsonc`)

Secrets stay out of git. Never print a key.
