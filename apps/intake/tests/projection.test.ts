import { test } from "node:test";
import assert from "node:assert/strict";
import { LISTING_BODY_BYTES, listingProjection } from "../src/projection.ts";

/**
 * These assertions exist because the bound below was removed twice by "just select
 * the row", and each time the listing went back to 1.5-2.4 MB of JSON per poll, over
 * the free plan's 10ms CPU budget, and every miss got killed before it could cache
 * itself. A listing that carries whole bodies is a production incident, not a style
 * preference.
 */
test("listingProjection: bodies are capped, not selected whole", () => {
  const sql = listingProjection();
  assert.match(sql, new RegExp(`substr\\(text_body, 1, ${LISTING_BODY_BYTES}\\)`));
  assert.match(sql, new RegExp(`substr\\(html_body, 1, ${LISTING_BODY_BYTES}\\)`));
  // A bare column would mean the whole body travels again.
  const bare = sql.split(",").map((c) => c.trim());
  assert.ok(!bare.includes("text_body"), "text_body must not be selected whole");
  assert.ok(!bare.includes("html_body"), "html_body must not be selected whole");
});

test("listingProjection: the HTML part only rides along when there is no text part", () => {
  const sql = listingProjection();
  assert.match(sql, /CASE WHEN trim\(text_body\) = '' THEN substr\(html_body/);
});

test("listingProjection: raw source is never part of a listing", () => {
  const sql = listingProjection();
  const bare = sql.split(",").map((c) => c.trim());
  assert.ok(!bare.includes("raw"), "raw is up to 1 MB per message");
  assert.ok(!sql.includes("headers_json"));
});

test("listingProjection: a shortened body is flagged so the UI can say so", () => {
  assert.match(listingProjection(), /AS body_truncated/);
});
