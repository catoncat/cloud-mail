import { test } from "node:test";
import assert from "node:assert/strict";
import { followUpFor, isRoutingMx, readiness } from "../src/lib/domains.ts";

test("followUpFor: missing token points at the share secret", () => {
  const followUp = followUpFor("mail.example.com", [
    { step: "zone", ok: false, detail: "cloudflare_token_missing" },
    { step: "allowlist", ok: true },
  ]);
  assert.equal(followUp.reason, "cloudflare_token_missing");
  assert.equal(followUp.command, "cd apps/share && npx wrangler secret put CF_API_TOKEN");
  assert.match(followUp.hint, /cloud-mail domains add --domain mail\.example\.com/);
});

test("followUpFor: a refused step says which and reruns the add", () => {
  const followUp = followUpFor("mail.example.com", [
    { step: "zone", ok: true, detail: "example.com" },
    { step: "email_routing_dns", ok: true },
    { step: "catch_all", ok: false, detail: "Authentication error" },
    { step: "allowlist", ok: true },
  ]);
  assert.equal(followUp.reason, "routing_incomplete");
  assert.equal(followUp.command, "cloud-mail domains add --domain mail.example.com");
  assert.match(followUp.hint, /catch_all: Authentication error/);
});

test("followUpFor: refused Email Routing DNS with no MX names the permission", () => {
  const followUp = followUpFor("new.example.com", [
    { step: "zone", ok: true, detail: "example.com" },
    { step: "email_routing_dns", ok: false, detail: "Authentication error" },
    { step: "catch_all", ok: true },
    { step: "mx", ok: false, detail: "no_cloudflare_mx" },
    { step: "allowlist", ok: true },
  ]);
  assert.equal(followUp.reason, "email_routing_dns_failed");
  assert.equal(followUp.command, "cloud-mail domains add --domain new.example.com");
  assert.match(followUp.hint, /Zone Settings Edit/);
});

test("followUpFor: DNS enabled but MX not visible yet means poll the check", () => {
  const followUp = followUpFor("new.example.com", [
    { step: "zone", ok: true, detail: "example.com" },
    { step: "email_routing_dns", ok: true },
    { step: "catch_all", ok: true },
    { step: "mx", ok: false, detail: "no_cloudflare_mx" },
    { step: "allowlist", ok: true },
  ]);
  assert.equal(followUp.reason, "dns_propagating");
  assert.equal(followUp.command, "cloud-mail domains check --domain new.example.com");
});

test("isRoutingMx: matches Cloudflare Email Routing hosts only", () => {
  assert.equal(isRoutingMx("35 route1.mx.cloudflare.net."), true);
  assert.equal(isRoutingMx("48 route2.mx.cloudflare.net"), true);
  assert.equal(isRoutingMx("10 aspmx.l.google.com."), false);
  assert.equal(isRoutingMx("10 mx.cloudflare.net.evil.com."), false);
});

test("readiness: needs routing and an enabled allowlist entry", () => {
  assert.deepEqual(readiness("routed", { enabled: true }), { allowlisted: true, enabled: true, ready: true });
  assert.deepEqual(readiness("routed", { enabled: false }), { allowlisted: true, enabled: false, ready: false });
  assert.deepEqual(readiness("routed", undefined), { allowlisted: false, enabled: false, ready: false });
  assert.deepEqual(readiness("unknown", { enabled: true }), { allowlisted: true, enabled: true, ready: false });
});
