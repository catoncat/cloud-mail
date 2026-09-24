/**
 * Code and link extraction.
 *
 * Only ever run these against decoded message bodies (text/plain, or HTML that
 * has been through stripHtml). Never against the raw MIME source: it carries
 * tracking ids, quoted-printable soft breaks, and xmlns URLs that look exactly
 * like codes and links.
 *
 * When nothing trustworthy is found these return "". Callers must treat that as
 * "this message has no code" rather than substituting a guess — a wrong code is
 * worse than no code, because the user cannot tell it is wrong.
 */

/** Subjects that announce an event rather than carrying a credential. */
const NOTIFICATION_SUBJECT =
  /已在新设备|新设备上登录|登录提醒|安全提醒|新裝置|新設備|登入提醒|new (?:device|sign[- ]?in)|signed in|security alert|password (?:was )?changed|nouveau (?:périphérique|appareil)|nueva sesión|neues Gerät|新しいデバイス|새\s*기기|새\s*로그인/iu;

/** Namespace and schema URLs only ever appear in markup, never as a destination. */
const BOGUS_LINK = /\b(?:w3\.org|schemas?[-.]|purl\.org|\.dtd\b|\.xsd\b)/iu;

/**
 * A URL truncated by a quoted-printable soft line break, e.g. `http://www.=`.
 * A real URL never ends at `=` immediately after a host or path separator.
 */
const SOFT_BREAK_TRUNCATED = /[./=]=$|^https?:\/\/[^/]*=$/u;

/** Repeated digits and CSS greys: #333333, 000000, 111111 ... */
const NOISE_TOKEN = /^(?:(\d)\1{3,}|([0-9a-f])\2{5}|000000|ffffff|333333|666666|999999|cccccc|eeeeee)$/iu;

function isNoise(token: string): boolean {
  if (!token) return true;
  if (NOISE_TOKEN.test(token)) return true;
  // A run of one repeated character is never a real code.
  return /^(.)\1+$/u.test(token);
}

/**
 * Extract a one-time code.
 *
 * Case is preserved verbatim: providers such as Notion issue case-sensitive
 * codes, so upper-casing them produces a code the user cannot actually use.
 */
export function extractCode(body: string, subject = ""): string {
  if (NOTIFICATION_SUBJECT.test(subject)) return "";

  const text = normalizeWhitespace(body);
  if (!text) return "";

  // A bare token alone on the first line is the most common shape.
  const firstLine = body.split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (/^[A-Za-z0-9]{4,10}$/u.test(firstLine) && !isNoise(firstLine)) return firstLine;

  const labelled = [
    // English labels
    /(?:verification|security|login|sign[-\s]?in|one[-\s]?time|confirmation|auth(?:orization)?|signup|access)\s+code\s*(?:is|:|：|=|-)?\s*([A-Za-z0-9]{4,10})\b/u,
    /\bcode\s*(?:is|:|：|=)\s*([A-Za-z0-9]{4,10})\b/u,
    // Chinese (simplified)
    /(?:验证码|验证代码|安全码|登录代码|确认代码|注册码|一次性代码)[^A-Za-z0-9]{0,20}([A-Za-z0-9]{4,10})\b/u,
    // Chinese (traditional)
    /(?:驗證碼|驗證代碼|安全碼|登入代碼|確認代碼|註冊碼|一次性代碼)[^A-Za-z0-9]{0,20}([A-Za-z0-9]{4,10})\b/u,
    // Japanese
    /(?:認証コード|確認コード|ログインコード|セキュリティコード|ワンタイムコード|検証コード)[^A-Za-z0-9]{0,20}([A-Za-z0-9]{4,10})\b/u,
    // Korean
    /(?:인증\s*코드|인증\s*번호|확인\s*코드|보안\s*코드|로그인\s*코드|일회용\s*코드)[^A-Za-z0-9]{0,20}([A-Za-z0-9]{4,10})\b/u,
    // French
    /(?:code\s+de\s+v[ée]rification|code\s+de\s+confirmation|code\s+de\s+s[ée]curit[ée]|code\s+d['']acc[eè]s)\s*(?:est|:|\s)\s*([A-Za-z0-9]{4,10})\b/iu,
    // Spanish / Portuguese
    /(?:c[oó]digo\s+de\s+verificaci[oó]n|c[oó]digo\s+de\s+confirmaci[oó]n|c[oó]digo\s+de\s+seguridad|c[oó]digo\s+de\s+acesso|c[oó]digo\s+de\s+verifica[çc][ãa]o)\s*(?:es|[eé]|:|\s)\s*([A-Za-z0-9]{4,10})\b/iu,
    // German
    /(?:Best[äa]tigungscode|Sicherheitscode|Verifizierungscode|Anmeldecode|Zugangscode)\s*(?:lautet|ist|:|\s)\s*([A-Za-z0-9]{4,10})\b/iu,
    // Russian
    /(?:код\s+подтверждения|код\s+верификации|код\s+безопасности|код\s+входа|одноразовый\s+код)[^A-Za-z0-9]{0,20}([A-Za-z0-9]{4,10})\b/iu,
  ];

  for (const pattern of labelled) {
    const candidate = pattern.exec(text)?.[1] ?? "";
    if (candidate && !isNoise(candidate)) return candidate;
  }

  // Codes are often written with a separator: 123-456 or ABC-DEF.
  const dashed = /(?<![A-Za-z0-9])([A-Za-z0-9]{3,4}-[A-Za-z0-9]{3,4})(?![A-Za-z0-9])/u.exec(text);
  if (dashed && !isNoise(dashed[1].replace("-", ""))) return dashed[1];

  // Last resort: a standalone 6-8 digit run. Deliberately not 4-5 digits, which
  // collide with years, prices, and street numbers.
  const numeric = /(?<![A-Za-z0-9])(\d{6,8})(?![A-Za-z0-9])/u.exec(text);
  if (numeric && !isNoise(numeric[1])) return numeric[1];

  return "";
}

/**
 * Extract the actionable link (magic link, confirmation link).
 *
 * `html` is optional and only used to read href attributes when the visible
 * text does not spell the URL out.
 */
export function extractLink(body: string, html = ""): string {
  const fromText = Array.from(
    normalizeWhitespace(body).matchAll(/https?:\/\/[^\s"'<>）)\]]+/giu),
    (m) => m[0],
  );
  const fromHref = Array.from(
    html.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/giu),
    (m) => m[1],
  );

  const candidates = [...fromText, ...fromHref]
    .map(decodeEntities)
    .map((url) => url.replace(/[.,;:!?]+$/u, ""))
    .filter(
      (url) => url.length > 12 && !BOGUS_LINK.test(url) && !SOFT_BREAK_TRUNCATED.test(url),
    );

  if (candidates.length === 0) return "";

  // Prefer links that look like an auth action over footers and unsubscribes.
  const meaningful = candidates.find((url) =>
    /magic|verify|verification|confirm|activate|login|sign[-_]?in|auth|token|invite|reset/iu.test(url),
  );
  const notBoilerplate = candidates.find(
    (url) => !/unsubscribe|privacy|terms|help|support|preferences|\.(?:png|jpg|gif|css)$/iu.test(url),
  );
  return meaningful ?? notBoilerplate ?? candidates[0];
}

/** HTML to readable text. Drops anything the reader would never see. */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      // Comments hide tracking ids and mso conditionals that look like codes.
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/giu, " ")
      // Inline styles carry colour values such as #333333.
      .replace(/\s(?:style|bgcolor|color|width|height)\s*=\s*"[^"]*"/giu, " ")
      .replace(/\s(?:style|bgcolor|color|width|height)\s*=\s*'[^']*'/giu, " ")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/(?:p|div|tr|td|h[1-6]|li)>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/[ \t\u00a0]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/^[ \t]+/gmu, "")
    .trim();
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#0?39;|&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_, n: string) => safeCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/giu, (_, n: string) => safeCharCode(Number.parseInt(n, 16)));
}

function safeCharCode(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/gu, " ").trim();
}
