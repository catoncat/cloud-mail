import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteLink,
  getAddress,
  getLink,
  isOperatorMailbox,
  listAddresses,
  listLinks,
  listLinksForMailbox,
  putAddress,
  putLink,
  putMailbox,
  shareUrlByMailbox,
} from "../src/lib/store.ts";
import type { Env } from "../src/lib/types.ts";
import { fakeEnv } from "./fixtures.ts";

test("records live in D1: one upsert is one row, and KV is never written", async () => {
  const { env, kv } = fakeEnv();
  await putAddress(env, { mailbox: "a@x.com", label: "work", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  await putAddress(env, { mailbox: "b@x.com", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" });

  const stored = await getAddress(env, "a@x.com");
  assert.equal(stored?.label, "work");
  // Newest first, and an update replaces rather than appends.
  assert.deepEqual((await listAddresses(env)).map((row) => row.mailbox), ["b@x.com", "a@x.com"]);
  await putAddress(env, { mailbox: "a@x.com", label: "home", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" });
  assert.equal((await listAddresses(env)).length, 2);
  assert.equal((await getAddress(env, "a@x.com"))?.label, "home");

  assert.equal(kv.size, 0, "nothing is written to the legacy KV namespace");
});

test("links: newest first, per-address lookup, and delete", async () => {
  const { env } = fakeEnv();
  await putLink(env, "aaa", { mailbox: "one@x.com", createdAt: "2026-01-01T00:00:00Z" });
  await putLink(env, "bbb", { mailbox: "two@x.com", label: "api", createdAt: "2026-01-02T00:00:00Z" });
  await putLink(env, "ccc", { mailbox: "one@x.com", createdAt: "2026-01-03T00:00:00Z" });

  assert.equal((await getLink(env, "bbb"))?.label, "api");
  assert.deepEqual((await listLinks(env, "https://s.example")).map((link) => link.id), ["ccc", "bbb", "aaa"]);

  const mine = await listLinksForMailbox(env, "https://s.example", "one@x.com");
  assert.deepEqual(mine.map((link) => link.id), ["ccc", "aaa"]);
  assert.equal(mine[0].url, "https://s.example/s/ccc");

  // The newest share wins for the address book.
  assert.equal((await shareUrlByMailbox(env, "https://s.example")).get("one@x.com"), "https://s.example/s/ccc");

  await deleteLink(env, "ccc");
  assert.equal(await getLink(env, "ccc"), null);
  assert.equal((await shareUrlByMailbox(env, "https://s.example")).get("one@x.com"), "https://s.example/s/aaa");
});

test("isOperatorMailbox answers from any of the three tables in one query", async () => {
  const { env } = fakeEnv();
  assert.equal(await isOperatorMailbox(env, "nobody@x.com"), false);
  await putMailbox(env, "open@x.com", { mailbox: "open@x.com", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(await isOperatorMailbox(env, "open@x.com"), true);
  await putLink(env, "ddd", { mailbox: "shared@x.com", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(await isOperatorMailbox(env, "shared@x.com"), true);
});

test("records written before migration 0002 are imported from KV, once", async () => {
  const { env, kv } = fakeEnv();
  kv.set("address:a@x.com", JSON.stringify({ mailbox: "a@x.com", label: "old", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2025-12-01T00:00:00Z" }));
  kv.set("mailbox:b@x.com", JSON.stringify({ mailbox: "b@x.com", createdAt: "2025-12-02T00:00:00Z" }));
  kv.set("link:xyz", JSON.stringify({ mailbox: "b@x.com", label: "old link", createdAt: "2025-12-03T00:00:00Z" }));
  kv.set("link:bad", "not json");
  kv.set("idx:links", JSON.stringify({ xyz: { mailbox: "b@x.com" } }));

  assert.equal((await getAddress(env, "a@x.com"))?.label, "old");
  assert.deepEqual((await listLinks(env, "https://s.example")).map((link) => link.id), ["xyz"]);
  assert.equal(await isOperatorMailbox(env, "b@x.com"), true);

  // The same database, seen by a new worker: the marker stops a second import, so a
  // record added to KV after the upgrade is not picked up.
  kv.set("link:later", JSON.stringify({ mailbox: "c@x.com", createdAt: "2026-01-01T00:00:00Z" }));
  const fresh = { ...env, SHARE_LINKS: kv } as unknown as Env;
  assert.deepEqual((await listLinks(fresh, "https://s.example")).map((link) => link.id), ["xyz"]);
});
