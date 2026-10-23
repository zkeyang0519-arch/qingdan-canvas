ALTER TABLE accounts ADD COLUMN email TEXT;
ALTER TABLE accounts ADD COLUMN email_verified_at INTEGER;
CREATE UNIQUE INDEX accounts_verified_email ON accounts(email) WHERE email IS NOT NULL;

CREATE TABLE email_challenges (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('bind', 'reset')),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  prior_email TEXT,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_by TEXT
);
CREATE INDEX email_challenges_account ON email_challenges(account_id, purpose);
CREATE INDEX email_challenges_expiry ON email_challenges(expires_at);
