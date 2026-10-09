import { test } from "node:test";
import assert from "node:assert/strict";
import { createInbox, InboxError, readInbox, waitForEmail } from "../src/lib/inboxes.ts";
import { addTenant, fakeEnv } from "./fixtures.ts";

const noWait = { now: () => Date.now(), sleep: async () => {} };

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => err instanceof InboxError && err.code === code);
}

test("createInbox: random address on an enabled domain, claimed by the tenant", async () => {
  const { env } = fakeEnv();
  const { tenant } = await addTenant(env, "alice");
  for (let i = 0; i < 20; i += 1) {
    const inbox = await createInbox(env, tenant);
    assert.match(inbox.email, /^[a-z][a-z0-9]{11}@[ab]\.example\.com$/);
    assert.ok(!Number.isNaN(Date.parse(inbox.created_at)));
  }
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM inboxes WHERE tenant_id = ?1").bind(tenant.id).first<{ n: number }>();
  assert.equal(row?.n, 20);
});

test("createInbox: a domain scope limits new addresses, and covers subdomains", async () => {
  const { env } = fakeEnv({
    domains: [
      { domain: "zone.test", enabled: true },
      { domain: "x.zone.test", enabled: true },
      { domain: "other.test", enabled: true },
    ],
  });
  const { tenant } = await addTenant(env, "scoped", ["zone.test"]);
  const seen = new Set<string>();
  for (let i = 0; i < 40; i += 1) seen.add((await createInbox(env, tenant)).email.split("@")[1]);
  assert.deepEqual([...seen].sort(), ["x.zone.test", "zone.test"]);

  const { tenant: nowhere } = await addTenant(env, "nowhere", ["unrelated.test"]);
  await rejects(createInbox(env, nowhere), "no_domains_available");
});

test("createInbox: chosen names are first come, first served, per domain", async () => {
  const { env } = fakeEnv();
  const { tenant: alice } = await addTenant(env, "alice");
  const { tenant: bob } = await addTenant(env, "bob");

  const first = await createInbox(env, alice, "GitHub-CI");
  assert.match(first.email, /^github-ci@[ab]\.example\.com$/);
  const second = await createInbox(env, bob, "github-ci");
  assert.notEqual(second.email, first.email);
  // Both enabled domains are now taken; the disabled one never counts.
  await rejects(createInbox(env, alice, "github-ci"), "name_taken");
});

test("createInbox: reserved and malformed names are refused", async () => {
  const { env } = fakeEnv();
  const { tenant } = await addTenant(env, "alice");
  await rejects(createInbox(env, tenant, "Admin"), "name_reserved");
  await rejects(createInbox(env, tenant, "postmaster"), "name_reserved");
  await rejects(createInbox(env, tenant, "-nope"), "invalid_name");
  await rejects(createInbox(env, tenant, "a@b"), "invalid_name");
});

test("createInbox: an address managed in the console is never handed to a tenant", async () => {
  // Domain order is random, so repeat on fresh state to cover both orders.
  for (let i = 0; i < 6; i += 1) {
    const { env, kv } = fakeEnv();
    kv.set("address:support@a.example.com", JSON.stringify({ mailbox: "support@a.example.com", createdAt: "2026-01-01T00:00:00Z" }));
    kv.set("idx:links", JSON.stringify({ l1: { mailbox: "team@b.example.com", createdAt: "2026-01-01T00:00:00Z" } }));
    const { tenant } = await addTenant(env, "alice");
    assert.equal((await createInbox(env, tenant, "support")).email, "support@b.example.com");
    assert.equal((await createInbox(env, tenant, "team")).email, "team@a.example.com");
  }
});

test("waitForEmail: newest undelivered mail, exact time, then only newer mail", async () => {
  const { env, deliver } = fakeEnv();
  const { tenant } = await addTenant(env, "alice");
  const { email } = await createInbox(env, tenant);

  deliver(email, { code: "482913" }, 1000);
  const newest = deliver(email, { code: "730115", subject: "Your code" }, 2000);
  const got = await waitForEmail(env, tenant, email, 0, noWait);
  assert.equal(got.status, "received");
  assert.ok(got.status === "received");
  assert.equal(got.code, "730115");
  assert.equal(got.received_at, newest.received_at);
  assert.equal(got.subject, "Your code");
  assert.equal(typeof got.age_seconds, "number");

  // The older 482913 is never handed out after 730115.
  assert.deepEqual(await waitForEmail(env, tenant, email, 0, noWait), {
    status: "waiting",
    hint: "Nothing new in 0s. Call again with the same email; some senders take a minute.",
  });

  deliver(email, { code: "561204" }, 3000);
  const resend = await waitForEmail(env, tenant, email, 0, noWait);
  assert.ok(resend.status === "received");
  assert.equal(resend.code, "561204");
});

test("waitForEmail: holds the request open until mail lands", async () => {
  const { env, deliver } = fakeEnv();
  const { tenant } = await addTenant(env, "alice");
  const { email } = await createInbox(env, tenant);

  let sleeps = 0;
  const clock = {
    now: () => Date.now() + sleeps * 3000,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) deliver(email, { code: "424242" }, 1000);
    },
  };
  const got = await waitForEmail(env, tenant, email, 45, clock);
  assert.ok(got.status === "received");
  assert.equal(got.code, "424242");
  assert.equal(sleeps, 2);
});

test("ownership: another tenant cannot wait on or read an address", async () => {
  const { env, deliver } = fakeEnv();
  const { tenant: alice } = await addTenant(env, "alice");
  const { tenant: bob } = await addTenant(env, "bob");
  const { email } = await createInbox(env, alice);
  deliver(email, { code: "123456" }, 1000);

  await rejects(waitForEmail(env, bob, email, 0, noWait), "inbox_not_found");
  await rejects(readInbox(env, bob, email), "inbox_not_found");
  await rejects(readInbox(env, alice, "not-an-email"), "invalid_email");
  // An address nobody claimed is just as invisible.
  await rejects(readInbox(env, alice, "someone@a.example.com"), "inbox_not_found");
});

test("mail received before the address was claimed stays invisible", async () => {
  const { env, deliver } = fakeEnv();
  const { tenant } = await addTenant(env, "alice");
  deliver("reset@a.example.com", { code: "618273", subject: "Earlier mail" }, -60_000);
  deliver("reset@b.example.com", { code: "618273", subject: "Earlier mail" }, -60_000);

  const { email } = await createInbox(env, tenant, "reset");
  assert.deepEqual((await readInbox(env, tenant, email)).messages, []);
  assert.equal((await waitForEmail(env, tenant, email, 0, noWait)).status, "waiting");
});

test("readInbox: newest first, capped text, and it never moves the wait cursor", async () => {
  const { env, deliver } = fakeEnv();
  const { tenant } = await addTenant(env, "alice");
  const { email } = await createInbox(env, tenant);
  deliver(email, { code: "482913" }, 1000);
  deliver(email, { link: "https://service.example/verify?t=1", text_body: "x".repeat(5000) }, 2000);

  const { messages } = await readInbox(env, tenant, email, 10);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].link, "https://service.example/verify?t=1");
  assert.equal(messages[0].code, null);
  assert.equal(messages[0].text.length, 4001);
  assert.equal(messages[1].code, "482913");

  // Reading did not consume anything: wait still hands out the newest.
  const got = await waitForEmail(env, tenant, email, 0, noWait);
  assert.ok(got.status === "received");
  assert.equal(got.link, "https://service.example/verify?t=1");
});
