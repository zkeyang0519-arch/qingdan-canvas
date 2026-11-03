import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  ExecutionSnapshot,
  RunnerEvent,
  RunnerEventPayloads,
} from "../shared/agent/contracts";
import { parseRunnerEvent } from "../shared/agent/schemas";
import { RunnerError } from "./errors";
import { rootKey } from "./workspace";
import type { RunRecord, StoredEvent } from "./types";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

export class RunnerStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (version > 1) {
      this.db.close();
      throw new RunnerError(
        "STORE_VERSION_UNSUPPORTED",
        `Unsupported Runner store version ${version}`,
      );
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    if (version === 0)
      this.transaction(() => {
        this.db.exec(`
        CREATE TABLE runs (run_id TEXT PRIMARY KEY, thread_id TEXT UNIQUE, root_key TEXT NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE UNIQUE INDEX active_workspace ON runs(root_key) WHERE active = 1;
        CREATE TABLE events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id), event_key TEXT, data TEXT NOT NULL, UNIQUE(run_id,event_key));
        CREATE TABLE commands (command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), payload_hash TEXT NOT NULL, receipt TEXT);
        PRAGMA user_version = 1;
      `);
      });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  getRun(runId: string): RunRecord | null {
    const row = this.db
      .prepare("SELECT data FROM runs WHERE run_id = ?")
      .get(runId);
    return row ? JSON.parse(String(row.data)) : null;
  }
  byThread(threadId: string): RunRecord | null {
    const row = this.db
      .prepare("SELECT data FROM runs WHERE thread_id = ?")
      .get(threadId);
    return row ? JSON.parse(String(row.data)) : null;
  }
  allRuns(): RunRecord[] {
    return this.db
      .prepare("SELECT data FROM runs")
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  prepareRun(
    snapshot: ExecutionSnapshot,
    root: string,
  ): { run: RunRecord; created: boolean } {
    return this.transaction(() => {
      const prior = this.getRun(snapshot.runId),
        hash = digest(snapshot);
      if (prior) {
        if (prior.digest !== hash || rootKey(prior.root) !== rootKey(root))
          throw new RunnerError(
            "IDEMPOTENCY_KEY_REUSED",
            "运行 ID 已被不同任务快照使用。",
          );
        return { run: prior, created: false };
      }
      if (
        this.db
          .prepare("SELECT run_id FROM runs WHERE root_key = ? AND active = 1")
          .get(rootKey(root))
      )
        throw new RunnerError("WORKSPACE_BUSY", "此目录已有运行或待核实任务。");
      const run: RunRecord = {
        runId: snapshot.runId,
        snapshot,
        digest: hash,
        root,
        threadId: null,
        activeTurnId: null,
        pendingRequestId: null,
        launchIntent: "prepared",
        status: "preparing",
        active: true,
        terminal: false,
        cancelRequested: false,
        result: null,
        resultValid: false,
        resultError: null,
        output: "",
        launchResult: null,
      };
      this.db
        .prepare("INSERT INTO runs VALUES (?, NULL, ?, 1, ?)")
        .run(run.runId, rootKey(root), JSON.stringify(run));
      return { run, created: true };
    });
  }
  patchRun(runId: string, patch: Partial<RunRecord>): RunRecord {
    const prior = this.getRun(runId);
    if (!prior) throw new RunnerError("RUN_NOT_FOUND", "找不到本地运行。");
    const run = { ...prior, ...patch, runId: prior.runId };
    try {
      this.db
        .prepare(
          "UPDATE runs SET thread_id = ?, active = ?, data = ? WHERE run_id = ?",
        )
        .run(run.threadId, Number(run.active), JSON.stringify(run), runId);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint"))
        throw new RunnerError(
          "WORKSPACE_BUSY",
          "工作目录或会话已经被其他运行占用。",
        );
      throw error;
    }
    return run;
  }
  acceptCommand(
    commandId: string,
    runId: string,
    payload: unknown,
  ): { created: boolean; receipt: unknown } {
    return this.transaction(() => {
      const hash = digest(payload),
        prior = this.db
          .prepare("SELECT * FROM commands WHERE command_id = ?")
          .get(commandId);
      if (prior) {
        if (prior.payload_hash !== hash || prior.run_id !== runId)
          throw new RunnerError(
            "IDEMPOTENCY_KEY_REUSED",
            "命令 ID 已被不同内容使用。",
          );
        return {
          created: false,
          receipt: prior.receipt ? JSON.parse(String(prior.receipt)) : null,
        };
      }
      this.db
        .prepare("INSERT INTO commands VALUES (?, ?, ?, NULL)")
        .run(commandId, runId, hash);
      return { created: true, receipt: null };
    });
  }
  saveReceipt(commandId: string, receipt: unknown) {
    this.db
      .prepare("UPDATE commands SET receipt = ? WHERE command_id = ?")
      .run(JSON.stringify(receipt), commandId);
  }
  appendEvent<K extends keyof RunnerEventPayloads>(
    runnerId: string,
    runId: string,
    type: K,
    payload: RunnerEventPayloads[K],
    eventKey?: string,
    patch: Partial<RunRecord> = {},
  ): RunnerEvent | null {
    return this.transaction(() => {
      if (
        eventKey &&
        this.db
          .prepare(
            "SELECT cursor FROM events WHERE run_id = ? AND event_key = ?",
          )
          .get(runId, eventKey)
      )
        return null;
      const run = this.patchRun(runId, patch);
      const seq =
        Number(
          this.db
            .prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ?")
            .get(runId)!.n,
        ) + 1;
      const event = parseRunnerEvent({
        protocolVersion: 1,
        eventId: randomUUID(),
        runnerId,
        runId,
        threadId: run.threadId,
        turnId: run.activeTurnId,
        seq,
        type,
        occurredAt: new Date().toISOString(),
        payload,
      });
      this.db
        .prepare("INSERT INTO events(run_id,event_key,data) VALUES(?,?,?)")
        .run(runId, eventKey ?? null, JSON.stringify(event));
      return event;
    });
  }
  eventsAfter(cursor: number): StoredEvent[] {
    return this.db
      .prepare(
        "SELECT cursor, data FROM events WHERE cursor > ? ORDER BY cursor LIMIT 200",
      )
      .all(cursor)
      .map((row) => ({
        cursor: Number(row.cursor),
        event: JSON.parse(String(row.data)),
      }));
  }
  close() {
    this.db.close();
  }
}
