CREATE TABLE registration_challenges (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_by TEXT
);
CREATE UNIQUE INDEX registration_challenges_username ON registration_challenges(username);
CREATE UNIQUE INDEX registration_challenges_email ON registration_challenges(email);
CREATE INDEX registration_challenges_expiry ON registration_challenges(expires_at);
