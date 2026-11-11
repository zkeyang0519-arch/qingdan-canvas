import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CommandEnvelope,
  ExecutionSnapshot,
  RunnerEvent,
} from "../shared/agent/contracts";
import type { ExecutionAck, ExecutionReport } from "../shared/agent/execution";
import { digest } from "./store";
import { RunnerError } from "./errors";
import type { NativeRequestResponse } from "../shared/agent/permissions";

export type NativeAck = Omit<ExecutionAck, "connectionEpoch">;
export type NativeReport = Omit<ExecutionReport, "connectionEpoch">;
export type HeldRun = {
  runId: string;
  workspaceId: string;
  lockToken: string;
  phase: "reserving" | "locked" | "claimed" | "releasing" | "local_release";
};
export type JournalEntry = {
  envelope: CommandEnvelope;
  snapshot: ExecutionSnapshot;
  phase:
    | "staged"
    | "dispatching"
    | "applied"
    | "uncertain"
    | "rejected"
    | "superseded";
  ack?: NativeAck;
  acked?: boolean;
  startedAt?: number;
  error?: string;
};
type RunState = {
  latest: string;
  revision: number;
  report?: NativeReport;
  reportSent?: boolean;
  reportSettled?: boolean;
};
type EventPage = { cursor: number; events: RunnerEvent[] };
export type InteractionReceipt = {
  responseId: string;
  pendingRequestId: string;
  runId: string;
  hash: string;
  status: "dispatching" | "applied" | "expired" | "cancelled";
  acked: boolean;
};

/** Native side effects and their delivery receipts survive transport/process restarts. */
export class ExecutionStore {
  private db: DatabaseSync;
  constructor(private filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interrupts (key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS event_runs (
        run_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0,
        page TEXT, pending INTEGER NOT NULL DEFAULT 1, attempt INTEGER NOT NULL DEFAULT 0
      );
    `);
  }
  acquireConsumer() {
    // A process-level SQLite lock dies with the host process. It prevents a
    // second launcher on the same device state from reconciling while the
    // original executor is between its durable marker and an RPC send.
    const lock = new DatabaseSync(this.filename + ".consumer");
    try {
      lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch (error) {
      lock.close();
      if (String(error).includes("locked"))
        throw new RunnerError(
          "EXECUTOR_BUSY",
          "Another Runner is using this device state.",
        );
      throw error;
    }
    return () => lock.close();
  }
  private read<T>(
    table: "state" | "commands" | "runs",
    key: string,
  ): T | undefined {
    const row = this.db
      .prepare(`SELECT data FROM ${table} WHERE key=?`)
      .get(key);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private write(
    table: "state" | "commands" | "runs",
    key: string,
    value: unknown,
  ) {
    this.db
      .prepare(
        `INSERT INTO ${table} VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data=excluded.data`,
      )
      .run(key, JSON.stringify(value));
  }
  private transaction<T>(fn: () => T): T {
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
  held() {
    return this.read<HeldRun>("state", "held");
  }
  reserve(runId: string, workspaceId: string) {
    const held: HeldRun = {
      runId,
      workspaceId,
      lockToken: randomUUID(),
      phase: "reserving",
    };
    if (
      !this.db
        .prepare("INSERT OR IGNORE INTO state VALUES ('held', ?)")
        .run(JSON.stringify(held)).changes
    )
      return null;
    return held;
  }
  updateHold(held: HeldRun, phase: HeldRun["phase"]) {
    return this.transaction(() => {
      const current = this.held();
      if (
        !current ||
        current.lockToken !== held.lockToken ||
        current.phase !== held.phase
      )
        return null;
      const next = { ...current, phase };
      this.write("state", "held", next);
      return next;
    });
  }
  clearHold(held: HeldRun) {
    this.transaction(() => {
      const current = this.held();
      if (current?.lockToken === held.lockToken && current.phase === held.phase)
        this.db.prepare("DELETE FROM state WHERE key='held'").run();
    });
  }
  command(commandId: string) {
    return this.read<JournalEntry>("commands", commandId);
  }
  run(runId: string) {
    return this.read<RunState>("runs", runId);
  }
  latest(runId: string) {
    const state = this.run(runId);
    return state && this.command(state.latest);
  }
  checkpointRecovery(runId:string) {
    return this.read<{commandId:string;turnId:string}>("state",`checkpoint-recovery:${runId}`);
  }
  stopIntent(runId:string) {
    return this.read<{reason:string;commandId:string|null}>("state",`stop-intent:${runId}`);
  }
  recordStopIntent(runId:string,reason:string,commandId:string|null) {
    this.write("state",`stop-intent:${runId}`,{reason,commandId});
  }
  markCheckpointRecovery(runId:string,commandId:string,turnId:string) {
    this.write("state",`checkpoint-recovery:${runId}`,{commandId,turnId});
  }
  clearCheckpointRecovery(runId:string) {
    this.db.prepare("DELETE FROM state WHERE key=?").run(`checkpoint-recovery:${runId}`);
  }
  accept(envelope: CommandEnvelope, snapshot: ExecutionSnapshot) {
    return this.transaction(() => {
      const old = this.command(envelope.commandId);
      if (old) {
        if (
          digest(old.envelope) !== digest(envelope) ||
          digest(old.snapshot) !== digest(snapshot)
        )
          throw new RunnerError(
            "IDEMPOTENCY_KEY_REUSED",
            "Execution command was delivered with different content.",
          );
        return old;
      }
      const prior = this.run(envelope.runId);
      const command = envelope.payload;
      const startedAt =
        command.type === "cancel_run" ||
        (command.type === "continue_run" && command.mode === "steer")
          ? this.latest(envelope.runId)?.startedAt
          : undefined;
      const entry: JournalEntry = {
        envelope,
        snapshot,
        phase: "staged",
        startedAt,
      };
      this.write("commands", envelope.commandId, entry);
      this.db
        .prepare(
          "INSERT INTO event_runs(run_id) VALUES (?) ON CONFLICT(run_id) DO UPDATE SET pending=1",
        )
        .run(envelope.runId);
      this.write("runs", envelope.runId, {
        ...prior,
        latest: envelope.commandId,
        revision: prior?.revision ?? 0,
      } satisfies RunState);
      return entry;
    });
  }
  transition(
    entry: JournalEntry,
    patch: Partial<Omit<JournalEntry, "envelope" | "snapshot">>,
  ) {
    return this.transaction(() => {
      const current = this.command(entry.envelope.commandId);
      if (current?.phase !== entry.phase) return null;
      const next = { ...current, ...patch };
      this.write("commands", entry.envelope.commandId, next);
      return next;
    });
  }
  saveReport(value: Omit<NativeReport, "revision">) {
    return this.transaction(() => {
      const state = this.run(value.runId);
      if (!state || value.commandId !== state.latest) return;
      if (state.report) {
        const { revision: _, ...prior } = state.report;
        if (digest(prior) === digest(value) || !state.reportSent) return;
      }
      const report = { ...value, revision: state.revision + 1 };
      this.write("runs", value.runId, {
        ...state,
        revision: report.revision,
        report,
        reportSent: false,
        reportSettled: false,
      });
    });
  }
  markReportSent(report: NativeReport, settled: boolean) {
    this.transaction(() => {
      const state = this.run(report.runId);
      if (state?.report?.revision === report.revision)
        this.write("runs", report.runId, {
          ...state,
          reportSent: true,
          reportSettled: settled,
        });
    });
  }
  interruptOnce(key: string) {
    return !!this.db
      .prepare("INSERT OR IGNORE INTO interrupts VALUES (?)")
      .run(key).changes;
  }
  pendingEventRun() {
    const row = this.db
      .prepare(
        "SELECT run_id FROM event_runs WHERE pending=1 ORDER BY attempt, run_id LIMIT 1",
      )
      .get();
    return row ? String(row.run_id) : undefined;
  }
  beginInteractionResponse(input: NativeRequestResponse): {
    receipt: InteractionReceipt;
    created: boolean;
  } {
    const key = `interaction-response:${input.responseId}`,
      hash = digest(input);
    return this.transaction(() => {
      const previous = this.read<InteractionReceipt>("state", key);
      if (previous) {
        if (previous.hash !== hash)
          throw new RunnerError(
            "IDEMPOTENCY_KEY_REUSED",
            "审批响应编号已被不同内容使用。",
          );
        return { receipt: previous, created: false };
      }
      // Only identity, digest and delivery state persist; answers and wire IDs
      // never do. The marker fences the following non-idempotent RPC response.
      const receipt: InteractionReceipt = {
        responseId: input.responseId,
        pendingRequestId: input.pendingRequestId,
        runId: input.runId,
        hash,
        status: "dispatching",
        acked: false,
      };
      this.write("state", key, receipt);
      return { receipt, created: true };
    });
  }
  finishInteractionResponse(
    responseId: string,
    status: Exclude<InteractionReceipt["status"], "dispatching">,
  ) {
    const key = `interaction-response:${responseId}`,
      receipt = this.read<InteractionReceipt>("state", key);
    if (receipt) this.write("state", key, { ...receipt, status });
  }
  unackedInteractionResponses(): InteractionReceipt[] {
    return this.db
      .prepare(
        "SELECT data FROM state WHERE key LIKE 'interaction-response:%' AND json_extract(data,'$.acked')=0 LIMIT 20",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  acknowledgeInteractionResponse(responseId: string) {
    const key = `interaction-response:${responseId}`,
      receipt = this.read<InteractionReceipt>("state", key);
    if (receipt) this.write("state", key, { ...receipt, acked: true });
  }
  eventState(runId: string) {
    const row = this.db
      .prepare("SELECT cursor, page FROM event_runs WHERE run_id=?")
      .get(runId);
    return {
      cursor: Number(row?.cursor ?? 0),
      page: row?.page ? (JSON.parse(String(row.page)) as EventPage) : undefined,
    };
  }
  eventAttempt(runId: string, at: number) {
    this.db
      .prepare("UPDATE event_runs SET attempt=? WHERE run_id=?")
      .run(at, runId);
  }
  saveEventPage(runId: string, page: EventPage) {
    this.db
      .prepare("UPDATE event_runs SET page=? WHERE run_id=?")
      .run(JSON.stringify(page), runId);
  }
  markEventPageSent(runId: string, page: EventPage) {
    this.db
      .prepare(
        "UPDATE event_runs SET cursor=?, page=NULL WHERE run_id=? AND page=?",
      )
      .run(page.cursor, runId, JSON.stringify(page));
  }
  markEventsDrained(runId: string) {
    this.db
      .prepare(
        "UPDATE event_runs SET pending=0 WHERE run_id=? AND page IS NULL",
      )
      .run(runId);
  }
  close() {
    this.db.close();
  }
}
