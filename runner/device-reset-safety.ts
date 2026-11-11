import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { digest } from "./store";
import { RunnerError } from "./errors";
import type { DeviceStore } from "./device-store";
import type { WorkspaceRegistry } from "./workspaces";

const busy = () =>
  new RunnerError(
    "WORKSPACE_BUSY",
    "仍有活动或待核实的本地执行，请先停止并核对运行。",
  );
const unknown = () =>
  new RunnerError(
    "RESET_STATE_UNKNOWN",
    "本地执行证据不完整或无法读取，不能重置设备。",
  );
const exists = (file: string) => {
  try {
    if (!statSync(file).isFile()) throw unknown();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw unknown();
  }
};

/** Never opens an executor or repairs a journal to make an unsafe reset pass. */
export async function withDeviceResetSafety<T>(
  options: {
    executionDir: string;
    device: DeviceStore;
    registry: WorkspaceRegistry;
    consumerOwned: boolean;
  },
  work: (check: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const journalFile = path.join(options.executionDir, "execution.sqlite");
  const runsFile = path.join(options.executionDir, "adapter.sqlite");
  let consumer: DatabaseSync | undefined;
  try {
    if (!options.consumerOwned) {
      mkdirSync(options.executionDir, { recursive: true });
      consumer = new DatabaseSync(journalFile + ".consumer");
      try {
        consumer.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      } catch {
        throw new RunnerError(
          "EXECUTOR_BUSY",
          "另一个运行器正在使用这台设备，请先关闭重复实例。",
        );
      }
    }
    const check = async () => {
      if (options.device.leases().length) throw busy();
      await options.registry.assertUnoccupied();
      let journal: DatabaseSync | undefined, runs: DatabaseSync | undefined;
      try {
        const hasJournal = exists(journalFile),
          hasRuns = exists(runsFile);
        if (hasJournal !== hasRuns) throw unknown();
        const receipts = options.device
          .commands()
          .filter((c) => c.receipt.status === "stored");
        if (!hasJournal) {
          if (
            receipts.length ||
            exists(journalFile + "-wal") ||
            exists(runsFile + "-wal")
          )
            throw unknown();
          return;
        }
        journal = new DatabaseSync(journalFile, { readOnly: true });
        runs = new DatabaseSync(runsFile, { readOnly: true });
        const state = new Map(
          journal
            .prepare("SELECT key,data FROM state")
            .all()
            .map((row) => [String(row.key), JSON.parse(String(row.data))]),
        );
        if (state.has("held")) throw busy();
        const native = new Map(
          runs
            .prepare("SELECT run_id,data FROM runs")
            .all()
            .map((row) => [String(row.run_id), JSON.parse(String(row.data))]),
        );
        for (const run of native.values())
          if (
            run?.active !== false ||
            run?.terminal !== true ||
            run.status === "reconciliation_required"
          )
            throw busy();
        const commands = journal
          .prepare("SELECT data FROM commands")
          .all()
          .map((row) => JSON.parse(String(row.data)));
        const neverSent = (
          commandId: string,
          runId: string,
          leaseEpoch: number,
        ) => {
          const seal = state.get("sealed-command:" + commandId);
          return [...state.entries()].some(
            ([key, recovery]) =>
              (key.startsWith("reconciliation-claim:") ||
                key === "reconciliation:" + runId) &&
              recovery?.settled === true &&
              recovery.claim?.runId === runId &&
              recovery.claim?.leaseEpoch === leaseEpoch &&
              seal &&
              digest(seal.claim) === digest(recovery.claim) &&
              recovery.request?.proof?.kind === "never_dispatched" &&
              digest(recovery.request.proof.claim) === digest(recovery.claim) &&
              recovery.request.proof.journal?.commandId === commandId &&
              recovery.request.report?.stopConfirmed === true,
          );
        };
        const safeCommand = (entry: any) => {
          const envelope = entry?.envelope;
          if (
            !envelope ||
            typeof envelope.runId !== "string" ||
            typeof envelope.commandId !== "string"
          )
            return false;
          if (native.has(envelope.runId)) return true;
          return (
            ["rejected", "superseded"].includes(entry.phase) ||
            neverSent(envelope.commandId, envelope.runId, envelope.leaseEpoch)
          );
        };
        if (commands.some((entry) => !safeCommand(entry))) throw busy();
        for (const { envelope } of receipts)
          if (
            !native.has(envelope.runId) &&
            !commands.some(
              (entry) =>
                entry.envelope?.commandId === envelope.commandId &&
                digest(entry.envelope) === digest(envelope) &&
                safeCommand(entry),
            )
          )
            throw unknown();
        // A run index without its command is evidence loss, not an empty device.
        for (const row of journal.prepare("SELECT key,data FROM runs").all()) {
          const record = JSON.parse(String(row.data));
          if (
            !native.has(String(row.key)) &&
            !commands.some(
              (entry) =>
                entry.envelope?.commandId === record.latest &&
                safeCommand(entry),
            )
          )
            throw unknown();
        }
      } catch (error) {
        if (error instanceof RunnerError) throw error;
        throw unknown();
      } finally {
        runs?.close();
        journal?.close();
      }
    };
    await check();
    return await work(check);
  } finally {
    consumer?.close();
  }
}
