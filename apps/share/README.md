# Cloud Mail Share

Human-friendly shared OTP inbox on top of **cloud-mail-intake**. Reads mail from the intake
Worker configured as `INTAKE_ORIGIN` in `wrangler.toml`.

Serves whatever hosts `wrangler.toml` routes, for example `https://inbox.example.com`.

Works for **any intake-enabled domain** — the share host is only the UI entry point;
the mailbox itself can live on a different domain.

## Why this exists

Many passwordless signups only store an email. For:

- your own re-login
- handing an account over to a teammate or client

you need a **shareable code inbox link** that auto-polls the latest OTP / magic link.

## Two public link types

### 1) Whitelist mailbox (`?mail=`)

Stable URL that includes the real mailbox address:

```text
https://inbox.example.com/?mail=name@mailbox.example.com
https://inbox.example.com/?mail=name@mailbox.example.com&format=json
https://inbox.example.com/?mail=name@mailbox.example.com&format=csv
```

Only works after the mailbox is added to the admin whitelist.

### 2) Random share link (`/s/<id>`) — preferred for handoff

Opaque link; the recipient does not need admin access:

```text
https://inbox.example.com/s/<random-link-id>
https://inbox.example.com/s/<random-link-id>?format=json
```

Create with admin API or:

```bash
scripts/allow-mailbox.sh --link name@mailbox.example.com
```

The page shows the full mailbox, large OTP, copy buttons, optional magic-link button, and polls every 8 seconds.

The Worker reads mail with the intake `MAIL_ADMIN_TOKEN` on the server; that token is never exposed to the browser.

## Install as PWA

The admin console installs as an app. Open the share origin over HTTPS:

- Desktop Chrome/Edge: install from the address bar / app menu
- iOS Safari: Share → Add to Home Screen
- Endpoints: `/manifest.webmanifest`, `/icons/*`

The manifest `start_url` is `/admin`, so the installed app opens the console and
asks for the admin key. Public share links are meant to be opened as plain URLs
rather than installed.

There is deliberately **no offline caching**. `/sw.js` serves a self-unregistering
worker that clears caches left by earlier versions: verification codes are
short-lived and must never be served stale from a cache.

## Admin Page

```text
https://inbox.example.com/admin
```

The console has three task-oriented views:

- **Live** — create and copy an address, then watch the next code or magic link arrive.
- **Addresses** — search account identities, edit service/notes, inspect history, and manage access.
- **System** — configure receiving domains, check routing, and inspect automation usage.

Minted addresses are stored under separate private metadata keys. Creating one does **not** whitelist it for public access. Stable `?mail=` access and opaque `/s/<id>` links remain explicit grants.

Address endpoints (admin auth required):

```text
GET    /admin/api/addresses
POST   /admin/api/addresses
PATCH  /admin/api/addresses/:mailbox
DELETE /admin/api/addresses/:mailbox/messages
```

The existing `/admin/api/mailboxes` and `/admin/api/links` interfaces remain available for scripts and integrations.

## Allow A Mailbox

Credentials (gitignored; override with `CLOUD_MAIL_SHARE_CREDENTIALS`):

```text
apps/share/.secrets/share-admin.credentials
```

Whitelist `?mail=` URL:

```bash
scripts/allow-mailbox.sh name@mailbox.example.com
```

Create a share link:

```bash
scripts/allow-mailbox.sh --link name@mailbox.example.com
```

API equivalents:

```bash
admin_key="$(sed -n 's/^CLOUD_MAIL_SHARE_ADMIN_KEY=//p' .secrets/share-admin.credentials)"
origin="https://inbox.example.com"

# whitelist
curl -sS -X POST "$origin/admin/api/mailboxes"   -H "Authorization: Bearer ${admin_key}"   -H 'content-type: application/json'   --data '{"mailbox":"name@mailbox.example.com"}'

# share link (recommended for handing an inbox to someone else)
curl -sS -X POST "$origin/admin/api/links"   -H "Authorization: Bearer ${admin_key}"   -H 'content-type: application/json'   --data '{"mailbox":"name@mailbox.example.com","label":"shared-with-alice"}'
```

Response includes `url`, `jsonUrl`, `csvUrl`.

## Revoke

```bash
admin_key="$(sed -n 's/^CLOUD_MAIL_SHARE_ADMIN_KEY=//p' .secrets/share-admin.credentials)"
origin="https://inbox.example.com"

# whitelist
curl -sS -X DELETE "$origin/admin/api/mailboxes/name@mailbox.example.com"   -H "Authorization: Bearer ${admin_key}"

# share link
curl -sS -X DELETE "$origin/admin/api/links/<id>"   -H "Authorization: Bearer ${admin_key}"
```

## Deployment

Deploy `apps/intake` first — this Worker reads mail through it.

```bash
npm install
npm run setup -- --host inbox.example.com
```

`setup` creates the KV namespace, writes `wrangler.toml`, generates the admin key into
`.secrets/share-admin.credentials`, uploads the required secrets, builds, and deploys.
The intake origin and admin token are read from `../intake` automatically; override with
`--intake-origin` and `MAIL_INTAKE_ADMIN_TOKEN` if intake lives elsewhere.

Two secrets are optional and not uploaded by setup:

| Secret | Enables |
| --- | --- |
| `CF_API_TOKEN` | admin UI lists Cloudflare zones and can add mail domains itself |
| `SERVICE_TOKEN` | separate auth for the `/api/v1` automation surface |

```bash
npx wrangler secret put CF_API_TOKEN
```

Redeploy after code changes with `npm run deploy`.
