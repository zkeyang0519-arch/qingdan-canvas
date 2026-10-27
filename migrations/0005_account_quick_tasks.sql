CREATE TABLE account_quick_tasks (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, text)
);
