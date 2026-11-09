import { test } from "node:test";
import assert from "node:assert/strict";
import { mailboxStats } from "../src/lib/aggregate.ts";
import { fakeEnv } from "./fixtures.ts";

test("mailboxStats: reads the per-recipient aggregate, never a page of messages", async () => {
  const { env, deliver, calls } = fakeEnv();
  deliver("a@a.example.com", { code: "123456", subject: "Login" }, -60_000);
  deliver("a@a.example.com", { subject: "Later" }, -1_000);
  deliver("b@a.example.com", { subject: "Other" }, -2_000);
  deliver("c@b.example.com", { subject: "Elsewhere" }, -3_000);

  const stats = await mailboxStats(env, "a.example.com", "https://inbox.test");

  assert.deepEqual(stats.map((s) => s.mailbox), ["a@a.example.com", "b@a.example.com"]);
  assert.equal(stats[0].messages, 2);
  assert.equal(stats[0].lastCode, "123456");
  assert.equal(stats[0].localPart, "a");
  // The old path pulled whole messages (bodies included) to count them by hand.
  assert.ok(calls.some((c) => c.startsWith("/admin/mailboxes")));
  assert.ok(!calls.some((c) => c.startsWith("/admin/messages")));
});
