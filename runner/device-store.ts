import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { digest } from "./store";
import { RunnerError } from "./errors";
import type { RunnerEvent, CommandEnvelope } from "../shared/agent/contracts";
export type WorkspaceView = {
  workspaceId: string;
  name: string;
  displayPath: string;
  revision: number;
  checks: { checkId: string; label: string }[];
};
export type WorkspaceRecord = WorkspaceView & {
  root: string;
  registeredPath: string;
  identity: string;
  lockRoot: string;
};
export type DeviceConfig = {
  runnerId: string;
  ownerId: string;
  deviceName: string;
  serverOrigin: string;
  authEpoch: number;
  enabled: boolean;
  pairingPending: boolean;
};
export type LeaseRecord = {
  workspaceId: string;
  runId: string;
  leaseEpoch: number;
  expiresAt: number;
};
export type StoredReceipt = { status: "stored" | "rejected"; reason?: string };
export type DeviceResetReceipt = {
  ownerId: string;
  runnerId: string;
  serverOrigin: string;
  revokedAuthEpoch: number;
  completedAt: string;
};
/** Separate schema: never opens or changes the execution adapter's RunnerStore. */
export class DeviceStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA busy_timeout=5000");
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (version > 1) {
      this.db.close();
      throw new RunnerError(
        "STORE_VERSION_UNSUPPORTED",
        "Device store version is unsupported.",
      );
    }
    this.db.exec("PRAGMA journal_mode=WAL");
    if (version === 0)
      this.db.exec(
        `BEGIN IMMEDIATE;CREATE TABLE metadata(key TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE workspaces(workspace_id TEXT PRIMARY KEY,root_key TEXT UNIQUE NOT NULL,data TEXT NOT NULL);CREATE TABLE commands(command_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,data TEXT NOT NULL,receipt TEXT NOT NULL);CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,payload_hash TEXT NOT NULL,data TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);CREATE TABLE leases(workspace_id TEXT PRIMARY KEY,run_id TEXT UNIQUE NOT NULL,data TEXT NOT NULL);PRAGMA user_version=1;COMMIT;`,
      );
  }
  config(): DeviceConfig | null {
    const row = this.db
      .prepare("SELECT data FROM metadata WHERE key='device'")
      .get();
    return row ? JSON.parse(String(row.data)) : null;
  }
  saveConfig(config: DeviceConfig) {
    this.db
      .prepare(
        "INSERT INTO metadata VALUES('device',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(JSON.stringify(config));
  }
  clear() {
    this.db.exec(
      "BEGIN IMMEDIATE;DELETE FROM metadata;DELETE FROM workspaces;DELETE FROM commands;DELETE FROM events;DELETE FROM leases;COMMIT;",
    );
  }
  resetReceipt(): DeviceResetReceipt | null {
    const row = this.db
      .prepare("SELECT data FROM metadata WHERE key='device-reset'")
      .get();
    return row ? JSON.parse(String(row.data)) : null;
  }
  clearForReset(expected: DeviceConfig, receipt: DeviceResetReceipt) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.config();
      if (!current || digest(current) !== digest(expected))
        throw new RunnerError("STALE_DEVICE", "电脑绑定已变化，请刷新后重试。");
      this.db.exec(
        "DELETE FROM metadata; DELETE FROM workspaces; DELETE FROM commands; DELETE FROM events; DELETE FROM leases;",
      );
      this.db
        .prepare("INSERT INTO metadata VALUES ('device-reset',?)")
        .run(JSON.stringify(receipt));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  workspaces(): WorkspaceRecord[] {
    return this.db
      .prepare("SELECT data FROM workspaces ORDER BY workspace_id")
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  workspace(id: string): WorkspaceRecord | null {
    const row = this.db
      .prepare("SELECT data FROM workspaces WHERE workspace_id=?")
      .get(id);
    return row ? JSON.parse(String(row.data)) : null;
  }
  saveWorkspace(workspace: WorkspaceRecord, rootKey: string) {
    this.db
      .prepare(
        "INSERT INTO workspaces VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET root_key=excluded.root_key,data=excluded.data",
      )
      .run(workspace.workspaceId, rootKey, JSON.stringify(workspace));
  }
  removeWorkspace(id: string) {
    this.db.prepare("DELETE FROM workspaces WHERE workspace_id=?").run(id);
  }
  command(id: string): { hash: string; receipt: StoredReceipt } | null {
    const row = this.db
      .prepare("SELECT payload_hash,receipt FROM commands WHERE command_id=?")
      .get(id);
    return row
      ? {
          hash: String(row.payload_hash),
          receipt: JSON.parse(String(row.receipt)),
        }
      : null;
  }
  receiveCommand(
    envelope: CommandEnvelope,
    receipt: StoredReceipt,
  ): StoredReceipt {
    const prior = this.command(envelope.commandId),
      hash = digest(envelope);
    if (prior) {
      if (prior.hash !== hash)
        throw new RunnerError(
          "IDEMPOTENCY_KEY_REUSED",
          "Command ID reused with different content.",
        );
      return prior.receipt;
    }
    this.db
      .prepare("INSERT INTO commands VALUES(?,?,?,?)")
      .run(
        envelope.commandId,
        hash,
        JSON.stringify(envelope),
        JSON.stringify(receipt),
      );
    return receipt;
  }
  commands(): { envelope: CommandEnvelope; receipt: StoredReceipt }[] {
    return this.db
      .prepare("SELECT data,receipt FROM commands ORDER BY rowid")
      .all()
      .map((row) => ({
        envelope: JSON.parse(String(row.data)),
        receipt: JSON.parse(String(row.receipt)),
      }));
  }
  enqueueEvent(event: RunnerEvent) {
    const hash = digest(event),
      prior = this.db
        .prepare("SELECT payload_hash,acked FROM events WHERE event_id=?")
        .get(event.eventId);
    if (prior) {
      if (prior.payload_hash !== hash)
        throw new RunnerError(
          "IDEMPOTENCY_KEY_REUSED",
          "Event ID reused with different content.",
        );
      return Number(prior.acked) === 0;
    }
    this.db
      .prepare("INSERT INTO events(event_id,payload_hash,data) VALUES(?,?,?)")
      .run(event.eventId, hash, JSON.stringify(event));
    return true;
  }
  pendingEvents(): RunnerEvent[] {
    return this.db
      .prepare("SELECT data FROM events WHERE acked=0 ORDER BY sequence")
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  ackEvent(eventId: string) {
    this.db.prepare("UPDATE events SET acked=1 WHERE event_id=?").run(eventId);
  }
  saveLease(lease: LeaseRecord) {
    const workspaceLease = this.leases().find(
      (l) => l.workspaceId === lease.workspaceId,
    );
    if (workspaceLease && workspaceLease.runId !== lease.runId)
      throw new RunnerError(
        "WORKSPACE_BUSY",
        "Workspace has an active or unconfirmed run.",
      );
    const prior = this.lease(lease.runId);
    if (prior && prior.workspaceId !== lease.workspaceId)
      throw new RunnerError(
        "WORKSPACE_BUSY",
        "Run already owns a different workspace.",
      );
    this.db
      .prepare(
        "INSERT INTO leases VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET run_id=excluded.run_id,data=excluded.data",
      )
      .run(lease.workspaceId, lease.runId, JSON.stringify(lease));
  }
  lease(runId: string): LeaseRecord | null {
    const row = this.db
      .prepare("SELECT data FROM leases WHERE run_id=?")
      .get(runId);
    return row ? JSON.parse(String(row.data)) : null;
  }
  leases(): LeaseRecord[] {
    return this.db
      .prepare("SELECT data FROM leases")
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  removeLease(workspaceId: string) {
    this.db.prepare("DELETE FROM leases WHERE workspace_id=?").run(workspaceId);
  }
  close() {
    this.db.close();
  }
}
