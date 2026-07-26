export type DomainPurpose = "automation" | "manual" | "reserved";

export type LinkRecord = { mailbox: string; label?: string; createdAt: string };
export type DomainMeta = { domain: string; purpose: DomainPurpose; note?: string; updatedAt: string };

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

/** Live Email Routing state; distinguishes "idle" from "cannot receive". */
export type DomainHealth = {
  domain: string;
  zone?: string;
  status: "routed" | "unrouted" | "unknown";
  detail?: string;
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

export type MailboxHistory = {
  mailbox: string;
  latest: LatestMessage | null;
  messages: LatestMessage[];
};

export type FeedMessage = LatestMessage & { domain: string };

export type MessageFeed = {
  total: number;
  page: number;
  size: number;
  pages: number;
  messages: FeedMessage[];
};

export type Zone = { id: string; name: string; status: string };

export type UsageReport = {
  services: Array<{ service: string; domains: string[]; claims: number; lastAt: string }>;
  domains: Array<{ domain: string; services: Array<{ service: string; claims: number; lastAt: string }> }>;
  recent: Array<{ service: string; domain: string; at: string }>;
};
