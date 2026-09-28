# Cloud Mail Share

Human-friendly shared OTP inbox on top of **cloud-mail-intake**, and the project's only
public API. Reads mail through the `INTAKE` Service Binding in `wrangler.toml`.

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

Create one with the CLI (see [Share A Mailbox](#share-a-mailbox)):

```bash
cloud-mail links create --email name@mailbox.example.com
```

The page shows the full mailbox, large OTP, copy buttons, optional magic-link button, and polls every 8 seconds.

The Worker reads mail through the `INTAKE` Service Binding; nothing about intake is exposed to the browser.

## Install as PWA

The admin console installs as an app. Open the share origin over HTTPS:

- Desktop Chrome/Edge: install from the address bar / app menu
- iOS Safari: Share → Add to Home Screen
- Endpoints: `/manifest.webmanifest`, `/icons/*`

The manifest `start_url` is `/admin`, so the installed app opens the console and
asks for the operator key (`OPERATOR_KEY`). Public share links are meant to be opened as plain URLs
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
- **System** — register receiving domains, check routing, and inspect automation usage.

Adding a domain from the System view (or `cloud-mail domains add --domain D`):
1. Finds the Cloudflare zone that owns the domain.
2. Enables Email Routing DNS records (creates the required MX + verification TXT).
3. Points the zone's catch-all rule at the `cloud-mail-intake` Worker.
4. Confirms public DNS (1.1.1.1) shows the Cloudflare MX records for the domain.
5. Registers the domain in the intake allowlist.

`dnsReady` is `true` only when the catch-all and the MX records are both in place.
Otherwise the domain is still allowlisted and `followUp` names the fix:

| `followUp.reason` | Meaning | `followUp.command` |
| --- | --- | --- |
| `cloudflare_token_missing` | `CF_API_TOKEN` is not set | `cd apps/share && npx wrangler secret put CF_API_TOKEN` |
| `email_routing_dns_failed` | Cloudflare refused step 2 and no MX exists; usually the token lacks Zone Settings Edit | rerun `cloud-mail domains add` after fixing |
| `dns_propagating` | routing is set, MX not visible yet | poll `cloud-mail domains check` until `ready` |
| `routing_incomplete` | the catch-all could not be set | rerun `cloud-mail domains add` after fixing |

`GET /admin/api/domains/:domain/health` (`cloud-mail domains check`) returns
`status` (`routed` / `unrouted` / `unknown`), `detail`, and `ready`, which also
requires the domain to be enabled in the intake allowlist.

Minted addresses are stored under separate private metadata keys. Creating one does **not** whitelist it for public access. Stable `?mail=` access and opaque `/s/<id>` links remain explicit grants.

Address endpoints (admin auth required):

```text
GET    /admin/api/addresses
POST   /admin/api/addresses
PATCH  /admin/api/addresses/:mailbox
DELETE /admin/api/addresses/:mailbox/messages
```

The existing `/admin/api/mailboxes` and `/admin/api/links` interfaces remain available for scripts and integrations.

## Share A Mailbox

From the CLI, which reads the keys itself:

```bash
cloud-mail links create --email name@mailbox.example.com --label shared-with-alice   # .url, .jsonUrl
cloud-mail links list
cloud-mail links delete --id <id>                                                     # revoke
```

The stable `?mail=` URL needs a whitelist entry:

```bash
scripts/allow-mailbox.sh name@mailbox.example.com
cloud-mail api DELETE /admin/api/mailboxes/name@mailbox.example.com                  # revoke
```

Both read keys from the repo-root `.secrets/cloud-mail.env` (gitignored; override with
`CLOUD_MAIL_SECRETS`). Clients without the CLI send the key on stdin so it stays out
of the process list:

```bash
secrets=../../.secrets/cloud-mail.env
origin="$(sed -n 's/^CLOUD_MAIL_ORIGIN=//p' "$secrets")"
sed -n 's/^OPERATOR_KEY=/Authorization: Bearer /p' "$secrets" |
  curl -sS -X POST "$origin/admin/api/links" -H @- -H 'content-type: application/json' \
    --data '{"mailbox":"name@mailbox.example.com","label":"shared-with-alice"}'
```

Link responses include `url` and `jsonUrl`. CSV is available by appending `?format=csv`
to either URL; it returns the latest message only, as one row.

## Deployment

Deploy `apps/intake` first — this Worker reads mail through it. Needs only
`npx wrangler login` and an account id (`CLOUDFLARE_ACCOUNT_ID` or `account_id` in
`wrangler.toml`).

```bash
npm install
npm run setup -- --host inbox.example.com
```

`setup` creates the KV namespace, writes `wrangler.toml` (including the `INTAKE`
Service Binding), generates `OPERATOR_KEY` and `AUTOMATION_TOKEN` into the repo-root
`.secrets/cloud-mail.env`, uploads both as secrets, builds, and deploys.

| Secret | Guards | Uploaded by setup |
| --- | --- | --- |
| `OPERATOR_KEY` | `/admin/api/*` — console and `cloud-mail` CLI | yes |
| `AUTOMATION_TOKEN` | `/api/v1/*` — automation clients | yes |
| `CF_API_TOKEN` | Cloudflare API calls for adding and checking domains. Needs Zone Read, Zone Settings Edit, and Email Routing Rules Edit on the mail zones. Without it, `domains add` only allowlists and answers `followUp.reason: cloudflare_token_missing` | no |

Each surface accepts only its own key, as `Authorization: Bearer <key>`. An unset key
makes its surface answer `503` rather than accept anything. Unknown `/admin/api/*`
paths answer JSON `404`, never the console's HTML.

`/admin/api/intake/*` relays intake's own JSON API verbatim (for example
`/admin/api/intake/admin/messages?email=...`). The `cloud-mail` CLI uses it, so its
output is the same as when it talked to intake directly.

```bash
npx wrangler secret put CF_API_TOKEN
```

Redeploy after code changes with `npm run deploy`.
