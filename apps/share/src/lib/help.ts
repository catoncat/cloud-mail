import { DEFAULT_READ, MAX_READ, MAX_TEXT } from "./inboxes";
import { MAX_WAIT_SECONDS, POLL_MS } from "./receive";

/**
 * Usage for GET /api/v1/help, written for an agent that has only a URL and a token.
 *
 * It is public, so it must never contain a key. Examples use the caller's own
 * origin so they paste and run as-is.
 */
export function automationHelp(origin: string): string {
  const base = `${origin}/api/v1`;
  return `# Cloud Mail

Receive-only email on the operator's domains: make an address, sign up with it,
then read the verification code, magic link or full mail that arrives there.

Auth: \`Authorization: Bearer $CLOUD_MAIL_TOKEN\` (a \`cm_\` token from the operator).
Keep it in an environment variable. Never print it, log it, or put it in a URL.

## With an MCP client (preferred)

Streamable HTTP endpoint: \`${origin}/mcp\`, same bearer token. Tools:
\`create_inbox\`, \`wait_for_email\`, \`read_inbox\`. The server instructions explain the flow.

\`\`\`bash
claude mcp add --transport http --scope user cloud-mail ${origin}/mcp --header "Authorization: Bearer $CLOUD_MAIL_TOKEN"
\`\`\`

## Over plain HTTP

\`\`\`bash
auth="Authorization: Bearer $CLOUD_MAIL_TOKEN"
email=$(curl -s -X POST -H "$auth" ${base}/inboxes | jq -r .email)
# ... submit "$email" in the signup or login form ...
curl -s -X POST -H "$auth" "${base}/inboxes/$email/wait"
\`\`\`

Received:

\`\`\`json
{"status":"received","id":"…","from":"no-reply@example.com","subject":"Your code","received_at":"2026-01-02T03:04:05.678Z","age_seconds":4,"code":"123456","link":null,"text":"…"}
\`\`\`

Nothing new within the wait (HTTP 200): call again.

\`\`\`json
{"status":"waiting","hint":"Nothing new in ${MAX_WAIT_SECONDS}s. Call again with the same email; some senders take a minute."}
\`\`\`

- Each wait returns the newest mail you have not been given yet, so a resend is just another wait.
- If \`received_at\` is earlier than when you triggered the email, it is an older mail: wait again.
- The address is yours permanently: log in with it again months later and wait the same way.
- You only see mail that arrived after you created the address.

## Endpoints

| Method and path | Parameters | Returns |
| --- | --- | --- |
| \`GET /help\` | none, no auth | this page |
| \`POST /inboxes\` | JSON body, optional: \`{"name":"github-ci"}\` (1-40 of a-z 0-9 . _ -) | \`{email, created_at}\` (201) |
| \`POST /inboxes/{email}/wait\` | \`timeout\` (0-${MAX_WAIT_SECONDS} s, default ${MAX_WAIT_SECONDS}) | \`{status:"received", …mail}\` or \`{status:"waiting", hint}\` |
| \`GET /inboxes/{email}/messages\` | \`limit\` (1-${MAX_READ}, default ${DEFAULT_READ}) | \`{messages[]}\`, newest first; does not affect wait |

A mail has \`id\`, \`from\`, \`subject\`, \`received_at\`, \`age_seconds\`, \`code\`, \`link\` and \`text\`
(cut at ${MAX_TEXT} characters). \`code\` and \`link\` are null when none was found: read \`text\`.
\`wait\` holds the request open, checking every ${POLL_MS / 1000} s. If your HTTP client has a timeout, make it longer.

## Errors

Every error body is \`{error, hint}\`; do what \`hint\` says.

| HTTP | error | Do |
| --- | --- | --- |
| 400 | \`invalid_name\`, \`invalid_email\` | fix the input; retrying unchanged fails again |
| 401 | \`unauthorized\` | the token is missing, wrong or disabled; ask the operator, do not guess |
| 404 | \`inbox_not_found\` | you did not create this address; call \`POST /inboxes\` |
| 409 | \`name_taken\`, \`name_reserved\` | pick another name, or omit it for a random address |
| 502 | \`intake_unavailable\` | the mail backend is down; retry in a minute, then report it |
| 503 | \`no_domains_available\` | no domain is enabled for this token; ask the operator |
`;
}
