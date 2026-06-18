export function extractCode(input: string): string {
  const text = normalizeText(input);
  const labelled = [
    /(?:verification\s+code|security\s+code|login\s+code|sign[-\s]?in\s+code|one[-\s]?time\s+code|confirmation\s+code|auth\s+code|\bcode\b)\s*(?:is|:|：|=|-)?\s*([A-Z0-9]{4,10})/iu,
    /(?:验证码|验证代码|安全码|登录代码|确认代码|一次性代码)[^\dA-Z]{0,20}([A-Z0-9]{4,10})/iu,
  ];

  for (const pattern of labelled) {
    const match = text.match(pattern);
    const candidate = cleanCode(match?.[1] ?? "");
    if (candidate) return candidate;
  }

  const numeric = text.match(/\b\d{6,8}\b/u);
  return numeric?.[0] ?? "";
}

export function extractLink(input: string): string {
  const text = normalizeText(input);
  const links = Array.from(text.matchAll(/https?:\/\/[^\s"'<>）)]+/giu), (match) =>
    match[0].replace(/[.,;:!?]+$/u, ""),
  );
  const preferred = links.find((link) => /openai|chatgpt|auth/i.test(link));
  return preferred ?? links[0] ?? "";
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#39;/gu, "'")
    .replace(/&quot;/giu, '"');
}

function normalizeText(input: string): string {
  return input.replace(/\s+/gu, " ").trim();
}

function cleanCode(input: string): string {
  const code = input.trim().replace(/[^A-Z0-9]/giu, "").toUpperCase();
  if (code.length < 4 || code.length > 10) return "";
  return code;
}
