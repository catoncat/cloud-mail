# Cloud Mail Share

Human-friendly **接码收件箱** on top of **cloud-mail-intake**. Reads mail from the intake
Worker configured as `INTAKE_ORIGIN` in `wrangler.toml`.

Serves whatever hosts `wrangler.toml` routes, for example `https://inbox.example.com`.

Works for **any intake-enabled domain** — the share host is only the UI entry point;
the mailbox itself can live on a different domain.

## Why this exists

Many passwordless signups only store an email. For:

- your own re-login
- handing a sold account to a buyer

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

### 2) Random share link (`/s/<id>`) — preferred for resale

Opaque link; buyer does not need admin access:

```text
https://inbox.example.com/s/<random-link-id>
https://inbox.example.com/s/<random-link-id>?format=json
```

Create with admin API or:

```bash
scripts/allow-mailbox.sh --link name@mailbox.example.com
```

The page shows the full mailbox, large OTP, copy buttons, optional magic-link button, and polls every 4 seconds.

The Worker reads mail with the intake `MAIL_ADMIN_TOKEN` on the server; that token is never exposed to the browser.

## Install as PWA

Open the share origin over HTTPS:

- Desktop Chrome/Edge: install from the address bar / app menu
- iOS Safari: Share → Add to Home Screen
- Endpoints: `/manifest.webmanifest`, `/sw.js`, `/icons/*`
- Service worker caches shell only; live mail paths stay network-only

## Admin Page

```text
https://inbox.example.com/admin
```

Paste the admin key from the local credentials file, then add / list / copy / revoke whitelisted mailboxes. Batch paste is supported (one per line / commas / whitespace).

## Allow A Mailbox

Credentials (gitignored; override with `CLOUD_MAIL_SHARE_CREDENTIALS`):

```text
apps/share/.secrets/share-admin.credentials
```

Whitelist `?mail=` URL:

```bash
scripts/allow-mailbox.sh name@mailbox.example.com
```

Create resale/share link:

```bash
scripts/allow-mailbox.sh --link name@mailbox.example.com
```

API equivalents:

```bash
admin_key="$(sed -n 's/^CLOUD_MAIL_SHARE_ADMIN_KEY=//p' .secrets/share-admin.credentials)"
origin="https://inbox.example.com"

# whitelist
curl -sS -X POST "$origin/admin/api/mailboxes"   -H "Authorization: Bearer ${admin_key}"   -H 'content-type: application/json'   --data '{"mailbox":"name@mailbox.example.com"}'

# share link (recommended for selling)
curl -sS -X POST "$origin/admin/api/links"   -H "Authorization: Bearer ${admin_key}"   -H 'content-type: application/json'   --data '{"mailbox":"name@mailbox.example.com","label":"sold-to-x"}'
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

Copy `wrangler.example.toml` to `wrangler.toml` and fill in your account ID, routes,
and KV namespace ID. Then:

```bash
npm run deploy
```
