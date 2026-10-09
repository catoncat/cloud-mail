import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.ts";
import type { Env } from "../src/lib/types.ts";
import { addTenant, fakeEnv } from "./fixtures.ts";

type RpcMessage = { result?: Record<string, unknown> & { structuredContent?: Record<string, unknown>; isError?: boolean }; error?: unknown };

let nextId = 1;

/** One JSON-RPC call to /mcp, the way a 2025-era client sends it (no session; JSON or SSE answer). */
async function rpc(env: Env, token: string, method: string, params: Record<string, unknown> = {}): Promise<RpcMessage> {
  const res = await app.request(
    "https://inbox.example.com/mcp",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    },
    env,
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  const data = text.includes("data:") ? text.split("\n").find((line) => line.startsWith("data:"))!.slice(5) : text;
  return JSON.parse(data);
}

async function call(env: Env, token: string, name: string, args: Record<string, unknown> = {}) {
  const message = await rpc(env, token, "tools/call", { name, arguments: args });
  assert.ok(message.result, JSON.stringify(message));
  return message.result;
}

test("/mcp needs a tenant token, and the 401 says where one comes from", async () => {
  const { env } = fakeEnv();
  const res = await app.request("/mcp", { method: "POST", body: "{}" }, env);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
  const body = (await res.json()) as { error: string; hint: string };
  assert.equal(body.error, "unauthorized");
  assert.match(body.hint, /cloud-mail tenants create/);

  // The operator key is a different surface.
  const operator = await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer op-key" } }, env);
  assert.equal(operator.status, 401);
});

test("initialize and tools/list: three tools and instructions that explain the flow", async () => {
  const { env } = fakeEnv();
  const { token } = await addTenant(env, "alice");

  const init = await rpc(env, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal((init.result?.serverInfo as { name: string }).name, "cloud-mail");
  assert.match(String(init.result?.instructions), /wait_for_email/);

  const list = await rpc(env, token, "tools/list");
  const tools = (list.result?.tools as Array<{ name: string }>).map((t) => t.name).sort();
  assert.deepEqual(tools, ["create_inbox", "read_inbox", "wait_for_email"]);
});

test("create_inbox → wait_for_email → read_inbox over MCP", async () => {
  const { env, deliver } = fakeEnv();
  const { token } = await addTenant(env, "alice");

  const created = await call(env, token, "create_inbox", { name: "signup-test" });
  const email = String(created.structuredContent?.email);
  assert.match(email, /^signup-test@[ab]\.example\.com$/);

  const waiting = await call(env, token, "wait_for_email", { email, timeout_seconds: 0 });
  assert.equal(waiting.structuredContent?.status, "waiting");

  deliver(email, { code: "482913", subject: "Your code" }, 1000);
  const received = await call(env, token, "wait_for_email", { email, timeout_seconds: 0 });
  assert.equal(received.isError, undefined);
  assert.equal(received.structuredContent?.status, "received");
  assert.equal(received.structuredContent?.code, "482913");
  assert.equal(typeof received.structuredContent?.received_at, "string");
  // The same answer as text, for clients that ignore structuredContent.
  assert.equal(JSON.parse((received.content as Array<{ text: string }>)[0].text).code, "482913");

  const read = await call(env, token, "read_inbox", { email });
  assert.equal((read.structuredContent?.messages as unknown[]).length, 1);
});

test("rejections are tool errors with a hint, not protocol errors", async () => {
  const { env } = fakeEnv();
  const { token: alice } = await addTenant(env, "alice");
  const { token: bob } = await addTenant(env, "bob");

  const created = await call(env, alice, "create_inbox");
  const stolen = await call(env, bob, "wait_for_email", { email: created.structuredContent?.email, timeout_seconds: 0 });
  assert.equal(stolen.isError, true);
  assert.equal(stolen.structuredContent?.error, "inbox_not_found");
  assert.match(String(stolen.structuredContent?.hint), /create_inbox/);

  const reserved = await call(env, alice, "create_inbox", { name: "admin" });
  assert.equal(reserved.isError, true);
  assert.equal(reserved.structuredContent?.error, "name_reserved");
});

test("an intake outage is a tool error the agent can report", async () => {
  const { env } = fakeEnv({ intakeDown: true });
  const { token } = await addTenant(env, "alice");
  const result = await call(env, token, "create_inbox");
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error, "intake_unavailable");
});
