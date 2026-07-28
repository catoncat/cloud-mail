import type { DomainPurpose } from "./types";

const MAILBOX_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/;
const LINK_ID_RE = /^[A-Za-z0-9_-]{12,96}$/;

export function normalizeMailbox(value: unknown): string {
  const v = String(value ?? "").trim().toLowerCase();
  return MAILBOX_RE.test(v) ? v : "";
}

export function normalizeDomain(value: unknown): string {
  const v = String(value ?? "").trim().toLowerCase().replace(/^@/, "");
  return DOMAIN_RE.test(v) ? v : "";
}

export function normalizeLocalPart(value: unknown): string {
  const v = String(value ?? "").trim().toLowerCase();
  return LOCAL_PART_RE.test(v) ? v : "";
}

export function normalizePurpose(value: unknown): DomainPurpose {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "automation" || v === "manual" || v === "reserved" ? v : "reserved";
}

export function isValidLinkId(value: string): boolean {
  return LINK_ID_RE.test(value);
}

export function createLinkId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function splitMailboxes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? "").trim()).filter(Boolean);
  return String(value ?? "").split(/[\s,;，；]+/).map((v) => v.trim()).filter(Boolean);
}
