import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteMailboxMessages,
  forwardToIntake,
  guessService,
  IntakeError,
  listDomains,
  messagesByMailbox,
  toLatest,
  upsertIntakeDomain,
} from "../src/lib/intake.ts";
import type { Env, IntakeMessage } from "../src/lib/types.ts";

test("toLatest: extracts code and link from intake message", () => {
  const msg: IntakeMessage = {
    id: "abc",
    recipient: "u@x.com",
    sender: "noreply@x.com",
    subject: "Login",
    received_at: "2026-01-01T00:00:00Z",
    text_body: "Your code is 123456",
    html_body: "",
    code: "123456",
    link: "https://x.com/verify?t=abc",
  };
  const result = toLatest(msg, "u@x.com");
  assert.equal(result.code, "123456");
  assert.equal(result.link, "https://x.com/verify?t=abc");
  assert.equal(result.from, "noreply@x.com");
  assert.equal(result.to, "u@x.com");
});

test("toLatest: strips legacy noise codes", () => {
  const msg: IntakeMessage = {
    id: "1",
    recipient: "u@x.com",
    sender: "",
    subject: "",
    received_at: "",
    text_body: "",
    html_body: "",
    code: "333333",
    link: "",
  };
  const result = toLatest(msg, "u@x.com");
  assert.equal(result.code, undefined);
});

test("toLatest: strips legacy bogus links", () => {
  const msg: IntakeMessage = {
    id: "2",
    recipient: "u@x.com",
    sender: "",
    subject: "",
    received_at: "",
    text_body: "",
    html_body: "",
    code: "",
    link: "http://www.w3.org/1999/xhtml",
  };
  const result = toLatest(msg, "u@x.com");
  assert.equal(result.link, undefined);
});

test("toLatest: falls back to stripped HTML when text_body is empty", () => {
  const msg: IntakeMessage = {
    id: "3",
    recipient: "u@x.com",
    sender: "",
    subject: "",
    received_at: "",
    text_body: "",
    html_body: "<p>Hello <b>world</b></p>",
    code: "",
    link: "",
  };
  const result = toLatest(msg, "u@x.com");
  assert.match(result.text, /Hello\s+world/);
});

test("toLatest: valid short code passes through", () => {
  const msg: IntakeMessage = {
    id: "4",
    recipient: "u@x.com",
    sender: "",
    subject: "",
    received_at: "",
    text_body: "",
    html_body: "",
    code: "Ab3-Xz",
    link: "",
  };
  const result = toLatest(msg, "u@x.com");
  assert.equal(result.code, "Ab3-Xz");
});

test("guessService: detects known services", () => {
  assert.equal(guessService("noreply@notion.so", ""), "Notion");
  assert.equal(guessService("", "Your GitHub login code"), "GitHub");
  assert.equal(guessService("team@openai.com", ""), "OpenAI");
  assert.equal(guessService("team@anthropic.com", ""), "Claude");
  assert.equal(guessService("", ""), null);
});

test("guessService: x.ai detection", () => {
  assert.equal(guessService("noreply@x.ai", ""), "Grok");
  assert.equal(guessService("", "Grok verification"), "Grok");
});

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** Stand-in for the INTAKE Service Binding that records every request. */
function fakeIntake(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const INTAKE = {
    async fetch(input: string, init: RequestInit = {}) {
      const raw = init.body;
      const body = raw == null ? "" : typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      const call = {
        url: String(input),
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body,
      };
      calls.push(call);
      return respond(call);
    },
  };
  return { env: { INTAKE } as unknown as Env, calls };
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("listDomains: reads through the binding", async () => {
  const { env, calls } = fakeIntake(() => jsonResponse({ ok: true, items: [{ domain: "A.example.com", enabled: 1 }] }));
  assert.deepEqual(await listDomains(env), [{ domain: "a.example.com", enabled: true }]);
  assert.equal(new URL(calls[0].url).pathname, "/admin/domains");
  assert.equal(calls[0].headers.authorization, undefined);
});

test("intake failures throw instead of looking like an empty mailbox", async () => {
  const down = fakeIntake(() => jsonResponse({ ok: false, error: "internal_error" }, 500));
  await assert.rejects(messagesByMailbox(down.env, "u@x.com"), (err: unknown) => {
    assert.ok(err instanceof IntakeError);
    assert.equal(err.status, 500);
    assert.equal(err.code, "internal_error");
    return true;
  });

  const garbage = fakeIntake(() => new Response("upstream exploded", { status: 200 }));
  await assert.rejects(listDomains(garbage.env), IntakeError);
});

test("deleteMailboxMessages and upsertIntakeDomain send the right requests", async () => {
  const { env, calls } = fakeIntake((call) => jsonResponse(call.method === "DELETE" ? { ok: true, changes: 3 } : { ok: true }));
  assert.equal(await deleteMailboxMessages(env, "u@x.com"), 3);
  await upsertIntakeDomain(env, "m.example.com", "example.com");

  assert.equal(calls[0].method, "DELETE");
  assert.equal(new URL(calls[0].url).searchParams.get("email"), "u@x.com");
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), { domain: "m.example.com", zone: "example.com", enabled: true });
});

test("forwardToIntake: relays path, query, body and status verbatim", async () => {
  const { env, calls } = fakeIntake((call) =>
    new URL(call.url).pathname === "/admin/latest-code"
      ? jsonResponse({ ok: false, error: "no_code_found", item: null, code: "" }, 404)
      : jsonResponse({ ok: true, echoed: call.body }),
  );

  const miss = await forwardToIntake(
    env,
    new Request("https://inbox.example.com/admin/api/intake/admin/latest-code?email=u%40x.com", {
      headers: { authorization: "Bearer operator-key" },
    }),
    "/admin/latest-code",
  );
  assert.equal(miss.status, 404);
  assert.deepEqual(await miss.json(), { ok: false, error: "no_code_found", item: null, code: "" });
  assert.equal(new URL(calls[0].url).searchParams.get("email"), "u@x.com");
  // The operator key stops at share.
  assert.equal(calls[0].headers.authorization, undefined);

  const post = await forwardToIntake(
    env,
    new Request("https://inbox.example.com/admin/api/intake/admin/domains", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "m.example.com" }),
    }),
    "/admin/domains",
  );
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(await post.json(), { ok: true, echoed: JSON.stringify({ domain: "m.example.com" }) });
});
