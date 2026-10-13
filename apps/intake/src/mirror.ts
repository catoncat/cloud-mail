// The mirror of the latest code and link per recipient.
//
// Why: the client reads a login code with GET /admin/latest-code, and that call
// used to answer only from D1. Once the account's daily row-read limit is out the
// database answers 500 for every read until midnight UTC, which took the mail —
// and with it every unattended sign-in that depends on a code — down for hours.
// KV is counted against its own quota, so the newest code is also kept there and
// answers when the database cannot.
//
// Only mail that carries a code or a link is mirrored: KV's free tier allows
// 1,000 writes a day, and most of what arrives is not a login.

export interface Held {
  received_at: string;
  subject?: string;
  code?: string;
  link?: string;
}

export const mirrorKey = (email: string) => `latest:${email}`;

/**
 * Keep this mail as the recipient's latest code/link, for as long as the caller's
 * own retention says (ttlSeconds). Nothing to keep: no write.
 */
export async function rememberLatest(
  kv: KVNamespace | undefined,
  email: string,
  held: Held,
  ttlSeconds: number,
): Promise<void> {
  if (!kv || (!held.code && !held.link)) return;
  await kv.put(mirrorKey(email), JSON.stringify(held), { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) });
}

/** What was mirrored for this recipient, or null when nothing was. */
export async function readLatest(kv: KVNamespace | undefined, email: string): Promise<Held | null> {
  if (!kv) return null; // no binding: the mirror simply has nothing to say
  const raw = await kv.get(mirrorKey(email));
  if (!raw) return null;
  try {
    const held = JSON.parse(raw) as Held;
    return held && typeof held.received_at === "string" ? held : null;
  } catch {
    return null;
  }
}

export interface Answer {
  body: Record<string, unknown>;
  status: number;
}

/**
 * The answer to give when the database could not be read. Same shape as the one
 * the database gives, so a caller needs no special case; the item says it came
 * from the mirror. A field that was never mirrored is not answered with an empty
 * string — callers cannot tell that from a real empty code — but with 503.
 */
export function answerFromMirror(email: string, field: "code" | "link", held: Held | null): Answer {
  const value = held?.[field];
  if (!held || !value) {
    return { body: { ok: false, error: `${field}_unavailable`, item: null, [field]: "" }, status: 503 };
  }
  return {
    body: {
      ok: true,
      item: {
        id: "mirror",
        recipient: email,
        subject: held.subject ?? "",
        received_at: held.received_at,
        [field]: value,
      },
      [field]: value,
    },
    status: 200,
  };
}

/** answerFromMirror with the read in front, for the database's error path. */
export async function latestFieldFromMirror(
  kv: KVNamespace | undefined,
  email: string,
  field: "code" | "link",
): Promise<Answer> {
  return answerFromMirror(email, field, await readLatest(kv, email));
}
