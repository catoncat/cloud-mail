/** Polling and random-address helpers behind the agent surfaces (/mcp, /api/v1). */

/**
 * Longest a wait is held open. MCP clients time tool calls out on their own
 * (Codex defaults to 60 s), so stay under that and let the agent call again.
 */
export const MAX_WAIT_SECONDS = 45;
export const POLL_MS = 3000;

export function isFresh(receivedAt: string | undefined, since: number | null): boolean {
  return since === null || Date.parse(receivedAt ?? "") >= since;
}

/**
 * Ask until a fresh item shows up or the wait runs out.
 *
 * Holding the request server-side saves agents from writing a sleep loop.
 */
export async function pollFresh<T extends { received_at?: string }>(
  fetchOnce: () => Promise<T | null>,
  {
    since,
    waitMs,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    intervalMs = POLL_MS,
  }: { since: number | null; waitMs: number; now?: () => number; sleep?: (ms: number) => Promise<void>; intervalMs?: number },
): Promise<T | null> {
  const deadline = now() + waitMs;
  for (;;) {
    const item = await fetchOnce();
    if (item && isFresh(item.received_at, since)) return item;
    const left = deadline - now();
    if (left <= 0) return null;
    await sleep(Math.min(intervalMs, left));
  }
}

const LETTERS = "abcdefghijkmnpqrstuvwxyz";
const ALPHABET = `${LETTERS}23456789`;

/** Catch-all routing accepts any local part; start with a letter to satisfy picky signup forms. */
export function randomLocalPart(randomInt: (n: number) => number): string {
  let local = LETTERS[randomInt(LETTERS.length)];
  for (let i = 0; i < 11; i += 1) local += ALPHABET[randomInt(ALPHABET.length)];
  return local;
}

/** Uniform integer in [0, n) from the platform CSPRNG. */
export function secureRandomInt(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}
