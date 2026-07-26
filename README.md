# cloud-mail

Self-hosted, receive-only mail platform on Cloudflare. Bring your own domains, receive mail
at any address on them, and read verification codes / magic links from a UI, an API, or a CLI.

Built for three audiences at once:

| Role | Surface | Entry point |
| --- | --- | --- |
| **Agent** | CLI + REST API + skill | `cloud-mail` CLI, `apps/intake` API |
| **Operator** (you) | Admin PWA — domains, mailboxes, inbox, services | `https://inbox.example.com` |
| **Consumer** (buyer / end user) | Single shareable OTP inbox link, no login | `https://inbox.example.com/s/<token>` |

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

```bash
cd apps/intake && npm install && node scripts/cli.mjs help   # agent / CLI path
cd apps/share  && npm install && npm run dev                 # admin UI at :5173
```

Deploy:

```bash
cd apps/intake && npx wrangler deploy
cd apps/share  && npm run deploy    # builds web/ into dist/ then deploys
```

## Configuration

- `apps/intake/config/domains.json` — enabled domains (gitignored; see `domains.example.json`)
- `apps/intake/.secrets/mail-admin-token.txt` — admin bearer token (gitignored)
- `apps/share/wrangler.toml` — routes + `INTAKE_ORIGIN` (gitignored; see `wrangler.example.toml`)
- `apps/share/.secrets/share-admin.credentials` — share admin key (gitignored)

Secrets stay out of git. Never print the admin token.
