import test from "node:test";
import assert from "node:assert/strict";

import { extractCode, extractLink, stripHtml } from "../src/extract.ts";

test("extracts labelled numeric code", () => {
  assert.equal(extractCode("Your verification code is 123456."), "123456");
});

test("extracts Chinese labelled code", () => {
  assert.equal(extractCode("验证码：847201，请勿泄露"), "847201");
});

test("extracts a bare code on the first line", () => {
  assert.equal(extractCode("933514\n"), "933514");
});

test("preserves case for case-sensitive codes", () => {
  const body = "GEwWpg\n\nNever share this code with anyone.\n";
  assert.equal(extractCode(body), "GEwWpg");
});

test("extracts dashed codes", () => {
  assert.equal(extractCode("Your login code: ABC-DEF"), "ABC-DEF");
});

test("prefers auth related links", () => {
  const text = "See https://example.org/docs and verify at https://auth.openai.com/u/abc.";
  assert.equal(extractLink(text), "https://auth.openai.com/u/abc");
});

test("reads links from href when the body does not spell them out", () => {
  const html = '<a href="https://claude.ai/magic-link#abc123def456">Sign in</a>';
  assert.equal(extractLink("Sign in to Claude.ai", html), "https://claude.ai/magic-link#abc123def456");
});

test("skips unsubscribe boilerplate", () => {
  const text = "https://mail.example.org/unsubscribe?x=1 then https://app.example.org/confirm/abc123";
  assert.equal(extractLink(text), "https://app.example.org/confirm/abc123");
});

test("strips simple html", () => {
  assert.match(stripHtml("<p>Hello<br>World</p>"), /Hello\s+World/u);
});

// --- regressions: every one of these shipped a wrong answer to a user ---

test("does not mistake a CSS colour for a code", () => {
  const html = '<div style="color: #333333">你的帐号已在新设备上登录</div>';
  assert.equal(extractCode(stripHtml(html)), "");
});

test("does not invent a code for notification mail", () => {
  const body = "有人在新设备上登录了你的帐号 123456";
  assert.equal(extractCode(body, "你的帐号已在新设备上登录"), "");
});

test("does not invent a code for a magic-link mail", () => {
  const body = "Let's get you signed in. Sign in with the secure link below. Sign in to Claude.ai";
  assert.equal(extractCode(body, "Secure link to log in to Claude.ai"), "");
});

test("ignores xmlns urls", () => {
  const body = 'xmlns="http://www.w3.org/1999/xhtml" and https://claude.ai/magic-link#tok123456';
  assert.equal(extractLink(body), "https://claude.ai/magic-link#tok123456");
});

test("ignores quoted-printable soft breaks", () => {
  assert.equal(extractLink("visit http://www.="), "");
});

test("drops html comments that hide tracking ids", () => {
  const html = "<!--[if mso]><td width=\"31859940\"><![endif]--><p>Let's get you signed in</p>";
  const text = stripHtml(html);
  assert.equal(text.includes("31859940"), false);
  assert.equal(extractCode(text), "");
});

test("strips inline style attributes", () => {
  const text = stripHtml('<div style="padding-bottom: 38px; color: #333333">Hi</div>');
  assert.equal(text.includes("333333"), false);
  assert.equal(text, "Hi");
});

test("decodes entities in links", () => {
  const html = '<a href="https://app.example.org/verify?a=1&amp;b=2">Verify</a>';
  assert.equal(extractLink("", html), "https://app.example.org/verify?a=1&b=2");
});

test("returns empty rather than guessing", () => {
  assert.equal(extractCode(""), "");
  assert.equal(extractCode("Thanks for signing up. Welcome aboard!"), "");
  assert.equal(extractLink(""), "");
});

// --- multilingual code extraction ---

test("extracts traditional Chinese labelled code", () => {
  assert.equal(extractCode("您的驗證碼為 482901，請勿洩露給他人"), "482901");
});

test("extracts Japanese labelled code", () => {
  assert.equal(extractCode("認証コード: 738291 を入力してください"), "738291");
});

test("extracts Korean labelled code", () => {
  assert.equal(extractCode("인증 코드: 591047을 입력하세요"), "591047");
});

test("extracts French labelled code", () => {
  assert.equal(extractCode("Votre code de vérification est 294015"), "294015");
});

test("extracts Spanish labelled code", () => {
  assert.equal(extractCode("Tu código de verificación es 847201"), "847201");
});

test("extracts German labelled code", () => {
  assert.equal(extractCode("Ihr Bestätigungscode lautet 583920"), "583920");
});

test("extracts Russian labelled code", () => {
  assert.equal(extractCode("Ваш код подтверждения 629104"), "629104");
});

test("extracts Portuguese labelled code", () => {
  assert.equal(extractCode("Seu código de verificação é 371058"), "371058");
});

test("notification subject blocks code in Japanese", () => {
  assert.equal(extractCode("新しいデバイスからのログイン 123456", "新しいデバイスでログイン"), "");
});

test("notification subject blocks code in Korean", () => {
  assert.equal(extractCode("새 기기에서 로그인됨 654321", "새 기기 로그인"), "");
});
