CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  invite_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner', 'editor')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY(room_id, user_id)
);
CREATE INDEX member_rooms ON members(user_id);
CREATE TABLE assets (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  id TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(room_id, id)
);
