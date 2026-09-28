/** Pure helpers behind the receive endpoints of /api/v1. */

import { normalizeDomain, normalizeMailbox } from "./validate";

export type Field = "code" | "link";

/** Rejected input: a stable code plus the literal fix, for agents reading the body. */
export type Invalid = { ok: false; error: string; hint: string };

/** A request longer than this risks proxy timeouts; callers loop instead. */
export const MAX_WAIT_SECONDS = 60;
export const POLL_MS = 3000;
export const MAX_MESSAGES = 50;

const WINDOW_RE = /^(\d+)([smh])$/u;
const WINDOW_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** `since` is ISO 8601 or a window back from now (90s, 10m, 2h). Absent means "any time". */
export function parseSince(value: string | undefined, now: number): number | null | Invalid {
  if (value === undefined || value === "") return null;
  const window = WINDOW_RE.exec(value);
  if (window) return now - Number(window[1]) * WINDOW_MS[window[2]];
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return { ok: false, error: "invalid_since", hint: "since is ISO 8601 (2026-01-02T03:04:05Z) or a window like 10m" };
  }
  return time;
}

function parseEmail(value: string | undefined): string | Invalid {
  const email = normalizeMailbox(value);
  return email || { ok: false, error: "invalid_email", hint: "Pass email=<address>, e.g. from POST /api/v1/addresses" };
}

function isInvalid(value: unknown): value is Invalid {
  return typeof value === "object" && value !== null && (value as Invalid).ok === false;
}

export function parseLatestQuery(
  query: Record<string, string | undefined>,
  now: number,
): { ok: true; email: string; since: number | null; waitMs: number } | Invalid {
  const email = parseEmail(query.email);
  if (isInvalid(email)) return email;
  const since = parseSince(query.since, now);
  if (isInvalid(since)) return since;
  const wait = Number(query.wait ?? 0);
  if (!Number.isFinite(wait) || wait < 0) {
    return { ok: false, error: "invalid_wait", hint: `wait is seconds to hold the request open, 0-${MAX_WAIT_SECONDS}` };
  }
  return { ok: true, email, since, waitMs: Math.min(wait, MAX_WAIT_SECONDS) * 1000 };
}

export function parseMessagesQuery(
  query: Record<string, string | undefined>,
  now: number,
): { ok: true; email: string; since: number | null; limit: number } | Invalid {
  const email = parseEmail(query.email);
  if (isInvalid(email)) return email;
  const since = parseSince(query.since, now);
  if (isInvalid(since)) return since;
  const limit = Math.trunc(Number(query.limit ?? 10));
  return { ok: true, email, since, limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), MAX_MESSAGES) : 10 };
}

/** Mail for a domain that is not enabled is never stored, so waiting on it is pointless. */
export function domainNotAvailable(email: string, enabled: string[]): Invalid | null {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (enabled.includes(domain)) return null;
  return { ok: false, error: "domain_not_available", hint: "GET /api/v1/domains lists the domains that receive mail" };
}

export function isFresh(receivedAt: string | undefined, since: number | null): boolean {
  return since === null || Date.parse(receivedAt ?? "") >= since;
}

/**
 * Ask until a fresh item shows up or the wait runs out.
 *
 * Holding the request server-side saves curl-only agents from writing a sleep loop.
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

export function pickAddress(
  enabled: string[],
  wanted: unknown,
  randomInt: (n: number) => number,
): { ok: true; email: string; domain: string } | Invalid {
  let domain: string;
  if (wanted !== undefined && wanted !== null && wanted !== "") {
    domain = normalizeDomain(wanted);
    if (!enabled.includes(domain)) {
      return { ok: false, error: "domain_not_available", hint: "GET /api/v1/domains lists the domains that receive mail" };
    }
  } else {
    if (!enabled.length) return { ok: false, error: "no_domains_available", hint: "The operator must enable a domain" };
    domain = enabled[randomInt(enabled.length)];
  }
  return { ok: true, email: `${randomLocalPart(randomInt)}@${domain}`, domain };
}

/** Uniform integer in [0, n) from the platform CSPRNG. */
export function secureRandomInt(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}
