import { test } from "node:test";
import assert from "node:assert/strict";
import { toLatest, guessService } from "../src/lib/intake.ts";
import type { IntakeMessage } from "../src/lib/types.ts";

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
