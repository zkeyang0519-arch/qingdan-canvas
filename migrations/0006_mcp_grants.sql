-- Additive application grants; provider OAuth credentials remain in provider KV.
CREATE TABLE mcp_consent_selections (
  handle TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  session_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  canvas_ids TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','selected','pending','active','revoked')),
  grant_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX mcp_consent_expiry ON mcp_consent_selections(expires_at);
CREATE TABLE mcp_grants (
  id TEXT PRIMARY KEY,
  provider_grant_id TEXT UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')),
  consent_handle TEXT NOT NULL UNIQUE REFERENCES mcp_consent_selections(handle),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX mcp_grants_account ON mcp_grants(account_id,created_at,id);
CREATE INDEX mcp_grants_expiry ON mcp_grants(state,expires_at);
CREATE TABLE mcp_grant_rooms (
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  PRIMARY KEY(grant_id,room_id)
);
CREATE INDEX mcp_grant_rooms_room ON mcp_grant_rooms(room_id,grant_id);
