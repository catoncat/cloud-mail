// The regression this guards: /admin/latest-code answered only from D1, so when
// the database was out of daily row-read quota every read answered 500 and no
// unattended sign-in could get its code for hours.

import test from "node:test";
import assert from "node:assert/strict";

import { answerFromMirror, latestFieldFromMirror, mirrorKey, readLatest, rememberLatest } from "../src/mirror.ts";

function fakeKv() {
  const store = new Map<string, string>();
  const written: string[] = [];
  return {
    store,
    written,
    kv: {
      async put(key: string, value: string) { store.set(key, value); written.push(key); },
      async get(key: string) { return store.get(key) ?? null; },
    } as unknown as KVNamespace,
  };
}

const mail = { received_at: "2026-10-12T02:30:00.000Z", subject: "Your code", code: "424242" };

test("a code that arrives is readable back", async () => {
  const { kv } = fakeKv();
  await rememberLatest(kv, "a@b.c", mail, 6 * 3600);
  assert.deepEqual(await readLatest(kv, "a@b.c"), mail);
});

test("mail with neither code nor link costs no write", async () => {
  const { kv, written, store } = fakeKv();
  await rememberLatest(kv, "a@b.c", { received_at: mail.received_at, subject: "newsletter" }, 6 * 3600);
  assert.equal(store.size, 0);
  assert.deepEqual(written, []);
});

test("each recipient has its own slot", async () => {
  const { kv } = fakeKv();
  await rememberLatest(kv, "a@b.c", mail, 6 * 3600);
  await rememberLatest(kv, "d@e.f", { received_at: mail.received_at, code: "999999" }, 6 * 3600);
  assert.equal((await readLatest(kv, "a@b.c"))?.code, "424242");
  assert.equal((await readLatest(kv, "d@e.f"))?.code, "999999");
});

test("a later mail replaces the earlier one", async () => {
  const { kv } = fakeKv();
  await rememberLatest(kv, "a@b.c", mail, 6 * 3600);
  await rememberLatest(kv, "a@b.c", { received_at: "2026-10-12T03:00:00.000Z", code: "515151" }, 6 * 3600);
  assert.equal((await readLatest(kv, "a@b.c"))?.code, "515151");
});

test("the database being unreadable still yields the mirrored code", async () => {
  const { kv } = fakeKv();
  await rememberLatest(kv, "a@b.c", mail, 6 * 3600);
  const answer = await latestFieldFromMirror(kv, "a@b.c", "code");
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  // the client reads item.received_at to tell a fresh code from an old one
  assert.equal((answer.body.item as Record<string, unknown>).received_at, mail.received_at);
  assert.equal(answer.body.code, "424242");
});

test("nothing mirrored is not answered as an empty code", async () => {
  const { kv } = fakeKv();
  const answer = await latestFieldFromMirror(kv, "a@b.c", "code");
  assert.equal(answer.status, 503);
  assert.equal(answer.body.ok, false);
  assert.equal(answer.body.error, "code_unavailable");
});

test("a field this mail never had is not answered at all", async () => {
  const { kv } = fakeKv();
  await rememberLatest(kv, "a@b.c", mail, 6 * 3600); // a code, no link
  assert.equal((await latestFieldFromMirror(kv, "a@b.c", "link")).status, 503);
  assert.equal((await latestFieldFromMirror(kv, "a@b.c", "code")).status, 200);
});

test("a deployment without the binding writes nothing and answers 503", async () => {
  // The binding lives in wrangler.jsonc, which is not in git: a fresh deployment
  // must degrade to "no mirror", never to a crash.
  await rememberLatest(undefined, "a@b.c", mail, 6 * 3600);
  assert.equal((await latestFieldFromMirror(undefined, "a@b.c", "code")).status, 503);
  assert.equal(await readLatest(undefined, "a@b.c"), null);
});

test("unreadable mirror contents are treated as nothing", async () => {
  const { kv, store } = fakeKv();
  store.set(mirrorKey("a@b.c"), "{not json");
  assert.equal(await readLatest(kv, "a@b.c"), null);
  assert.equal(answerFromMirror("a@b.c", "code", null).status, 503);
});
