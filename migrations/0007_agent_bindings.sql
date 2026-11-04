CREATE TABLE agent_pairings (
 pairing_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id),
 code_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, consumed_at INTEGER, consume_id TEXT
);
CREATE TABLE agent_devices (
 runner_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id),
 device_name TEXT NOT NULL, secret_hash TEXT NOT NULL, auth_epoch INTEGER NOT NULL DEFAULT 1,
 revoked_at INTEGER, last_seen_at INTEGER, connection_epoch INTEGER NOT NULL DEFAULT 0,
 workspaces_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX agent_devices_owner ON agent_devices(owner_id);
CREATE TABLE agent_connection_tokens (
 token_hash TEXT PRIMARY KEY, runner_id TEXT NOT NULL REFERENCES agent_devices(runner_id),
 audience TEXT NOT NULL, auth_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX agent_connection_token_expiry ON agent_connection_tokens(expires_at);
-- Expiry is informational: only a confirmed stopped release removes occupancy.
-- D1 lets binding CAS observe leases atomically across different runner hubs.
CREATE TABLE agent_workspace_leases (
 runner_id TEXT NOT NULL REFERENCES agent_devices(runner_id), workspace_id TEXT NOT NULL,
 run_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(runner_id,workspace_id)
);
CREATE TABLE agent_bindings (
 binding_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id),
 canvas_id TEXT NOT NULL REFERENCES rooms(id), section_id TEXT NOT NULL,
 runner_id TEXT NOT NULL REFERENCES agent_devices(runner_id), workspace_id TEXT NOT NULL,
 revision INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 UNIQUE(canvas_id,section_id)
);
