#!/usr/bin/env bash
set -euo pipefail

mailbox="${1:-}"
if [[ -z "$mailbox" ]]; then
  echo "Usage: $0 name@domain.tld" >&2
  echo "  Creates a public ?mail= whitelist entry (any intake domain)." >&2
  echo "For resale/share links that hide the admin origin, prefer:" >&2
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
credentials_file="${CLOUD_MAIL_SHARE_CREDENTIALS:-$script_dir/../.secrets/share-admin.credentials}"

if [[ ! -f "$credentials_file" ]]; then
  echo "Missing credentials file: $credentials_file" >&2
  echo "Set CLOUD_MAIL_SHARE_CREDENTIALS to override." >&2
  exit 1
fi

admin_key="$(sed -n 's/^CLOUD_MAIL_SHARE_ADMIN_KEY=//p' "$credentials_file")"

if [[ -z "$admin_key" ]]; then
  echo "Missing CLOUD_MAIL_SHARE_ADMIN_KEY in $credentials_file" >&2
  exit 1
fi

origin="${CLOUD_MAIL_SHARE_ORIGIN:-$(sed -n 's/^CLOUD_MAIL_SHARE_ORIGIN=//p' "$credentials_file")}"

if [[ -z "$origin" ]]; then
  echo "Missing share origin. Set CLOUD_MAIL_SHARE_ORIGIN or add it to $credentials_file" >&2
  exit 1
fi
origin="${origin%/}"
if [[ "$mode" == "link" ]]; then
  curl -fsS -X POST "$origin/admin/api/links" \
    -H "Authorization: Bearer ${admin_key}" \
    -H "content-type: application/json" \
    --data "{\"mailbox\":\"${mailbox}\"}"
else
  curl -fsS -X POST "$origin/admin/api/mailboxes" \
    -H "Authorization: Bearer ${admin_key}" \
    -H "content-type: application/json" \
    --data "{\"mailbox\":\"${mailbox}\"}"
fi
echo
