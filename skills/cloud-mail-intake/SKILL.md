---
name: cloud-mail-intake
description: Use this skill whenever the user or task needs a throwaway or account email address on the user's own domains and has to read what arrives there — verification codes (OTP), magic links, full inbound mail — or wants to share one inbox with a person, give a remote agent receive-only access, add or check a mail domain, or operate the cloud-mail Workers (cloudflare email routing, receive-only, inbox.0day3.com, cloud-mail CLI).
disable-model-invocation: true
---

# Cloud Mail

Receive-only mail on the user's own domains. Do everything through the `cloud-mail`
CLI. It reads the keys itself, so you never read, print, or pass a key.

If `cloud-mail` is not on PATH, use `node <repo>/apps/intake/scripts/cli.mjs`.
With no repo here but `CLOUD_MAIL_TOKEN` set (a remote host), use the HTTP API instead:
`curl -s "$CLOUD_MAIL_URL/api/v1/help"` explains it, and its answers have the same shapes.

## Contract

- stdout is one JSON document. Errors go to stderr as `[error] ...`.
- Exit `0`: answered. Read `.ok`; `ok:false` here is an answer such as "no code yet".
- Exit `1`: failed. stderr has the HTTP status and body. See [Errors](#errors).
- Exit `2`: bad usage. Fix the call; retrying the same call cannot succeed.
- `cloud-mail help` lists every command with its output shape.

## Receive a verification code

This is the common case:

```bash
email=$(cloud-mail new-address | jq -r .email)     # random address on an enabled domain
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)               # take it BEFORE triggering the email
# ... submit "$email" in the signup / login form ...
cloud-mail latest-code --email "$email" --since "$since" --wait 120
```

Found:

```json
{"ok":true,"code":"123456","item":{"id":"…","recipient":"…","subject":"…","received_at":"2026-01-02T03:04:05.678Z","code":"123456"}}
```

Nothing fresh within the wait (still exit `0`):

```json
{"ok":false,"error":"no_code_found","item":null,"code":""}
```

- Always pass `--since`. Without it, an older code in the mailbox satisfies the call at once.
- Magic links work the same way: `latest-link` puts the URL in `.link`.
- To resend, take a new `since`, trigger the resend, then call again.
- `--since` also accepts a window: `90s`, `10m`, `2h`.
- `--wait` polls every 3 s. With no `--wait` it checks once.
- Any local part at an enabled domain receives mail (catch-all), so there is nothing to create first. `new-address --domain D` pins the domain.

## Tasks

| Task | Command | Read |
| --- | --- | --- |
| New address | `cloud-mail new-address [--domain D]` | `.email` |
| Wait for an OTP | `cloud-mail latest-code --email E --since T --wait S` | `.ok`, `.code` |
| Wait for a magic link | `cloud-mail latest-link --email E --since T --wait S` | `.ok`, `.link` |
| Read full mail | `cloud-mail messages --email E [--limit N]` | `.items[]`: `sender`, `subject`, `text_body`, `html_body`, `code`, `link`, `received_at` |
| Mail for a whole domain | `cloud-mail messages --domain D [--limit N]` | `.items[]` |
| Delete a mailbox's mail | `cloud-mail clear --email E` | `.changes` |
| Hand an inbox to a human | `cloud-mail links create --email E [--label L]` | `.url` |
| List / revoke share links | `cloud-mail links list` / `cloud-mail links delete --id ID` | `.links[]` / `.ok` |
| Usable domains | `cloud-mail domains list` | `.items[] \| select(.enabled==1) \| .domain` |
| Can domain D receive mail? | `cloud-mail domains check --domain D` | `.ready`, then `.status`, `.detail` |
| Add a mail domain | `cloud-mail domains add --domain D` | `.dnsReady`, else `.followUp` |
| Zones that can take domains | `cloud-mail zones` | `.zones[].name` |
| End-to-end health | `cloud-mail health` | `.ok` |

## Give a remote agent access

An agent on another machine needs no code: the share URL, `AUTOMATION_TOKEN`, and curl.
That token is receive-only. It can create addresses and read their mail, but cannot
delete mail, change domains, or open the console. Never give out `OPERATOR_KEY`.

1. Put the token on the remote host as a file or env var without printing it:
   `sed -n 's/^AUTOMATION_TOKEN=//p' "$(cloud-mail keys-path)" | ssh HOST 'umask 077; cat > ~/.cloud-mail-token'`
   then have its environment export `CLOUD_MAIL_TOKEN="$(cat ~/.cloud-mail-token)"` and `CLOUD_MAIL_URL=<origin>`.
2. Tell the remote agent only: "Receive email with `$CLOUD_MAIL_URL`; read `$CLOUD_MAIL_URL/api/v1/help` first."
   Do not paste the token into its prompt or chat; those end up in logs.
3. Check from the remote side: `curl -s -H "Authorization: Bearer $CLOUD_MAIL_TOKEN" "$CLOUD_MAIL_URL/api/v1/domains"` lists domains.

Rotating `AUTOMATION_TOKEN` (`cd apps/share && npx wrangler secret put AUTOMATION_TOKEN`, then
update the keys file) cuts off every holder at once. Ask the user first.

## Add a mail domain

Adding a domain changes Cloudflare DNS and Email Routing, so confirm with the user first.

1. The domain must sit in a zone listed by `cloud-mail zones`.
2. `cloud-mail domains add --domain D`. Every step is idempotent, so it is safe to rerun.
3. If `.dnsReady` is `true`, you are done. Otherwise run `.followUp.command`:

| `followUp.reason` | Meaning |
| --- | --- |
| `cloudflare_token_missing` | share has no `CF_API_TOKEN`; the user must set it |
| `email_routing_dns_failed` | Cloudflare refused to enable Email Routing DNS; usually the token lacks Zone Settings Edit |
| `dns_propagating` | routing is set, MX not visible yet; poll `domains check` until `.ready` |
| `routing_incomplete` | the catch-all could not be set; `.followUp.hint` says why |

4. Confirm: `cloud-mail domains check --domain D` should give `.ready == true`.

To stop accepting mail without touching Cloudflare, run `cloud-mail domains upsert --domain D --disabled`.

## When mail does not arrive

1. `cloud-mail domains check --domain <domain of E>`. If `ready` is false, `detail` names the missing half: catch-all, MX, or allowlist.
2. `cloud-mail messages --email E`. The mail may have arrived without an extracted code; read `text_body`. `cloud-mail reindex --email E` recomputes code and link with the current extractor.
3. `cloud-mail health`. A 401 means the local keys file is stale.
4. The sender may just be slow: widen `--wait`, keep the same `--since`.

Do not call it an application bug until step 1 says `ready: true`.

## Errors

| stderr contains | Meaning | Do |
| --- | --- | --- |
| `HTTP 401` | `OPERATOR_KEY` rejected | Tell the user the keys file is stale. Do not search for other keys. |
| `Missing CLOUD_MAIL_ORIGIN or OPERATOR_KEY` | no keys file here | Tell the user; `cloud-mail keys-path` shows where it should be |
| `is not an enabled intake domain` | `--domain` is not usable | Pick one from `domains list`, or add it |
| `HTTP 400` + `zone_not_found` | domain is not in this Cloudflare account | Pick a zone from `cloud-mail zones` |
| `HTTP 502` + `intake_unavailable` | share cannot reach intake | Report it; redeploying intake needs the user's OK |
| `HTTP 404` + `not_found` | wrong API path | Check `cloud-mail help` |

## Keys

Never print a key: not in chat, commits, PR text, logs, or command arguments.

| Key | Surface | Where it lives |
| --- | --- | --- |
| `OPERATOR_KEY` | `/admin/api/*`: admin PWA and this CLI | share secret + `.secrets/cloud-mail.env` |
| `AUTOMATION_TOKEN` | `/api/v1/*`: remote agents and automation, receive-only | share secret + `.secrets/cloud-mail.env` |
| `CF_API_TOKEN` | share's own Cloudflare API calls | share secret only |

- The keys file is `<repo>/.secrets/cloud-mail.env` (mode 600, gitignored). `cloud-mail keys-path` prints its path. `CLOUD_MAIL_SECRETS` overrides it.
- A client that cannot use the CLI sends the key on stdin:
  `sed -n 's/^OPERATOR_KEY=/Authorization: Bearer /p' "$(cloud-mail keys-path)" | curl -H @- …`
- When the user needs the key for the admin PWA, copy it rather than print it:
  `sed -n 's/^OPERATOR_KEY=//p' "$(cloud-mail keys-path)" | tr -d '\n' | pbcopy`

## Share links and the PWA (for humans)

- **`/s/<id>`** (`links create`): an opaque link. Prefer it when handing an inbox to someone else. Revoke it with `links delete`.
- **`?mail=E`**: a stable URL that shows the address, for the owner's own re-login. It needs a whitelist entry: `apps/share/scripts/allow-mailbox.sh E`.
- Both pages poll every 8 s. Append `?format=json` or `&format=csv` for machine reads.
- When an address backs an account, create a link and store `share_inbox_url` with the account record.
- The admin PWA is at `$CLOUD_MAIL_ORIGIN/admin` and installs as an app. It asks for `OPERATOR_KEY`.

## How it fits together

```
cloud-mail / PWA ── OPERATOR_KEY ──▶ share (CLOUD_MAIL_ORIGIN) ──Service Binding──▶ intake ──▶ D1
remote agent ── AUTOMATION_TOKEN ──▶ share /api/v1                  Email Routing catch-all ──▶ intake
```

- Intake has no public URL. The CLI reaches intake's API through share's `/admin/api/intake/*` relay, so responses are exactly intake's.
- Raw calls: `cloud-mail api METHOD PATH [--json '{…}']`. Paths under `/admin/api/` go to share; any other path goes to intake. Examples: `/admin/stats`, `/admin/recent-messages?limit=20`, `/admin/mailboxes?limit=500`.
- Mail expires after `RETENTION_HOURS`, set in intake's `wrangler.jsonc`.

## Operate

These deploy or change shared infrastructure. Ask the user before running them.

- Intake: `cloud-mail setup` the first time (D1, migrations, deploy), then `cloud-mail deploy`. Both need only `npx wrangler login`.
- Share: `cd <repo>/apps/share && npm run deploy`.
- Forwards: `cloud-mail forwards list | upsert --domain D --destination X`. This manages existing forward domains; new ones are not automated.
- After any deploy: `cloud-mail health`, `cloud-mail domains check --domain <one domain>`, then send one real mail and read it with `latest-code` or `messages`.
