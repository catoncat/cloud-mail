import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api.ts";
import { fakeEnv } from "./fixtures.ts";

const auth = { authorization: "Bearer op-key" };

function intakeLimit(calls: string[]): string | null {
  const call = calls.find((c) => c.startsWith("/admin/messages"));
  assert.ok(call, "expected a /admin/messages call");
  return new URL(call, "https://intake.test").searchParams.get("limit");
}

test("messages feed: asks intake for the rows this page needs, not MAX_LIMIT", async () => {
  const { env, deliver, calls } = fakeEnv();
  deliver("a@a.example.com", { code: "123456" }, -1_000);

  const res = await api.request("/messages?mailbox=a%40a.example.com&size=25", { headers: auth }, env);
  assert.equal(res.status, 200);
  // 100 rows per poll is what a 3s panel used to cost; a 25-row page costs 25.
  assert.equal(intakeLimit(calls), "25");

  calls.length = 0;
  await api.request("/messages?mailbox=a%40a.example.com&page=2&size=25", { headers: auth }, env);
  assert.equal(intakeLimit(calls), "50");
});

test("messages feed: never asks for more than intake's hard cap", async () => {
  const { env, deliver, calls } = fakeEnv();
  deliver("a@a.example.com", { code: "123456" });

  await api.request("/messages?mailbox=a%40a.example.com&page=9&size=100", { headers: auth }, env);
  assert.equal(intakeLimit(calls), "100");
});
