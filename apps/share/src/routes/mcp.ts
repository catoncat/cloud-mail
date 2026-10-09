import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import * as z from "zod";
import { requireTenant, type TenantVars } from "../lib/auth";
import { createInbox, DEFAULT_READ, InboxError, MAX_READ, readInbox, waitForEmail } from "../lib/inboxes";
import { IntakeError } from "../lib/intake";
import { MAX_WAIT_SECONDS } from "../lib/receive";
import type { Env, Tenant } from "../lib/types";

/** Read by clients that surface server instructions (Claude Code puts them in the system prompt). */
const INSTRUCTIONS = `Receive-only email for signups and logins on the operator's domains.

1. create_inbox gives you an address that stays yours permanently, so you can log in with it again later.
2. Enter it on the site and trigger the email (sign up, send code, reset password).
3. wait_for_email(email) returns the newest mail you have not been given yet, with code, link, text and its exact received_at.
   If received_at is earlier than when you triggered the email, it is an older mail: call wait_for_email again.
   status "waiting" means nothing new arrived yet: call again.

read_inbox(email) lists recent mail without changing what wait_for_email returns next.
You can only read addresses you created, and only mail that arrived after you created them.`;

/** The agent surface over MCP: three tools, one tenant token, no session state. */
export const mcp = new Hono<{ Bindings: Env; Variables: TenantVars }>();

mcp.use("*", requireTenant("Send Authorization: Bearer <cm_ token>. The operator issues one with: cloud-mail tenants create --name <name>"));

// The SDK wants a fresh server per request; building it here binds the tools to this tenant.
mcp.all("/", (c) => createMcpHandler(() => buildServer(c.env, c.get("tenant"))).fetch(c.req.raw));

export function buildServer(env: Env, tenant: Tenant): McpServer {
  const server = new McpServer({ name: "cloud-mail", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "create_inbox",
    {
      title: "Create inbox",
      description:
        "Create a receive-only email address for a signup or login. It stays yours permanently. Returns {email, created_at}.",
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe("Optional local part such as github-ci: 1-40 of a-z 0-9 . _ -. Omit it for a random address."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ name }) => answer(() => createInbox(env, tenant, name)),
  );

  server.registerTool(
    "wait_for_email",
    {
      title: "Wait for email",
      description:
        "Wait for the newest email at this address that you have not been given yet. " +
        'Returns {status:"received", code, link, subject, from, received_at, age_seconds, text}, ' +
        'or {status:"waiting"} when nothing new arrived before the timeout. ' +
        "Each call only returns mail newer than the last one it returned.",
      inputSchema: z.object({
        email: z.string().describe("An address you created with create_inbox."),
        timeout_seconds: z
          .number()
          .optional()
          .describe(`Seconds to wait for new mail, 0-${MAX_WAIT_SECONDS}. Default ${MAX_WAIT_SECONDS}.`),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ email, timeout_seconds }) => answer(() => waitForEmail(env, tenant, email, timeout_seconds)),
  );

  server.registerTool(
    "read_inbox",
    {
      title: "Read inbox",
      description:
        "List recent mail at an address you created, newest first, without changing what wait_for_email returns next. " +
        "Use it to re-read a mail, or to see one that wait_for_email skipped over.",
      inputSchema: z.object({
        email: z.string().describe("An address you created with create_inbox."),
        limit: z.number().optional().describe(`How many mails, 1-${MAX_READ}. Default ${DEFAULT_READ}.`),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ email, limit }) => answer(() => readInbox(env, tenant, email, limit)),
  );

  return server;
}

/** Rejections come back as tool errors with a hint the agent can act on, not as protocol errors. */
async function answer(run: () => Promise<object>): Promise<CallToolResult> {
  try {
    return result(await run());
  } catch (err) {
    if (err instanceof InboxError) return result({ error: err.code, hint: err.hint }, true);
    if (err instanceof IntakeError) {
      return result({ error: "intake_unavailable", hint: "The mail backend did not answer. Retry in a minute, then tell the operator." }, true);
    }
    throw err;
  }
}

function result(value: object, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}
