import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { bearerToken, requireSecret, secretMatches } from "../src/lib/auth.ts";
import type { Env } from "../src/lib/types.ts";

function appFor(name: "OPERATOR_KEY" | "AUTOMATION_TOKEN") {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", requireSecret(name));
  app.get("/", (c) => c.text("ok"));
  return app;
}

const env = (values: Partial<Env>) => values as Env;

test("secretMatches: equal, different, different length", async () => {
  assert.equal(await secretMatches("abc", "abc"), true);
  assert.equal(await secretMatches("abd", "abc"), false);
  assert.equal(await secretMatches("abcd", "abc"), false);
  assert.equal(await secretMatches("", "abc"), false);
});

test("bearerToken: only the Bearer scheme counts", () => {
  assert.equal(bearerToken("Bearer k1"), "k1");
  assert.equal(bearerToken("bearer   k1 "), "k1");
  assert.equal(bearerToken("Basic k1"), "");
  assert.equal(bearerToken(undefined), "");
});

test("requireSecret: 503 when the secret is unset", async () => {
  const res = await appFor("OPERATOR_KEY").request("/", { headers: { authorization: "Bearer x" } }, env({}));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "operator_key_not_configured" });
});

test("requireSecret: accepts the right key, rejects everything else", async () => {
  const app = appFor("OPERATOR_KEY");
  const bindings = env({ OPERATOR_KEY: "op-key" });
  assert.equal((await app.request("/", { headers: { authorization: "Bearer op-key" } }, bindings)).status, 200);
  assert.equal((await app.request("/", { headers: { authorization: "Bearer nope" } }, bindings)).status, 401);
  assert.equal((await app.request("/", {}, bindings)).status, 401);
  // Legacy custom headers are gone.
  assert.equal((await app.request("/", { headers: { "x-admin-key": "op-key" } }, bindings)).status, 401);
});

test("requireSecret: no fallback between the two secrets", async () => {
  const bindings = env({ OPERATOR_KEY: "op-key", AUTOMATION_TOKEN: "auto-token" });
  const res = await appFor("AUTOMATION_TOKEN").request("/", { headers: { authorization: "Bearer op-key" } }, bindings);
  assert.equal(res.status, 401);
});
