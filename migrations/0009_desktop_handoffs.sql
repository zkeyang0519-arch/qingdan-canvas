CREATE TABLE desktop_handoffs (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES account_sessions(token_hash) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX desktop_handoffs_expiry ON desktop_handoffs(expires_at);
CREATE INDEX desktop_handoffs_session ON desktop_handoffs(session_hash);
