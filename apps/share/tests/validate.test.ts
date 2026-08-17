import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMailbox,
  normalizeDomain,
  normalizeLocalPart,
  isValidLinkId,
  createLinkId,
  splitMailboxes,
} from "../src/lib/validate.ts";

test("normalizeMailbox: valid email", () => {
  assert.equal(normalizeMailbox("Test@Example.COM"), "test@example.com");
  assert.equal(normalizeMailbox("  a+b@c.co "), "a+b@c.co");
});

test("normalizeMailbox: invalid returns empty", () => {
  assert.equal(normalizeMailbox("nope"), "");
  assert.equal(normalizeMailbox(""), "");
  assert.equal(normalizeMailbox(null), "");
  assert.equal(normalizeMailbox(undefined), "");
});

test("normalizeDomain: strips @ prefix and lowercases", () => {
  assert.equal(normalizeDomain("@Example.COM"), "example.com");
  assert.equal(normalizeDomain("sub.EXAMPLE.org"), "sub.example.org");
});

test("normalizeDomain: rejects invalid", () => {
  assert.equal(normalizeDomain("nope"), "");
  assert.equal(normalizeDomain(""), "");
  assert.equal(normalizeDomain("a"), "");
});

test("normalizeLocalPart: valid", () => {
  assert.equal(normalizeLocalPart("hello"), "hello");
  assert.equal(normalizeLocalPart("a.b-c_d"), "a.b-c_d");
});

test("normalizeLocalPart: rejects invalid", () => {
  assert.equal(normalizeLocalPart(".starts-dot"), "");
  assert.equal(normalizeLocalPart("A".repeat(50)), "");
  assert.equal(normalizeLocalPart(""), "");
});

test("isValidLinkId: accepts and rejects correctly", () => {
  assert.equal(isValidLinkId("abcdefghijkl"), true);
  assert.equal(isValidLinkId("short"), false);
  assert.equal(isValidLinkId("a".repeat(100)), false);
  assert.equal(isValidLinkId("has spaces!!"), false);
});

test("createLinkId: produces valid link ids", () => {
  const id = createLinkId();
  assert.equal(isValidLinkId(id), true, `Generated id ${id} should be valid`);
  assert.notEqual(createLinkId(), createLinkId());
});

test("splitMailboxes: string splitting", () => {
  assert.deepEqual(splitMailboxes("a@b.com, c@d.com"), ["a@b.com", "c@d.com"]);
  assert.deepEqual(splitMailboxes("a@b.com;c@d.com"), ["a@b.com", "c@d.com"]);
  assert.deepEqual(splitMailboxes("  "), []);
});

test("splitMailboxes: array pass-through", () => {
  assert.deepEqual(splitMailboxes(["a@b.com", " c@d.com "]), ["a@b.com", "c@d.com"]);
});
