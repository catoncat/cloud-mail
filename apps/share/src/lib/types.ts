export interface Env {
  INTAKE_ORIGIN: string;
  MAIL_INTAKE_ADMIN_TOKEN: string;
  ADMIN_KEY?: string;
  SERVICE_TOKEN?: string;
  CF_API_TOKEN?: string;
  INTAKE_ADMIN_TOKEN?: string;
  SHARE_LINKS: KVNamespace;
  ASSETS: Fetcher;
}

export type DomainPurpose = "automation" | "manual" | "reserved";

export type LinkRecord = { mailbox: string; label?: string; createdAt: string };
export type AddressRecord = {
  mailbox: string;
  label?: string;
  service?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
};
export type DomainMeta = { domain: string; purpose: DomainPurpose; note?: string; updatedAt: string };

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

export type AddressDetail = {
  address: AddressView;
  messages: LatestMessage[];
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

export type ClaimRecord = {
  service: string;
  domain: string;
  at: string;
};

export type ServiceUsage = {
  service: string;
  domains: string[];
  claims: number;
  lastAt: string;
};

export type DomainUsage = {
  domain: string;
  services: Array<{ service: string; claims: number; lastAt: string }>;
};
