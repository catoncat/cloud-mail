-- Share links, public mailboxes and address notes used to live in KV as whole-object
-- index blobs: every write read the whole index, parsed it, re-serialised it and put
-- it back, so one address cost two KV writes against a free allowance of 1,000 a day,
-- and cost CPU in proportion to how many records already existed.
--
-- They are rows here instead. One upsert is one row write, a lookup is one row read,
-- and the limits are D1's (100,000 rows written, 5M read a day).
--
-- Upgrading an existing deployment: apply this migration, then the app imports the
-- records still in the KV namespace on its first request (see src/lib/store.ts) and
-- records that in share_meta. The KV binding can be removed afterwards.

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_share_links_mailbox ON share_links (mailbox, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_links_created ON share_links (created_at DESC);

CREATE TABLE IF NOT EXISTS share_mailboxes (
  mailbox TEXT PRIMARY KEY,
  label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS share_addresses (
  mailbox TEXT PRIMARY KEY,
  label TEXT,
  service TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_share_addresses_created ON share_addresses (created_at DESC);

-- One-off bookkeeping, e.g. "the KV records have been imported".
CREATE TABLE IF NOT EXISTS share_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
