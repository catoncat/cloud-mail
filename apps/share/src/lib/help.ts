import { MAX_MESSAGES, MAX_WAIT_SECONDS, POLL_MS } from "./receive";

/**
 * Usage for GET /api/v1/help, written for an agent that has only a URL and a token.
 *
 * It is public, so it must never contain a key. Examples use the caller's own
 * origin so they paste and run as-is.
 */
export function automationHelp(origin: string): string {
  const base = `${origin}/api/v1`;
  return `# Cloud Mail API

Receive-only email on the operator's domains: make an address, read the
verification code, magic link, or full mail that arrives there. No SDK, just HTTP.

Base URL: ${base}
Auth: every endpoint except this page needs \`Authorization: Bearer $CLOUD_MAIL_TOKEN\`.
Keep the token in an environment variable. Never print it, log it, or put it in a URL.

## Receive a verification code

\`\`\`bash
auth="Authorization: Bearer $CLOUD_MAIL_TOKEN"
email=$(curl -s -X POST -H "$auth" ${base}/addresses | jq -r .email)
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)     # take it BEFORE the mail is triggered
# ... submit "$email" in the signup or login form ...
curl -s -H "$auth" "${base}/code?email=$email&since=$since&wait=${MAX_WAIT_SECONDS}"
\`\`\`

Found:

\`\`\`json
{"ok":true,"code":"123456","item":{"id":"…","recipient":"…","subject":"…","received_at":"2026-01-02T03:04:05.678Z","code":"123456"}}
\`\`\`

Nothing yet (HTTP 200). Call again with the same \`since\`:

\`\`\`json
{"ok":false,"error":"no_code_found","item":null,"code":""}
\`\`\`

- Always pass \`since\`. Without it, an older code already in the mailbox is returned at once.
- To resend: take a new \`since\`, trigger the resend, then call again.
- Magic links work the same way: \`/link\` puts the URL in \`.link\`.
- Any local part at an enabled domain receives mail, so there is nothing to register first.
- If your HTTP client has a timeout, make it longer than \`wait\`.

## Endpoints

| Method and path | Parameters | Returns |
| --- | --- | --- |
| \`GET /help\` | none, no auth | this page |
| \`POST /addresses\` | JSON body, optional: \`{"domain":"D"}\` | \`{ok, email, domain}\` |
| \`GET /code\` | \`email\`, \`since\`, \`wait\` (0-${MAX_WAIT_SECONDS} s, default 0) | \`{ok, code, item}\` |
| \`GET /link\` | \`email\`, \`since\`, \`wait\` | \`{ok, link, item}\` |
| \`GET /messages\` | \`email\`, \`since\`, \`limit\` (1-${MAX_MESSAGES}, default 10) | \`{ok, items[]}\`, newest first |
| \`GET /domains\` | none | \`{domains[]}\`, the domains that receive mail |

\`since\` is ISO 8601 (\`2026-01-02T03:04:05Z\`) or a window back from now (\`90s\`, \`10m\`, \`2h\`).
\`wait\` holds the request open, checking every ${POLL_MS / 1000} s, until a fresh match arrives.
Each item in \`/messages\` has \`sender\`, \`subject\`, \`received_at\`, \`text_body\`, \`html_body\`, \`code\`, \`link\`.
Read \`text_body\` when a mail arrived but \`code\` is empty.

## Responses

| HTTP | Body | Do |
| --- | --- | --- |
| 200 | \`ok: true\` | use the answer |
| 200 | \`ok: false\`, \`no_code_found\` / \`no_link_found\` | nothing fresh yet: call again with the same \`since\` |
| 400 | \`error\` + \`hint\` | fix the request as \`hint\` says; retrying unchanged fails again |
| 401 | \`unauthorized\` | the token is missing or wrong; ask the operator, do not guess |
| 502 | \`intake_unavailable\` | the mail backend is down; retry in a minute, then report it |

This token can create addresses and read their mail. It cannot delete mail,
change domains, or reach the operator console.
`;
}
