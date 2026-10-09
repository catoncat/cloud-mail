import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.ts";
import { addTenant, fakeEnv } from "./fixtures.ts";

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("help is public, markdown, uses the caller's origin, and holds no key", async () => {
  const { env } = fakeEnv();
  const { token } = await addTenant(env, "alice");
  for (const path of ["/api/v1", "/api/v1/help"]) {
    const res = await app.request(`https://inbox.example.com${path}`, {}, env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    const text = await res.text();
    assert.ok(text.includes("https://inbox.example.com/mcp"));
    assert.ok(text.includes("https://inbox.example.com/api/v1/inboxes"));
    for (const endpoint of ["POST /inboxes", "/wait", "/messages"]) assert.ok(text.includes(endpoint), endpoint);
    assert.ok(!text.includes(token) && !text.includes("op-key"));
  }
});

test("every other endpoint needs a tenant token, and 401 points at help", async () => {
  const { env } = fakeEnv();
  const res = await app.request("/api/v1/inboxes", { method: "POST" }, env);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized", hint: "Send Authorization: Bearer <cm_ token>. Usage: GET /api/v1/help" });
  const operator = await app.request("/api/v1/inboxes", { method: "POST", headers: bearer("op-key") }, env);
  assert.equal(operator.status, 401);
});

test("POST /inboxes, then wait, then read: the same rules as MCP", async () => {
  const { env, deliver } = fakeEnv();
  const { token } = await addTenant(env, "alice");

  const created = await app.request("/api/v1/inboxes", { method: "POST", headers: bearer(token) }, env);
  assert.equal(created.status, 201);
  const { email } = (await created.json()) as { email: string };
  assert.match(email, /^[a-z][a-z0-9]{11}@[ab]\.example\.com$/);

  const waiting = await app.request(`/api/v1/inboxes/${email}/wait?timeout=0`, { method: "POST", headers: bearer(token) }, env);
  assert.equal(((await waiting.json()) as { status: string }).status, "waiting");

  deliver(email, { code: "482913" }, 1000);
  const received = await app.request(`/api/v1/inboxes/${encodeURIComponent(email)}/wait?timeout=0`, { method: "POST", headers: bearer(token) }, env);
  const body = (await received.json()) as { status: string; code: string };
  assert.deepEqual([body.status, body.code], ["received", "482913"]);

  const read = await app.request(`/api/v1/inboxes/${email}/messages?limit=5`, { headers: bearer(token) }, env);
  assert.equal(((await read.json()) as { messages: unknown[] }).messages.length, 1);
});

test("errors are {error, hint} with the right status", async () => {
  const { env } = fakeEnv();
  const { token: alice } = await addTenant(env, "alice");
  const { token: bob } = await addTenant(env, "bob");
  const json = { ...bearer(alice), "content-type": "application/json" };

  const named = await app.request("/api/v1/inboxes", { method: "POST", headers: json, body: JSON.stringify({ name: "admin" }) }, env);
  assert.equal(named.status, 409);
  assert.equal(((await named.json()) as { error: string }).error, "name_reserved");

  const bad = await app.request("/api/v1/inboxes", { method: "POST", headers: json, body: JSON.stringify({ name: "no spaces" }) }, env);
  assert.equal(bad.status, 400);

  const { email } = (await (await app.request("/api/v1/inboxes", { method: "POST", headers: bearer(alice) }, env)).json()) as { email: string };
  const other = await app.request(`/api/v1/inboxes/${email}/messages`, { headers: bearer(bob) }, env);
  assert.equal(other.status, 404);
  const body = (await other.json()) as { error: string; hint: string };
  assert.equal(body.error, "inbox_not_found");
  assert.ok(body.hint);
});

test("the old receive endpoints are gone and say where to look", async () => {
  const { env } = fakeEnv();
  const { token } = await addTenant(env, "alice");
  for (const path of ["/api/v1/code?email=a@a.example.com", "/api/v1/addresses", "/api/v1/domains"]) {
    const res = await app.request(path, { headers: bearer(token) }, env);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: "not_found", hint: "GET /api/v1/help lists the endpoints" });
  }
});

test("intake outage is a 502, never an empty answer", async () => {
  const { env } = fakeEnv({ intakeDown: true });
  const { token } = await addTenant(env, "alice");
  const res = await app.request("/api/v1/inboxes", { method: "POST", headers: bearer(token) }, env);
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { error: string }).error, "intake_unavailable");
});
