export interface Env {
  /** Service Binding to intake's `InternalApi` entrypoint. */
  INTAKE: Fetcher;
  /** Operator console and `cloud-mail` CLI (`/admin/api/*`). */
  OPERATOR_KEY?: string;
  CF_API_TOKEN?: string;
  SHARE_LINKS: KVNamespace;
  /** Tenants and the addresses they own; the agent surfaces (`/mcp`, `/api/v1`) authenticate against it. */
  DB: D1Database;
  ASSETS: Fetcher;
}

/** Whoever holds one cm_ token: one of your agents, or someone you gave access to. */
export type Tenant = {
  id: string;
  name: string;
  /** Domains new addresses may use, each covering its subdomains; null means every enabled domain. */
  domains: string[] | null;
};

export type LinkRecord = { mailbox: string; label?: string; createdAt: string };
export type AddressRecord = {
  mailbox: string;
  label?: string;
  service?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
};
export type IntakeMessage = {
  id?: string;
  domain?: string;
  recipient?: string;
  sender?: string;
  subject?: string;
  received_at?: string;
  text_body?: string;
  html_body?: string;
  code?: string;
  link?: string;
};

export type LatestMessage = {
  id: string | null;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  text: string;
  code?: string;
  link?: string;
};

export type DomainStat = {
  domain: string;
  enabled: boolean;
  mailboxes: number;
  messages: number;
  codes: number;
  lastActivity: string | null;
};

export type MailboxSummary = {
  mailbox: string;
  localPart: string;
  domain: string;
  messages: number;
  codes: number;
  lastActivity: string | null;
  lastCode: string | null;
  lastCodeAt: string | null;
  latestSender: string;
  latestSubject: string;
};

export type AddressView = {
  mailbox: string;
  localPart: string;
  domain: string;
  label?: string;
  service: string | null;
  note?: string;
  createdAt: string | null;
  updatedAt: string | null;
  registered: boolean;
  publicAccess: boolean;
  messages: number;
  codes: number;
  lastActivity: string | null;
  lastCode: string | null;
  lastCodeAt: string | null;
  latestSender: string;
  latestSubject: string;
  shares: LinkView[];
};

export type MailboxStat = {
  mailbox: string;
  localPart: string;
  domain: string;
  messages: number;
  lastCode: string | null;
  lastActivity: string | null;
  service: string | null;
  shared: boolean;
  shareUrl?: string;
};

export type LinkView = LinkRecord & { id: string; url: string; jsonUrl: string };

export type Overview = {
  mailboxesTotal: number;
  codesToday: number;
  codesWeek: number;
  shareLinks: number;
  lastActivity: string | null;
  domainsWithMail: number;
  domainsConfigured: number;
  topDomains: DomainStat[];
};
