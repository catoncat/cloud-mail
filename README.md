# cloud-mail

Self-hosted, receive-only mail platform on Cloudflare. Bring your own domains, receive mail
at any address on them, and read verification codes / magic links from a UI, an API, or a CLI.

Built for three audiences at once:

| Role | Surface | Entry point |
| --- | --- | --- |
| **Agent** | CLI + REST API + skill | `cloud-mail` CLI, `apps/intake` API |
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

It receives and stores mail only. It cannot send, so it cannot be used to spoof or spam.
Stored mail expires automatically (`RETENTION_HOURS`, default 6).

## Layout

```
apps/
  intake/   Receive-only Worker. Email Routing -> D1. Owns domains, mail, admin API.
            Deployed at your mail host, e.g. mail.example.com
  share/    Hono + React admin PWA and public share links. Reads via intake API.
            Deployed at your inbox host, e.g. inbox.example.com
skills/
  cloud-mail-intake/   Agent skill (SSOT; symlinked into ~/.agents/skills)
```

Two Workers, one product. `intake` is the source of truth for domains and mail;
`share` is the human face and never talks to Email Routing directly.

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

- `apps/intake/config/domains.json` — enabled domains (gitignored; see `domains.example.json`)
- `apps/intake/.secrets/mail-admin-token.txt` — admin bearer token (gitignored)
- `apps/share/wrangler.toml` — routes + `INTAKE_ORIGIN` (gitignored; see `wrangler.example.toml`)
- `apps/share/.secrets/share-admin.credentials` — share admin key (gitignored)

Secrets stay out of git. Never print the admin token.
