-- Who may use the agent surfaces (/mcp, /api/v1), and which addresses they own.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  -- SHA-256 of the cm_ token. Rotating replaces it; the token itself is never stored.
  token_hash TEXT NOT NULL UNIQUE,
  -- JSON array of domains new addresses may use, each covering its subdomains. NULL means every enabled domain.
  domains TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

-- An address belongs to the tenant that created it, permanently: it is the login
-- identity of whatever account was registered with it, so it is never reassigned.
CREATE TABLE IF NOT EXISTS inboxes (
  email TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  -- Mail received before this is never shown to the tenant.
  created_at TEXT NOT NULL,
  -- received_at of the newest mail wait_for_email has handed out.
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_inboxes_tenant ON inboxes (tenant_id, created_at DESC);
