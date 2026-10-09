import { type Context, Hono } from "hono";
import { requireTenant, type TenantVars } from "../lib/auth";
import { automationHelp } from "../lib/help";
import { createInbox, readInbox, waitForEmail } from "../lib/inboxes";
import type { Env } from "../lib/types";

/**
 * Plain-HTTP twin of /mcp for agents and scripts without an MCP client.
 * Same tenant token, same rules, same answers; errors are mapped in index.ts.
 */
export const service = new Hono<{ Bindings: Env; Variables: TenantVars }>();

/** Body parsing must never throw; fields are validated downstream. */
async function body<T extends object>(c: { req: { json: <U>() => Promise<U> } }): Promise<Partial<T>> {
  try {
    return await c.req.json<Partial<T>>();
  } catch {
    return {};
  }
}

/** Public on purpose: an agent handed only the URL must be able to learn the API. */
const help = (c: Context<{ Bindings: Env; Variables: TenantVars }>) =>
  c.body(automationHelp(new URL(c.req.url).origin), 200, { "content-type": "text/markdown; charset=utf-8" });
service.get("/", help);
service.get("/help", help);

service.use("*", requireTenant("Send Authorization: Bearer <cm_ token>. Usage: GET /api/v1/help"));

service.post("/inboxes", async (c) => {
  const input = await body<{ name: string }>(c);
  return c.json(await createInbox(c.env, c.get("tenant"), input.name), 201);
});

/** POST because answering moves the inbox past the mail it hands out. */
service.post("/inboxes/:email/wait", async (c) =>
  c.json(await waitForEmail(c.env, c.get("tenant"), c.req.param("email"), c.req.query("timeout"))),
);

service.get("/inboxes/:email/messages", async (c) =>
  c.json(await readInbox(c.env, c.get("tenant"), c.req.param("email"), c.req.query("limit"))),
);
