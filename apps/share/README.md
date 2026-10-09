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
- **System** — register receiving domains and check routing.

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

## Agent API (`/mcp` and `/api/v1`)

For agents anywhere: give one a tenant token and it can make addresses and read the
mail that arrives at them. `/mcp` is a stateless Streamable HTTP MCP server (official
`@modelcontextprotocol/server`, serving both the 2026-07-28 and the 2025 protocol);
`/api/v1` is the same thing over plain HTTP. Both take `Authorization: Bearer cm_…`.

| MCP tool | HTTP | Does |
| --- | --- | --- |
| `create_inbox` | `POST /api/v1/inboxes` `{name?}` | claim a random address, or a chosen name, on a domain in the tenant's scope |
| `wait_for_email` | `POST /api/v1/inboxes/{email}/wait?timeout=` | newest mail not yet handed out, held open up to 45 s; `{status:"waiting"}` otherwise |
| `read_inbox` | `GET /api/v1/inboxes/{email}/messages?limit=` | recent mail, newest first; never moves what `wait` returns next |
| — | `GET /api/v1/help` | usage for agents; public, contains no key |

Rules, all enforced in `src/lib/inboxes.ts`:

- An address belongs to the tenant that created it, permanently (`inboxes` in D1). It
  is the login identity of whatever account was registered with it, so it is never reassigned.
- A tenant sees only its own addresses, and only mail received after it created them.
- Chosen names are first come, first served (an atomic insert). Role names such as
  `admin` and `postmaster`, and addresses managed in the console, are refused.
- `wait` hands out the newest undelivered mail with its exact `received_at` and moves
  the inbox past it; deciding whether it is the mail just triggered is the agent's call.
- Errors are `{error, hint}`; over MCP they are tool results with `isError`.

Tenants are managed on the operator API: `POST /admin/api/tenants` `{name, domains?}`
(the only answer that contains the token, with `connect` setup for Claude Code, Pi,
Codex and Cursor), `GET /admin/api/tenants`, and `POST /admin/api/tenants/{name}/rotate`,
`/disable`, `/domains`. The `cloud-mail tenants` commands wrap them.

## Deployment

Deploy `apps/intake` first — this Worker reads mail through it. Needs only
`npx wrangler login` and an account id (`CLOUDFLARE_ACCOUNT_ID` or `account_id` in
`wrangler.toml`).

```bash
npm install
npm run setup -- --host inbox.example.com
```

`setup` creates the KV namespace and the tenants D1 database, applies
`migrations/`, writes `wrangler.toml` (including the `INTAKE` Service Binding),
generates `OPERATOR_KEY` into the repo-root `.secrets/cloud-mail.env`, uploads it as
a secret, builds, and deploys.

| Secret | Guards | Uploaded by setup |
| --- | --- | --- |
| `OPERATOR_KEY` | `/admin/api/*` — console and `cloud-mail` CLI | yes |
| `CF_API_TOKEN` | Cloudflare API calls for adding and checking domains. Needs Zone Read, Zone Settings Edit, and Email Routing Rules Edit on the mail zones. Without it, `domains add` only allowlists and answers `followUp.reason: cloudflare_token_missing` | no |

The operator surface accepts only `OPERATOR_KEY`, and the agent surfaces only tenant
tokens, each as `Authorization: Bearer <key>`. An unset `OPERATOR_KEY` makes
`/admin/api/*` answer `503` rather than accept anything. Unknown `/admin/api/*`
paths answer JSON `404`, never the console's HTML.

`/admin/api/intake/*` relays intake's own JSON API verbatim (for example
`/admin/api/intake/admin/messages?email=...`). The `cloud-mail` CLI uses it, so its
output is the same as when it talked to intake directly.

```bash
npx wrangler secret put CF_API_TOKEN
```

Redeploy after code changes with `npm run deploy`.
