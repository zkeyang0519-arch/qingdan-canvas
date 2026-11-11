import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const fail = () => {
  throw Error(
    "Active or unknown local execution evidence prevents relocation; restore the old location and reconcile runs first. No evidence was cleared.",
  );
};
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, value]) => [k, canonical(value)]),
        )
      : v;
const digest = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const rootKey = (v) =>
  process.platform === "win32"
    ? path.resolve(v).toLowerCase()
    : path.resolve(v);
export function inside(root, file) {
  const relative = path.relative(rootKey(root), rootKey(file));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}
function info(file) {
  try {
    return lstatSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export function safeStatePath(root, file, kind = "file") {
  file = path.resolve(file);
  if (!inside(root, file)) fail();
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    const stat = info(current);
    if (stat?.isSymbolicLink()) fail();
    if (stat && current !== file && !stat.isDirectory()) fail();
  }
  const stat = info(file);
  if (stat && !(kind === "directory" ? stat.isDirectory() : stat.isFile()))
    fail();
  return Boolean(stat);
}
const rows = (db, sql) => db.prepare(sql).all();
const dataRows = (db, sql) =>
  rows(db, sql).map((row) => JSON.parse(String(row.data)));

function deviceExecutionEvidence(device) {
  if (rows(device, "SELECT data FROM leases").length) fail();
  const commands = rows(device, "SELECT data,receipt FROM commands").map(
    (row) => ({
      envelope: JSON.parse(String(row.data)),
      receipt: JSON.parse(String(row.receipt)),
    }),
  );
  if (
    commands.some(
      (entry) => !["stored", "rejected"].includes(entry.receipt?.status),
    )
  )
    fail();
  const row = device
    .prepare("SELECT data FROM metadata WHERE key='device'")
    .get();
  let currentKey;
  if (row) {
    const config = JSON.parse(String(row.data));
    if (
      typeof config?.ownerId !== "string" ||
      !config.ownerId ||
      typeof config.runnerId !== "string" ||
      !config.runnerId
    )
      fail();
    currentKey = digest([config.ownerId, config.runnerId]);
  }
  return {
    currentKey,
    receipts: commands.filter((entry) => entry.receipt.status === "stored"),
  };
}

function emptyCurrentExecutor(
  root,
  folder,
  { currentKey, receipts },
  reservationOwned = false,
) {
  if (
    !currentKey ||
    receipts.length ||
    rootKey(folder) !==
      rootKey(path.join(root, ".tmp/runner-device/execution", currentKey))
  )
    return false;
  if (!safeStatePath(root, folder, "directory")) return false;
  // An absent journal alone proves nothing. Only the current device's empty
  // directory (optionally its regular consumer lock) is known never-created.
  // Enumerating everything keeps WAL, unknown residue and non-file paths unsafe.
  return readdirSync(folder, { withFileTypes: true }).every(
    (entry) =>
      (entry.name === "execution.sqlite.consumer" ||
        (reservationOwned &&
          entry.name === "execution.sqlite.consumer-journal")) &&
      entry.isFile() &&
      !entry.isSymbolicLink(),
  );
}

export function knownNeverCreatedExecutor(root, folder) {
  let device;
  try {
    const file = path.join(root, ".tmp/runner-device/device.sqlite");
    if (!safeStatePath(root, file)) return false;
    device = new DatabaseSync(file, { readOnly: true });
    return emptyCurrentExecutor(root, folder, deviceExecutionEvidence(device));
  } catch {
    return false;
  } finally {
    device?.close();
  }
}

// Read the same evidence used by N6's reset gate, without constructing a
// DeviceStore/RunnerStore (their constructors can initialize missing schemas).
// Consumer reservations are held until every relocation publication finishes.
export async function withRelocationEvidence(root, options, work) {
  const reservations = [];
  let device;
  try {
    const base = path.join(root, ".tmp/runner-device"),
      deviceFile = path.join(base, "device.sqlite");
    const locksDir =
      options.locksDir ||
      path.join(
        process.env.LOCALAPPDATA ?? os.homedir(),
        "QingdanRunner/workspace-locks-v1",
      );
    let receipts = [],
      currentKey;
    if (safeStatePath(root, deviceFile)) {
      device = new DatabaseSync(deviceFile, { readOnly: true });
      ({ receipts, currentKey } = deviceExecutionEvidence(device));
      for (const record of dataRows(device, "SELECT data FROM workspaces")) {
        if (
          typeof record.lockRoot !== "string" ||
          !path.isAbsolute(record.lockRoot)
        )
          fail();
        // Read only the existence of a directory lock, never its owner contents.
        const key = createHash("sha256")
          .update(rootKey(record.lockRoot))
          .digest("hex");
        if (info(path.join(locksDir, key))) fail();
      }
    } else if (safeStatePath(root, deviceFile + "-wal")) fail();
    const execution = path.join(base, "execution");
    if (currentKey) {
      const currentDir = path.join(execution, currentKey);
      safeStatePath(root, currentDir, "directory");
      // As in N6, reserve even a never-created executor. Only the consumer lock
      // is created; neither execution/native journal is initialized or repaired.
      mkdirSync(currentDir, { recursive: true });
    }
    const directories = safeStatePath(root, execution, "directory")
      ? readdirSync(execution, { withFileTypes: true })
      : [];
    if (
      receipts.length &&
      !directories.some((entry) => entry.name === currentKey)
    )
      fail();
    for (const entry of directories) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
      const folder = path.join(execution, entry.name),
        journalFile = path.join(folder, "execution.sqlite"),
        runsFile = path.join(folder, "adapter.sqlite");
      const wasNeverCreated = emptyCurrentExecutor(root, folder, {
        currentKey,
        receipts,
      });
      const hadJournal = safeStatePath(root, journalFile),
        hadRuns = safeStatePath(root, runsFile);
      // Opening SQLite can recover/delete a pre-existing consumer-journal.
      // Reject dirty missing evidence before any consumer database is opened,
      // then check again under our reservation below to cover a changed state.
      if (hadJournal !== hadRuns || (!hadJournal && !wasNeverCreated)) fail();
      safeStatePath(root, journalFile + ".consumer");
      const reservation = new DatabaseSync(journalFile + ".consumer");
      reservations.push(reservation);
      reservation.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      const hasJournal = safeStatePath(root, journalFile),
        hasRuns = safeStatePath(root, runsFile);
      const stored = entry.name === currentKey ? receipts : [];
      if (hasJournal !== hasRuns) fail();
      if (!hasJournal) {
        // BEGIN EXCLUSIVE may create its own consumer-journal. It is allowed
        // only after a clean pre-lock classification, while our lock is held.
        if (
          !wasNeverCreated ||
          !emptyCurrentExecutor(root, folder, { currentKey, receipts }, true)
        )
          fail();
        continue; // Known never-created executor; do not create either journal.
      }
      let journal, nativeDb;
      try {
        journal = new DatabaseSync(journalFile, { readOnly: true });
        nativeDb = new DatabaseSync(runsFile, { readOnly: true });
        const state = new Map(
          rows(journal, "SELECT key,data FROM state").map((row) => [
            String(row.key),
            JSON.parse(String(row.data)),
          ]),
        );
        if (state.has("held")) fail();
        const native = new Map(
          rows(nativeDb, "SELECT run_id,data FROM runs").map((row) => [
            String(row.run_id),
            JSON.parse(String(row.data)),
          ]),
        );
        for (const run of native.values())
          if (
            run?.active !== false ||
            run?.terminal !== true ||
            run.status === "reconciliation_required"
          )
            fail();
        const commands = dataRows(journal, "SELECT data FROM commands");
        const safeCommand = (command) => {
          const envelope = command?.envelope;
          if (
            typeof envelope?.commandId !== "string" ||
            typeof envelope.runId !== "string"
          )
            return false;
          if (
            native.has(envelope.runId) ||
            ["rejected", "superseded"].includes(command.phase)
          )
            return true;
          const seal = state.get("sealed-command:" + envelope.commandId);
          return [...state].some(
            ([key, recovery]) =>
              (key.startsWith("reconciliation-claim:") ||
                key === "reconciliation:" + envelope.runId) &&
              recovery?.settled === true &&
              recovery.claim?.runId === envelope.runId &&
              recovery.claim?.leaseEpoch === envelope.leaseEpoch &&
              seal &&
              digest(seal.claim) === digest(recovery.claim) &&
              recovery.request?.proof?.kind === "never_dispatched" &&
              digest(recovery.request.proof.claim) === digest(recovery.claim) &&
              recovery.request.proof.journal?.commandId ===
                envelope.commandId &&
              recovery.request.report?.stopConfirmed === true,
          );
        };
        if (commands.some((command) => !safeCommand(command))) fail();
        for (const { envelope } of stored)
          if (
            !native.has(envelope.runId) &&
            !commands.some(
              (command) =>
                command.envelope?.commandId === envelope.commandId &&
                digest(command.envelope) === digest(envelope) &&
                safeCommand(command),
            )
          )
            fail();
        for (const row of rows(journal, "SELECT key,data FROM runs")) {
          const record = JSON.parse(String(row.data));
          if (
            !native.has(String(row.key)) &&
            !commands.some(
              (command) =>
                command.envelope?.commandId === record.latest &&
                safeCommand(command),
            )
          )
            fail();
        }
      } finally {
        nativeDb?.close();
        journal?.close();
      }
    }
    return await work();
  } catch (error) {
    if (/relocation|publication|repair/i.test(error.message)) throw error;
    fail();
  } finally {
    device?.close();
    for (const reservation of reservations) reservation.close();
  }
}

export function relocatedLedger(root, oldRoot) {
  const file = path.join(root, ".tmp/agent-experience/sessions.json");
  if (!safeStatePath(root, file)) return null;
  const before = JSON.parse(readFileSync(file, "utf8")),
    after = structuredClone(before);
  if (
    before.version !== 1 ||
    !before.sessions ||
    typeof before.sessions !== "object" ||
    Array.isArray(before.sessions)
  )
    fail();
  for (const [id, entry] of Object.entries(after.sessions)) {
    if (
      !/^[a-f0-9-]{36}$/i.test(id) ||
      entry.id !== id ||
      !["passed", "failed"].includes(entry.status)
    )
      fail();
    const oldPath = path.join(oldRoot, ".tmp/agent-experience/projects", id),
      newPath = path.join(root, ".tmp/agent-experience/projects", id);
    if (entry.workspace !== oldPath && entry.workspace !== newPath) fail();
    const journalFile = newPath + ".runner/runner.sqlite";
    if (!safeStatePath(root, journalFile)) fail();
    let db;
    try {
      db = new DatabaseSync(journalFile, { readOnly: true });
      for (const run of dataRows(db, "SELECT data FROM runs"))
        if (
          run?.active !== false ||
          run?.terminal !== true ||
          run.status === "reconciliation_required"
        )
          fail();
    } finally {
      db?.close();
    }
    entry.workspace = newPath;
  }
  return { before, after };
}
