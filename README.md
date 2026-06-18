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

## Configure

Create local config, then add any apex or subdomain mailbox domain:

```bash
cp config/domains.example.json config/domains.json
cp wrangler.example.jsonc wrangler.jsonc
cloud-mail config set --api-host mail.example.com --worker-name cloud-mail-intake
cloud-mail config add --domain mailbox.example.com --zone example.com
cloud-mail config add --domain example.net --zone example.net
cloud-mail config add-forward --domain example.com --zone example.com --destination you@gmail.com
cloud-mail config show
```

This writes `config/domains.json`:

```json
{
  "api_host": "mail.example.com",
  "worker_name": "cloud-mail-intake",
  "database_name": "cloud-mail-intake",
  "database_id": "",
  "domains": [
    {
      "domain": "mailbox.example.com",
      "zone": "example.com",
      "enabled": true,
      "configure_dns": true
    }
  ],
  "forwards": [
    {
      "domain": "example.com",
      "zone": "example.com",
      "destination": "you@gmail.com",
      "enabled": true,
      "configure_dns": true
    }
  ]
}
```

For additional domains, add another entry. `zone` is the Cloudflare zone that owns the DNS records. If omitted, setup tries to find it by suffix.

Use `forwards` for domains that should keep forwarding to a verified destination address instead of being stored in D1. This is useful when one Cloudflare zone has both an apex domain that should forward to Gmail and a subdomain that should be stored by the Worker.

If the Cloudflare account cannot create more D1 databases, set `database_name` and `database_id` to an existing empty D1 database. Do not delete existing D1 databases from this setup script.

## Deploy

Use Cloudflare credentials that can manage Workers, D1, DNS, and Email Routing for the target zones:

```bash
cloud-mail setup
```

`setup` seeds configured domains directly into D1 before routing setup, so first deploy does not depend on the public API host already resolving.

If you manage Cloudflare credentials through a wrapper, run setup through that wrapper:

```bash
your-cloudflare-env-wrapper cloud-mail setup
```

## Query

The setup script writes the admin token to `.secrets/mail-admin-token.txt` and uploads it as the Worker secret `MAIL_ADMIN_TOKEN`.

```bash
cloud-mail domains list
cloud-mail forwards list
cloud-mail messages --email test@mailbox.example.com
cloud-mail latest-code --email test@mailbox.example.com
cloud-mail latest-link --email test@mailbox.example.com
cloud-mail clear --email test@mailbox.example.com
```

Raw Worker API access is also available:

```bash
cloud-mail api GET /admin/domains
cloud-mail api GET /admin/forwards
cloud-mail api POST /admin/domains --json '{"domain":"x.example.com","zone":"example.com","enabled":true}'
cloud-mail api POST /admin/forwards --json '{"domain":"example.com","zone":"example.com","destination":"you@gmail.com","enabled":true}'
```

## Agent Skill

This repo includes a generic Codex skill template at `skills/cloud-mail-intake/SKILL.md`. Local operators can copy/adapt it into `$CODEX_HOME/skills/cloud-mail-intake/SKILL.md` or their personal skills directory and set the repo path/API host for their machine.

## Notes

- This project only receives and stores mail. It does not send mail.
- Unknown recipient domains are rejected by the Worker.
- Catch-all routing is configured per Cloudflare zone, then the Worker allowlist decides which full domains are accepted.
