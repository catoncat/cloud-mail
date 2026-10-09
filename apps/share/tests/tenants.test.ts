import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.ts";
import { inScope, parseScope } from "../src/lib/tenants.ts";
import type { Env } from "../src/lib/types.ts";
import { fakeEnv } from "./fixtures.ts";

const operator = { authorization: "Bearer op-key", "content-type": "application/json" };

function admin(env: Env, method: string, path: string, body?: unknown) {
  return app.request(
    `https://inbox.example.com/admin/api${path}`,
    { method, headers: operator, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
}

/** Status of a tools/list call: 200 when the token is accepted, 401 when not. */
const mcpStatus = async (env: Env, token: string) =>
  (
    await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      },
      env,
    )
  ).status;

test("parseScope and inScope: absent or all means every domain; a zone covers its subdomains", () => {
  assert.deepEqual(parseScope(undefined), { ok: true, scope: null });
  assert.deepEqual(parseScope("all"), { ok: true, scope: null });
  assert.deepEqual(parseScope([]), { ok: true, scope: null });
  assert.deepEqual(parseScope("b.example.com, A.example.com"), { ok: true, scope: ["a.example.com", "b.example.com"] });
  assert.deepEqual(parseScope(["ok.example.com", "not a domain"]), { ok: false, invalid: ["not a domain"] });

  assert.equal(inScope("x.zone.test", ["zone.test"]), true);
  assert.equal(inScope("zone.test", ["zone.test"]), true);
  assert.equal(inScope("notzone.test", ["zone.test"]), false);
  assert.equal(inScope("anything.test", null), true);
});

test("tenant routes need the operator key", async () => {
  const { env } = fakeEnv();
  const res = await app.request("/admin/api/tenants", { method: "POST", body: "{}" }, env);
  assert.equal(res.status, 401);
});

test("create shows the token once, with ready-to-paste client setup", async () => {
  const { env } = fakeEnv();
  const res = await admin(env, "POST", "/tenants", { name: "MBP-Claude" });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    name: string;
    token: string;
    domains: null;
    mcp_url: string;
    connect: { claude_code: string; pi: string; codex_config_toml: string; cursor: unknown; http: string };
  };
  assert.equal(body.name, "mbp-claude");
  assert.match(body.token, /^cm_[A-Za-z0-9_-]{43}$/);
  assert.equal(body.domains, null);
  assert.equal(body.mcp_url, "https://inbox.example.com/mcp");
  assert.ok(body.connect.claude_code.includes(`Bearer ${body.token}`));
  assert.ok(body.connect.pi.includes(`--header "Authorization=Bearer ${body.token}"`));
  assert.match(body.connect.codex_config_toml, /^\[mcp_servers\.cloud-mail\]\nurl = "https:\/\/inbox\.example\.com\/mcp"\nhttp_headers = \{ Authorization = "Bearer cm_/);
  assert.equal(await mcpStatus(env, body.token), 200);

  // Only the hash is stored.
  const row = await env.DB.prepare("SELECT token_hash FROM tenants WHERE name = 'mbp-claude'").first<{ token_hash: string }>();
  assert.match(row!.token_hash, /^[0-9a-f]{64}$/);

  const again = await admin(env, "POST", "/tenants", { name: "mbp-claude" });
  assert.equal(again.status, 409);
  assert.match(((await again.json()) as { hint: string }).hint, /cloud-mail tenants rotate --name mbp-claude/);

  assert.equal((await admin(env, "POST", "/tenants", { name: "x" })).status, 400);
});

test("domain scope: validated against configured domains, then changeable", async () => {
  const { env } = fakeEnv();
  const typo = await admin(env, "POST", "/tenants", { name: "friend", domains: "exmaple.com" });
  assert.equal(typo.status, 400);
  assert.equal(((await typo.json()) as { error: string }).error, "unknown_domains");

  const created = await admin(env, "POST", "/tenants", { name: "friend", domains: ["b.example.com"] });
  assert.deepEqual(((await created.json()) as { domains: string[] }).domains, ["b.example.com"]);

  const widened = await admin(env, "POST", "/tenants/friend/domains", { domains: "example.com" });
  assert.deepEqual(await widened.json(), { name: "friend", domains: ["example.com"] });
  const all = await admin(env, "POST", "/tenants/friend/domains", { domains: "all" });
  assert.deepEqual(await all.json(), { name: "friend", domains: null });
  assert.equal((await admin(env, "POST", "/tenants/nobody/domains", { domains: "all" })).status, 404);
});

test("rotate replaces the token; disable stops it; rotate enables again", async () => {
  const { env } = fakeEnv();
  const { token: first } = (await (await admin(env, "POST", "/tenants", { name: "alice" })).json()) as { token: string };

  const rotated = (await (await admin(env, "POST", "/tenants/alice/rotate")).json()) as { token: string; mcp_url: string };
  assert.notEqual(rotated.token, first);
  assert.equal(await mcpStatus(env, first), 401);
  assert.equal(await mcpStatus(env, rotated.token), 200);

  const disabled = await admin(env, "POST", "/tenants/alice/disable");
  assert.equal(disabled.status, 200);
  assert.equal(await mcpStatus(env, rotated.token), 401);

  const back = (await (await admin(env, "POST", "/tenants/alice/rotate")).json()) as { token: string };
  assert.equal(await mcpStatus(env, back.token), 200);
  assert.equal((await admin(env, "POST", "/tenants/nobody/disable")).status, 404);
});

test("list shows each tenant's scope, state and address count", async () => {
  const { env } = fakeEnv();
  const { token } = (await (await admin(env, "POST", "/tenants", { name: "alice" })).json()) as { token: string };
  await admin(env, "POST", "/tenants", { name: "friend", domains: "a.example.com" });
  await app.request("/api/v1/inboxes", { method: "POST", headers: { authorization: `Bearer ${token}` } }, env);

  const { tenants } = (await (await admin(env, "GET", "/tenants")).json()) as {
    tenants: Array<{ name: string; domains: string[] | null; inboxes: number; disabled_at: string | null }>;
  };
  assert.deepEqual(
    tenants.map((t) => [t.name, t.domains, t.inboxes, t.disabled_at]),
    [
      ["alice", null, 1, null],
      ["friend", ["a.example.com"], 0, null],
    ],
  );
});
