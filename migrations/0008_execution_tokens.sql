CREATE TABLE agent_execution_tokens (
 token_hash TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 runner_id TEXT NOT NULL,
 binding_id TEXT NOT NULL,
 binding_revision INTEGER NOT NULL,
 auth_epoch INTEGER NOT NULL,
 audience TEXT NOT NULL,
 purpose TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX execution_token_expiry ON agent_execution_tokens(expires_at);
CREATE TABLE agent_execution_requests (
 owner_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 runner_id TEXT NOT NULL,
 binding_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,request_id)
);
