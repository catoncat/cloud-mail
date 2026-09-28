#!/usr/bin/env bash
set -euo pipefail

mailbox="${1:-}"
if [[ -z "$mailbox" ]]; then
  echo "Usage: $0 name@domain.tld" >&2
  echo "  Creates a public ?mail= whitelist entry (any intake domain)." >&2
  echo "For share links that hide the admin origin, prefer:" >&2
  echo "  $0 --link name@domain.tld" >&2
  exit 2
fi

mode="mailbox"
if [[ "$mailbox" == "--link" ]]; then
  mode="link"
  mailbox="${2:-}"
  if [[ -z "$mailbox" ]]; then
    echo "Usage: $0 --link name@domain.tld" >&2
    exit 2
  fi
fi

if [[ ! "$mailbox" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "Invalid mailbox: $mailbox" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
secrets_file="${CLOUD_MAIL_SECRETS:-$script_dir/../../../.secrets/cloud-mail.env}"

if [[ ! -f "$secrets_file" ]]; then
  echo "Missing secrets file: $secrets_file (run: npm run setup)" >&2
  echo "Set CLOUD_MAIL_SECRETS to override." >&2
  exit 1
fi

operator_key="$(sed -n 's/^OPERATOR_KEY=//p' "$secrets_file")"
origin="$(sed -n 's/^CLOUD_MAIL_ORIGIN=//p' "$secrets_file")"

if [[ -z "$operator_key" || -z "$origin" ]]; then
  echo "OPERATOR_KEY and CLOUD_MAIL_ORIGIN are required in $secrets_file" >&2
  exit 1
fi
origin="${origin%/}"
if [[ "$mode" == "link" ]]; then
  printf 'Authorization: Bearer %s\n' "$operator_key" | curl -fsS -X POST "$origin/admin/api/links" \
    -H @- \
    -H "content-type: application/json" \
    --data "{\"mailbox\":\"${mailbox}\"}"
else
  printf 'Authorization: Bearer %s\n' "$operator_key" | curl -fsS -X POST "$origin/admin/api/mailboxes" \
    -H @- \
    -H "content-type: application/json" \
    --data "{\"mailbox\":\"${mailbox}\"}"
fi
echo
