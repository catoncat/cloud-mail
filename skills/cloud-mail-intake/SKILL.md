---
name: cloud-mail-intake
description: Use this skill whenever the user wants to deploy, configure, operate, or query a receive-only Cloudflare Email Routing Worker for one or more domains, including apex domains, subdomains, mailbox catch-all, inbound mail smoke tests, reading verification codes or magic links, adding domains, or automating mail setup/API usage quickly.
---

# Cloud Mail Intake

Use the project CLI instead of reconstructing Cloudflare Worker, D1, DNS, Email Routing, or admin API commands manually.

## Configure These Locally

- Repo: set this to the local checkout path, for example `/path/to/cloud-mail-intake`
- CLI: `cloud-mail`, or `node /path/to/cloud-mail-intake/scripts/cli.mjs`
- Config: `<repo>/config/domains.json`
- Admin token file: `<repo>/.secrets/mail-admin-token.txt`
- API host: whatever `config/domains.json` uses, for example `https://mail.example.com`

Do not print the admin token. Use the CLI for Worker API calls because it reads the token locally and sends it as `Authorization: Bearer ...`.

## Cloudflare Auth Lane

Use Cloudflare credentials that can manage Workers, D1, DNS, and Email Routing for the target zones.

For any write operation, first confirm the account/zone, then run the CLI, then read back the changed object.

## Domain Model

The Worker supports any full recipient domain:

- Apex: `example.com`
- Subdomain: `mailbox.example.com`
- Any other domain whose DNS is in a Cloudflare zone

Each config entry has:

```json
{
  "domain": "mailbox.example.com",
  "zone": "example.com",
  "enabled": true,
  "configure_dns": true
}
```

`domain` is the mailbox domain after `@`. `zone` is the Cloudflare zone that owns the DNS records.

Use `forwards` for domains that should continue forwarding to a verified destination mailbox instead of being stored in D1:

```json
{
  "domain": "example.com",
  "zone": "example.com",
  "destination": "you@gmail.com",
  "enabled": true,
  "configure_dns": true
}
```

## CLI Workflows

Create local config:

```bash
cp config/domains.example.json config/domains.json
cp wrangler.example.jsonc wrangler.jsonc
cloud-mail config set --api-host mail.example.com --worker-name cloud-mail-intake
```

Add or update a mailbox domain:

```bash
cloud-mail config add --domain mailbox.example.com --zone example.com
cloud-mail config add-forward --domain example.com --zone example.com --destination you@gmail.com
cloud-mail config show
```

Deploy everything:

```bash
cloud-mail setup
```

Reconfigure routing only:

```bash
cloud-mail route setup
```

Read mail:

```bash
cloud-mail health
cloud-mail domains list
cloud-mail forwards list
cloud-mail messages --email test@mailbox.example.com --limit 20
cloud-mail messages --domain mailbox.example.com --limit 20
cloud-mail latest-code --email test@mailbox.example.com
cloud-mail latest-link --email test@mailbox.example.com
cloud-mail clear --email test@mailbox.example.com
```

## Raw Worker API

Prefer CLI wrappers. If a one-off endpoint is needed:

```bash
cloud-mail api GET /admin/domains
cloud-mail api GET /admin/forwards
cloud-mail api GET '/admin/messages?email=test@mailbox.example.com&limit=10'
cloud-mail api GET '/admin/latest-code?email=test@mailbox.example.com'
cloud-mail api GET '/admin/latest-link?email=test@mailbox.example.com'
cloud-mail api POST /admin/domains --json '{"domain":"x.example.com","zone":"example.com","enabled":true}'
cloud-mail api POST /admin/forwards --json '{"domain":"example.com","zone":"example.com","destination":"you@gmail.com","enabled":true}'
cloud-mail api DELETE '/admin/messages?email=test@mailbox.example.com'
```

## Shareable code inbox (cloud-mail-share)

Human UI for **passwordless re-login** and **OTP handoff to another person**. Reads from intake (`INTAKE_ORIGIN`); never exposes intake `MAIL_ADMIN_TOKEN` to the browser.

### Hosts

The share Worker is deployed at whatever hosts `apps/share/wrangler.toml` routes,
for example `https://inbox.example.com`. Additional hosts may exist as legacy aliases.

Worker code: `apps/share`

Any **intake-enabled** mailbox domain works. The share host is only the UI entry;
the email can be on another domain.


### Install as PWA (desktop / phone)

This installs the **admin console** (`start_url` is `/admin`, so it opens the key
prompt). Share links for other people are plain URLs, not installable apps.

- **Desktop Chrome / Edge / Arc**: address bar install icon, or menu → “安装应用 / Install app”.
- **iPhone / iPad Safari**: Share → **添加到主屏幕**.
- **Android Chrome**: menu → **安装应用** / Add to Home screen.

PWA endpoints:

- `/manifest.webmanifest`
- `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable.png`, `/icons/apple-touch-icon.png`
- `/sw.js` — **no offline caching by design**. It serves a self-unregistering worker
  that clears caches from earlier versions; OTP pages must never be served stale.

### Two public link types

1. **Whitelist `?mail=`** (address visible in URL; good for self use)

```text
https://inbox.example.com/?mail=name@mailbox.example.com
https://inbox.example.com/?mail=name@mailbox.example.com&format=json
```

2. **Opaque share `/s/<id>`** (preferred for giving access to others)

```text
https://inbox.example.com/s/<random-link-id>
https://inbox.example.com/s/<random-link-id>?format=json
```

Page polls latest mail every ~4s, shows large OTP, copy buttons, optional magic-link button.

### Admin key (share UI, not intake)

This is **different** from intake `MAIL_ADMIN_TOKEN`.

| Item | Path / value source |
| --- | --- |
| Local credentials file | `apps/share/.secrets/share-admin.credentials` (gitignored) |
| Env var name in file | `CLOUD_MAIL_SHARE_ADMIN_KEY=...` |
| Override | `CLOUD_MAIL_SHARE_CREDENTIALS` |
| Admin page | `<share-origin>/admin` |

Show the key to the user (do not paste into git/docs):

```bash
sed -n 's/^CLOUD_MAIL_SHARE_ADMIN_KEY=//p' apps/share/.secrets/share-admin.credentials
```

Paste that value into the admin page auth box. File mode should stay `600`.

Do **not** print the key in commits, PR text, or public chat logs. Agents may read the local file to call admin APIs.

### Create links

```bash
# opaque share link (handoff to another person) — preferred
apps/share/scripts/allow-mailbox.sh --link name@mailbox.example.com

# whitelist ?mail= URL (self use)
apps/share/scripts/allow-mailbox.sh name@mailbox.example.com
```

API (admin key from credentials file):

```bash
admin_key="$(sed -n 's/^CLOUD_MAIL_SHARE_ADMIN_KEY=//p' apps/share/.secrets/share-admin.credentials)"
origin="https://inbox.example.com"

# create share link
curl -sS -X POST "$origin/admin/api/links" \
  -H "Authorization: Bearer ${admin_key}" \
  -H 'content-type: application/json' \
  --data '{"mailbox":"name@mailbox.example.com","label":"shared-with-alice"}'

# whitelist mailbox
curl -sS -X POST "$origin/admin/api/mailboxes" \
  -H "Authorization: Bearer ${admin_key}" \
  -H 'content-type: application/json' \
  --data '{"mailbox":"name@mailbox.example.com"}'

# revoke share link
curl -sS -X DELETE "$origin/admin/api/links/<id>" \
  -H "Authorization: Bearer ${admin_key}"

# revoke whitelist
curl -sS -X DELETE "$origin/admin/api/mailboxes/name@mailbox.example.com" \
  -H "Authorization: Bearer ${admin_key}"
```

### Deploy share UI

```bash
cd apps/share
npm run deploy
```

### Agent rules for share links

- Prefer `/s/<id>` when the user will hand the inbox to another person.
- Prefer `?mail=` only for the owner's own re-login convenience after whitelist.
- After passwordless registration, create a share link and store `share_inbox_url` next to the account email.
- Set the public origin with `CLOUD_MAIL_SHARE_ORIGIN`.

## Operational Checks

After deployment or routing changes:

1. `cloud-mail health`
2. `cloud-mail domains list`
3. Cloudflare readback for DNS/Email Routing if routing changed
4. Send one inbound email to a unique address and read it with `cloud-mail messages --email ...`
5. If looking for verification mail, prefer `cloud-mail latest-code` or `cloud-mail latest-link`

Do not assume mail failure is an application bug until DNS MX, Cloudflare Email Routing status, catch-all route, and Worker allowlist are checked.
