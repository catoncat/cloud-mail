import { test } from "node:test";
import assert from "node:assert/strict";
import { pollFresh, randomLocalPart, secureRandomInt } from "../src/lib/receive.ts";

const NOW = Date.parse("2026-01-02T03:04:05Z");

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
