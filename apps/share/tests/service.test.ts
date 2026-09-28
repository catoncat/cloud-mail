import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.ts";
import type { Env } from "../src/lib/types.ts";

const TOKEN = "auto-token";
const auth = { authorization: `Bearer ${TOKEN}` };

/** Fake intake behind the Service Binding: two domains, one of them enabled, one stored code. */
function env(stored: { received_at: string; code: string } | null = null) {
  const calls: string[] = [];
  const INTAKE = {
    async fetch(input: string) {
      const url = new URL(input);
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/admin/domains") {
        return Response.json({
          ok: true,
          items: [
            { domain: "mail.example.com", enabled: 1 },
            { domain: "off.example.com", enabled: 0 },
          ],
        });
      }
      if (url.pathname === "/admin/latest-code") {
        if (!stored) return Response.json({ ok: false, error: "no_code_found", item: null, code: "" }, { status: 404 });
        const item = { id: "m1", recipient: url.searchParams.get("email"), subject: "Your code", ...stored };
        return Response.json({ ok: true, item, code: stored.code });
      }
      if (url.pathname === "/admin/messages") {
        return Response.json({
          ok: true,
          items: [
            { id: "new", received_at: "2026-01-02T03:10:00Z", text_body: "new" },
            { id: "old", received_at: "2026-01-01T00:00:00Z", text_body: "old" },
          ],
        });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  };
  return { bindings: { INTAKE, AUTOMATION_TOKEN: TOKEN, OPERATOR_KEY: "op-key" } as unknown as Env, calls };
}

test("help is public, markdown, uses the caller's origin, and holds no key", async () => {
  const { bindings } = env();
  for (const path of ["/api/v1", "/api/v1/help"]) {
    const res = await app.request(`https://inbox.example.com${path}`, {}, bindings);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    const text = await res.text();
    assert.match(text, /https:\/\/inbox\.example\.com\/api\/v1\/addresses/);
    for (const endpoint of ["/addresses", "/code", "/link", "/messages", "/domains"]) assert.ok(text.includes(endpoint), endpoint);
    assert.ok(!text.includes(TOKEN) && !text.includes("op-key"));
  }
});

test("every other endpoint needs the automation token, and 401 points at help", async () => {
  const { bindings } = env();
  const res = await app.request("/api/v1/code?email=a@mail.example.com", {}, bindings);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized", hint: "Send Authorization: Bearer <token>. Usage: GET /api/v1/help" });
  // The operator key is a different surface.
  const wrong = await app.request("/api/v1/code?email=a@mail.example.com", { headers: { authorization: "Bearer op-key" } }, bindings);
  assert.equal(wrong.status, 401);
});

test("POST /addresses: random local part on an enabled domain", async () => {
  const { bindings } = env();
  const res = await app.request("/api/v1/addresses", { method: "POST", headers: auth }, bindings);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; email: string; domain: string };
  assert.equal(body.ok, true);
  assert.equal(body.domain, "mail.example.com");
  assert.match(body.email, /^[a-z][a-z0-9]{11}@mail\.example\.com$/);

  const disabled = await app.request(
    "/api/v1/addresses",
    { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ domain: "off.example.com" }) },
    bindings,
  );
  assert.equal(disabled.status, 400);
  assert.equal(((await disabled.json()) as { error: string }).error, "domain_not_available");
});

test("GET /code: found, stale with since, and nothing stored all answer 200", async () => {
  const stored = { received_at: "2026-01-02T03:04:05Z", code: "123456" };

  const found = await app.request("/api/v1/code?email=A@mail.example.com", { headers: auth }, env(stored).bindings);
  assert.equal(found.status, 200);
  const body = (await found.json()) as { ok: boolean; code: string; item: { recipient: string } };
  assert.equal(body.ok, true);
  assert.equal(body.code, "123456");
  assert.equal(body.item.recipient, "a@mail.example.com");

  const stale = await app.request("/api/v1/code?email=a@mail.example.com&since=2026-01-02T04:00:00Z", { headers: auth }, env(stored).bindings);
  assert.equal(stale.status, 200);
  assert.deepEqual(await stale.json(), { ok: false, error: "no_code_found", item: null, code: "" });

  const empty = await app.request("/api/v1/code?email=a@mail.example.com", { headers: auth }, env(null).bindings);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { ok: false, error: "no_code_found", item: null, code: "" });
});

test("GET /code: bad input fails fast with a hint and never polls intake", async () => {
  const { bindings, calls } = env();
  const typo = await app.request("/api/v1/code?email=a@typo.example.com&wait=60", { headers: auth }, bindings);
  assert.equal(typo.status, 400);
  const body = (await typo.json()) as { error: string; hint: string };
  assert.equal(body.error, "domain_not_available");
  assert.match(body.hint, /GET \/api\/v1\/domains/);
  assert.ok(!calls.some((c) => c.startsWith("/admin/latest-code")));

  const since = await app.request("/api/v1/code?email=a@mail.example.com&since=soon", { headers: auth }, bindings);
  assert.equal(since.status, 400);
  assert.equal(((await since.json()) as { error: string }).error, "invalid_since");
});

test("GET /messages: one address only, filtered by since", async () => {
  const { bindings, calls } = env();
  const res = await app.request("/api/v1/messages?email=a@mail.example.com&since=2026-01-02T00:00:00Z&limit=5", { headers: auth }, bindings);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; items: Array<{ id: string }> };
  assert.deepEqual(body.items.map((m) => m.id), ["new"]);
  assert.ok(calls.includes("/admin/messages?email=a%40mail.example.com&limit=5"));

  const noEmail = await app.request("/api/v1/messages?domain=mail.example.com", { headers: auth }, bindings);
  assert.equal(noEmail.status, 400);
  assert.equal(((await noEmail.json()) as { error: string }).error, "invalid_email");
});

test("unknown /api/v1 path answers JSON 404 with a pointer to help", async () => {
  const { bindings } = env();
  const res = await app.request("/api/v1/nope", { headers: auth }, bindings);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found", hint: "GET /api/v1/help lists the endpoints" });
});

test("intake outage is a 502, never an empty answer", async () => {
  const bindings = {
    INTAKE: { fetch: async () => new Response("boom", { status: 500 }) },
    AUTOMATION_TOKEN: TOKEN,
  } as unknown as Env;
  const res = await app.request("/api/v1/code?email=a@mail.example.com", { headers: auth }, bindings);
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { error: string }).error, "intake_unavailable");
});
