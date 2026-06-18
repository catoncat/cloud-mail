import test from "node:test";
import assert from "node:assert/strict";

import { extractCode, extractLink, stripHtml } from "../src/extract.ts";

test("extracts labelled numeric code", () => {
  assert.equal(extractCode("Your verification code is 123456."), "123456");
});

test("extracts Chinese labelled code", () => {
  assert.equal(extractCode("验证码：847201，请勿泄露"), "847201");
});

test("prefers OpenAI related links", () => {
  const text = "See https://example.com and verify at https://auth.openai.com/u/abc.";
  assert.equal(extractLink(text), "https://auth.openai.com/u/abc");
});

test("strips simple html", () => {
  assert.match(stripHtml("<p>Hello<br>World</p>"), /Hello\s+World/u);
});
