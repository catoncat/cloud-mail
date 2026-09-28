import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WAIT_SECONDS,
  domainNotAvailable,
  parseLatestQuery,
  parseMessagesQuery,
  parseSince,
  pickAddress,
  pollFresh,
  randomLocalPart,
  secureRandomInt,
} from "../src/lib/receive.ts";

const NOW = Date.parse("2026-01-02T03:04:05Z");

test("parseSince: absent, ISO, window, invalid", () => {
  assert.equal(parseSince(undefined, NOW), null);
  assert.equal(parseSince("", NOW), null);
  assert.equal(parseSince("2026-01-02T03:00:00Z", NOW), Date.parse("2026-01-02T03:00:00Z"));
  assert.equal(parseSince("90s", NOW), NOW - 90_000);
  assert.equal(parseSince("10m", NOW), NOW - 600_000);
  assert.equal(parseSince("2h", NOW), NOW - 7_200_000);
  assert.deepEqual(parseSince("yesterday", NOW), {
    ok: false,
    error: "invalid_since",
    hint: "since is ISO 8601 (2026-01-02T03:04:05Z) or a window like 10m",
  });
});

test("parseLatestQuery: normalizes email and caps wait", () => {
  assert.deepEqual(parseLatestQuery({ email: " A@Mail.Example.com ", wait: "999" }, NOW), {
    ok: true,
    email: "a@mail.example.com",
    since: null,
    waitMs: MAX_WAIT_SECONDS * 1000,
  });
  const q = parseLatestQuery({ email: "a@mail.example.com", since: "5m" }, NOW);
  assert.equal(q.ok && q.waitMs, 0);
  assert.equal(q.ok && q.since, NOW - 300_000);
});

test("parseLatestQuery: each bad field names itself", () => {
  const error = (q: Record<string, string>) => {
    const r = parseLatestQuery(q, NOW);
    return r.ok ? "ok" : r.error;
  };
  assert.equal(error({}), "invalid_email");
  assert.equal(error({ email: "not-an-email" }), "invalid_email");
  assert.equal(error({ email: "a@x.com", since: "soon" }), "invalid_since");
  assert.equal(error({ email: "a@x.com", wait: "-1" }), "invalid_wait");
  assert.equal(error({ email: "a@x.com", wait: "abc" }), "invalid_wait");
});

test("parseMessagesQuery: limit defaults to 10 and is clamped", () => {
  const limit = (value?: string) => {
    const r = parseMessagesQuery({ email: "a@x.com", limit: value }, NOW);
    return r.ok ? r.limit : -1;
  };
  assert.equal(limit(undefined), 10);
  assert.equal(limit("0"), 1);
  assert.equal(limit("500"), 50);
  assert.equal(limit("junk"), 10);
});

test("domainNotAvailable: only enabled domains pass", () => {
  assert.equal(domainNotAvailable("a@mail.example.com", ["mail.example.com"]), null);
  assert.equal(domainNotAvailable("a@typo.example.com", ["mail.example.com"])?.error, "domain_not_available");
});

test("pollFresh: returns at once when fresh, ignores stale, stops at the deadline", async () => {
  let clock = NOW;
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const since = NOW - 1000;

  const fresh = { received_at: new Date(NOW).toISOString() };
  let calls = 0;
  assert.equal(await pollFresh(async () => (calls++, fresh), { since, waitMs: 60_000, now, sleep }), fresh);
  assert.equal(calls, 1);

  const stale = { received_at: new Date(NOW - 60_000).toISOString() };
  calls = 0;
  assert.equal(await pollFresh(async () => (calls++, stale), { since, waitMs: 9000, now, sleep, intervalMs: 3000 }), null);
  assert.equal(calls, 4); // t=0, 3, 6, 9 s

  // Without since, anything stored counts.
  assert.equal(await pollFresh(async () => stale, { since: null, waitMs: 0, now, sleep }), stale);
});

test("pollFresh: picks up an item that lands mid-wait", async () => {
  let clock = NOW;
  const arrival = { received_at: new Date(NOW + 5000).toISOString() };
  const result = await pollFresh(async () => (clock >= NOW + 5000 ? arrival : null), {
    since: NOW,
    waitMs: 30_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result, arrival);
});

test("pickAddress: random enabled domain, or the requested one", () => {
  const first = () => 0;
  assert.deepEqual(pickAddress(["a.example.com", "b.example.com"], undefined, first), {
    ok: true,
    email: "aaaaaaaaaaaa@a.example.com",
    domain: "a.example.com",
  });
  const pinned = pickAddress(["a.example.com", "b.example.com"], "B.example.com", first);
  assert.equal(pinned.ok && pinned.domain, "b.example.com");
  assert.equal((pickAddress(["a.example.com"], "c.example.com", first) as { error: string }).error, "domain_not_available");
  assert.equal((pickAddress([], undefined, first) as { error: string }).error, "no_domains_available");
});

test("randomLocalPart: 12 chars, starts with a letter, no look-alikes", () => {
  for (let i = 0; i < 200; i += 1) {
    const local = randomLocalPart(secureRandomInt);
    assert.match(local, /^[a-km-np-z][a-km-np-z2-9]{11}$/u);
  }
});

test("secureRandomInt: stays in range", () => {
  for (let i = 0; i < 500; i += 1) {
    const n = secureRandomInt(7);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 7);
  }
});
