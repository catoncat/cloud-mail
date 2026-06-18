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
cloud-mail api GET '/admin/messages?email=test@mailbox.example.com&limit=10'
cloud-mail api GET '/admin/latest-code?email=test@mailbox.example.com'
cloud-mail api GET '/admin/latest-link?email=test@mailbox.example.com'
cloud-mail api POST /admin/domains --json '{"domain":"x.example.com","zone":"example.com","enabled":true}'
cloud-mail api DELETE '/admin/messages?email=test@mailbox.example.com'
```

## Operational Checks

After deployment or routing changes:

1. `cloud-mail health`
2. `cloud-mail domains list`
3. Cloudflare readback for DNS/Email Routing if routing changed
4. Send one inbound email to a unique address and read it with `cloud-mail messages --email ...`
5. If looking for verification mail, prefer `cloud-mail latest-code` or `cloud-mail latest-link`

Do not assume mail failure is an application bug until DNS MX, Cloudflare Email Routing status, catch-all route, and Worker allowlist are checked.
