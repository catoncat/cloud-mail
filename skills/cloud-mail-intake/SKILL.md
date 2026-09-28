---
name: cloud-mail-intake
description: Use this skill whenever the user wants to deploy, configure, operate, or query a receive-only Cloudflare Email Routing Worker for one or more domains, including apex domains, subdomains, mailbox catch-all, inbound mail smoke tests, reading verification codes or magic links, adding domains, or automating mail setup/API usage quickly.
disable-model-invocation: true
---

# Cloud Mail Intake

Use the project CLI instead of reconstructing Cloudflare Worker, D1, DNS, Email Routing, or admin API commands manually.

## Configure These Locally

- CLI: `cloud-mail` (installed by `npm run install:global` in `apps/intake`), or `node <repo>/apps/intake/scripts/cli.mjs`
- Keys file: `<repo>/.secrets/cloud-mail.env` (gitignored, mode `600`) with `CLOUD_MAIL_ORIGIN`, `OPERATOR_KEY`, `AUTOMATION_TOKEN`
- Repo root: `dirname "$(dirname "$(cloud-mail token-path)")"` (`token-path` prints the keys file in use)
- Config: `<repo>/apps/intake/config/domains.json`
- API: the CLI calls share at `$CLOUD_MAIL_ORIGIN/admin/api/intake/*` with `OPERATOR_KEY`; share relays to intake over a Service Binding, so responses are identical to intake's

Legacy fallback: without `CLOUD_MAIL_ORIGIN` and `OPERATOR_KEY` in the keys file, the CLI calls intake's public `api_host` directly with `<repo>/apps/intake/.secrets/mail-admin-token.txt`. That path is being retired; do not build on it.

Do not print any key. Use the CLI for Worker API calls because it reads the key locally and sends it as `Authorization: Bearer ...`.

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
# If wrangler.jsonc already exists, merge new `triggers`/`ratelimits` into it.
# Do not `cp wrangler.example.jsonc wrangler.jsonc` over an existing local file.
cloud-mail config set --api-host mail.example.com --worker-name cloud-mail-intake
```

Then run `cloud-mail setup` and the Operational Checks below.

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

Prefer CLI wrappers. If a one-off endpoint is needed (paths are intake paths; the CLI adds the share relay prefix):

```bash
cloud-mail api GET /admin/domains
cloud-mail api GET /admin/forwards
cloud-mail api GET '/admin/messages?email=test@mailbox.example.com&limit=10'
cloud-mail api GET '/admin/recent-messages?limit=20'
cloud-mail api GET '/admin/mailboxes?limit=500'
cloud-mail api GET '/admin/latest-code?email=test@mailbox.example.com'
cloud-mail api GET '/admin/latest-link?email=test@mailbox.example.com'
cloud-mail api POST /admin/domains --json '{"domain":"x.example.com","zone":"example.com","enabled":true}'
cloud-mail api POST /admin/forwards --json '{"domain":"example.com","zone":"example.com","destination":"you@gmail.com","enabled":true}'
cloud-mail api DELETE '/admin/messages?email=test@mailbox.example.com'
```

## Shareable code inbox (cloud-mail-share)

Human UI for **passwordless re-login** and **OTP handoff to another person**. Reads intake through the `INTAKE` Service Binding; no intake token exists in share or the browser.

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

Page polls latest mail every 8s, shows large OTP, copy buttons, optional magic-link button.

### Admin console workflow

The admin PWA is address-first:

1. Create an address for the target service. The UI copies it and starts a live watch.
2. Use it in the signup/login flow, then copy the arriving code or open the magic link.
3. Manage the address label, note, history, share links, and stable self-access from one detail view.

Creating an address stores private identity metadata only. It does not expose the inbox until an opaque share link is created or the stable `?mail=` grant is enabled.

Admin endpoints:

```text
GET    /admin/api/addresses
POST   /admin/api/addresses
PATCH  /admin/api/addresses/:mailbox
DELETE /admin/api/addresses/:mailbox/messages
```

### Keys (all on the share Worker)

| Key | Used by | Surface |
| --- | --- | --- |
| `OPERATOR_KEY` | admin PWA, `cloud-mail` CLI, admin curl | `/admin/api/*`, including the `/admin/api/intake/*` relay |
| `AUTOMATION_TOKEN` | automation clients | `/api/v1/*` |
| `CF_API_TOKEN` | share itself, to configure Email Routing | Cloudflare API |

Local copy: `<repo>/.secrets/cloud-mail.env` (written by `apps/share` setup). `allow-mailbox.sh` honors `CLOUD_MAIL_SECRETS` as an override. Neither key works on the other surface.

Show the operator key to the user (do not paste into git/docs):

```bash
sed -n 's/^OPERATOR_KEY=//p' .secrets/cloud-mail.env
```

Paste that value into the admin page auth box at `<share-origin>/admin`. File mode should stay `600`.

`apps/share/.secrets/share-admin.credentials` (`CLOUD_MAIL_SHARE_ADMIN_KEY`) is the legacy copy of the same operator key, kept for older scripts. Do not add new readers of it.

Do **not** print the key in commits, PR text, or public chat logs. Agents may read the local file to call admin APIs.

### Create links

```bash
# opaque share link (handoff to another person) — preferred
apps/share/scripts/allow-mailbox.sh --link name@mailbox.example.com

# whitelist ?mail= URL (self use)
apps/share/scripts/allow-mailbox.sh name@mailbox.example.com
```

API (from the repo root):

```bash
operator_key="$(sed -n 's/^OPERATOR_KEY=//p' .secrets/cloud-mail.env)"
origin="$(sed -n 's/^CLOUD_MAIL_ORIGIN=//p' .secrets/cloud-mail.env)"

# create share link
curl -sS -X POST "$origin/admin/api/links" \
  -H "Authorization: Bearer ${operator_key}" \
  -H 'content-type: application/json' \
  --data '{"mailbox":"name@mailbox.example.com","label":"shared-with-alice"}'

# whitelist mailbox
curl -sS -X POST "$origin/admin/api/mailboxes" \
  -H "Authorization: Bearer ${operator_key}" \
  -H 'content-type: application/json' \
  --data '{"mailbox":"name@mailbox.example.com"}'

# revoke share link
curl -sS -X DELETE "$origin/admin/api/links/<id>" \
  -H "Authorization: Bearer ${operator_key}"

# revoke whitelist
curl -sS -X DELETE "$origin/admin/api/mailboxes/name@mailbox.example.com" \
  -H "Authorization: Bearer ${operator_key}"
```

### Deploy share UI

```bash
cd apps/share
npm run deploy
```

### Agent rules for share links

- Prefer `/s/<id>` when the user will hand the inbox to another person.
- Prefer `?mail=` only for the owner's own re-login convenience after whitelist.
- When an address backs an account, create a share link and keep `share_inbox_url` alongside the account record.
- The public origin is `CLOUD_MAIL_ORIGIN` in `.secrets/cloud-mail.env`.

## Operational Checks

After deployment or routing changes:

1. `cloud-mail health`
2. `cloud-mail domains list`
3. Cloudflare readback for DNS/Email Routing if routing changed
4. Send one inbound email to a unique address and read it with `cloud-mail messages --email ...`
5. If looking for verification mail, prefer `cloud-mail latest-code` or `cloud-mail latest-link`

Do not assume mail failure is an application bug until DNS MX, Cloudflare Email Routing status, catch-all route, and Worker allowlist are checked.
