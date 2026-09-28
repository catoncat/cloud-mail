# cloud-mail-intake

Receive-only Cloudflare Email Routing Worker for many domains.

One Worker handles every configured domain, whether the mailbox domain is an apex domain such as `example.com` or a subdomain such as `mailbox.example.com`.

## CLI

Run all operations through the project CLI:

```bash
cloud-mail help
```

When the global wrapper is not installed, use:

```bash
node scripts/cli.mjs help
```

## Deploy

Needs only `npx wrangler login`; no Cloudflare API token on this machine.

```bash
cp wrangler.example.jsonc wrangler.jsonc   # setup does this if it is missing
cloud-mail setup                           # D1 (create if needed) + migrations + deploy
cloud-mail deploy                          # later code changes
```

`setup` reads the D1 `database_name` and `database_id` from `wrangler.jsonc`. With the
placeholder id it finds the database by name, or creates it, and writes the id back.
If the account cannot create more D1 databases, point both at an existing empty
database. Setup never deletes a database.

The Worker has no route and `workers_dev` is off. Deploy `apps/share` next; every
query below goes through it.

## Domains

Domains live in intake's D1 allowlist. Mail for a domain lands only when Cloudflare
routes it here (zone catch-all to this Worker, plus Email Routing MX on the domain)
**and** the allowlist has it enabled. Share owns the Cloudflare side with its
`CF_API_TOKEN`, so adding a domain is one command from anywhere the CLI works:

```bash
cloud-mail zones                                   # zones share can route
cloud-mail domains add --domain mailbox.example.com
cloud-mail domains check --domain mailbox.example.com   # {status, ready, detail}
```

`domains add` finds the zone, enables Email Routing DNS, points the catch-all here,
confirms the MX records in public DNS, and enables the domain in the allowlist. Every
step is idempotent. If `dnsReady` is `false`, run `followUp.command`; `followUp.reason`
says why (`cloudflare_token_missing`, `email_routing_dns_failed`, `dns_propagating`,
`routing_incomplete`).

Allowlist-only changes, with no Cloudflare calls:

```bash
cloud-mail domains upsert --domain mailbox.example.com --disabled   # stop accepting mail
cloud-mail domains upsert --domain mailbox.example.com              # accept again
```

### Forwards

A domain that is not enabled in the allowlist but has a `forwards` row is forwarded
to that row's destination instead of stored. Existing forwards keep working. New ones
are not automated: the destination must be a verified Email Routing destination
address, and the domain must be routed here but left out of the allowlist.

```bash
cloud-mail forwards list
cloud-mail forwards upsert --domain example.com --destination you@gmail.com [--disabled]
```

## Query

Intake has no public URL and no token. Its JSON API is the `InternalApi` entrypoint,
reached only through the share Worker's Service Binding. The CLI calls share's
`/admin/api/intake/*` relay with `OPERATOR_KEY` from the repo-root
`.secrets/cloud-mail.env`.

```bash
cloud-mail new-address                                           # {ok, email, domain}
cloud-mail latest-code --email test@mailbox.example.com --since 10m --wait 60
cloud-mail latest-link --email test@mailbox.example.com --since 10m --wait 60
cloud-mail messages --email test@mailbox.example.com --limit 20
cloud-mail clear --email test@mailbox.example.com
cloud-mail domains list
```

Output is one JSON document on stdout. Exit `0` answered (read `.ok`; "no code yet"
is `{"ok":false,"error":"no_code_found",…}` with exit 0), `1` failed with the reason
on stderr, `2` bad usage.

Raw Worker API access is also available. Paths under `/admin/api/` go to share;
anything else goes to intake:

```bash
cloud-mail api GET /admin/stats
cloud-mail api GET '/admin/messages?email=test@mailbox.example.com&limit=10'
cloud-mail api GET '/admin/recent-messages?limit=20'
cloud-mail api GET '/admin/mailboxes?limit=500'
cloud-mail api GET /admin/api/overview
```

## Agent Skill

`skills/cloud-mail-intake/SKILL.md` teaches a coding agent to use this project through
the CLI. `npm run install:global` writes `~/bin/cloud-mail` and symlinks the skill into
`~/.agents/skills/` and `~/.codex/skills/`, leaving any existing different entry alone.
Link it into any other agent's skills directory the same way.

## Schema changes

`migrations/` holds numbered SQL files that `cloud-mail setup` replays in filename
order. Every file is idempotent, so setup is safe to re-run and a database created
before this directory existed converges to the same schema. See
`migrations/README.md` before adding one.

## Retention

Stored mail expires after `RETENTION_HOURS` (default 6). Two things drive the sweep:

- the **cron trigger** in `wrangler.example.jsonc` (`*/15 * * * *`), which is what
  makes the guarantee hold for domains that have stopped receiving mail;
- an opportunistic sweep on the ingestion path, throttled to once every 15 minutes.

Deployments whose `wrangler.jsonc` predates the cron trigger keep the ingestion-path
sweep only, which means **mail in an idle domain never expires**. Copy the `triggers`
block into your local `wrangler.jsonc` and redeploy.

## Notes

- This project only receives and stores mail. It does not send mail.
- Unknown recipient domains are rejected by the Worker.
- Catch-all routing is configured per Cloudflare zone, then the Worker allowlist decides which full domains are accepted. A subdomain also needs its own Email Routing MX records, which `domains add` enables and `domains check` verifies.
- Redelivered mail is deduplicated on `(recipient, message_id)`, so a retry cannot produce a second copy of the same one-time code.
