PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  zone TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  domain TEXT NOT NULL,
  local_part TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  raw_size INTEGER NOT NULL DEFAULT 0,
  raw_truncated INTEGER NOT NULL DEFAULT 0,
  raw TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  headers_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (domain) REFERENCES domains(domain) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS forwards (
  domain TEXT PRIMARY KEY,
  zone TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_recipient_received
  ON messages (recipient, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_domain_received
  ON messages (domain, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_received_at
  ON messages (received_at);

CREATE INDEX IF NOT EXISTS idx_messages_code
  ON messages (code);

CREATE INDEX IF NOT EXISTS idx_messages_link
  ON messages (link);

CREATE INDEX IF NOT EXISTS idx_forwards_destination
  ON forwards (destination);
