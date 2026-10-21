-- Keep legacy sessions until their browser holder claims the existing content.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX account_sessions_user ON account_sessions(account_id);
CREATE INDEX account_sessions_expiry ON account_sessions(expires_at);
CREATE TABLE legacy_claims (
  legacy_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id)
);
CREATE TABLE auth_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX auth_limits_expiry ON auth_limits(reset_at);
