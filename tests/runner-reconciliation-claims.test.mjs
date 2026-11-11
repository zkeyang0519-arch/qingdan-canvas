import test from "node:test";
import assert from "node:assert/strict";
import { recoveryHarness } from "./fixtures/agent-recovery-harness.mjs";
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const starts = state => state.calls.filter(call => call.method === "turn/start");
const cancel = f => f.dispatch.tool(f.principal, "codex_cancel_run", { runId: f.runId, requestId: crypto.randomUUID() });
const reply = (f, turnId, message = "Authorized new reply") => f.dispatch.tool(f.principal, "codex_continue_run", {
  runId: f.runId, requestId: crypto.randomUUID(), mode: "reply", expectedTurnId: turnId, message,
});

for (const reopen of [false, true]) test(`public non-batch reply after reconciliation runs under its new claim${reopen ? " after SQLite reopen" : ""}`, async t => {
  const f = await recoveryHarness(t, { mode: "hang" });
  await f.create({ batch: false });
  await f.until(() => f.journal.latest(f.runId)?.phase === "applied");
  const firstClaim = f.journal.held(), firstTurn = f.runs.getRun(f.runId).activeTurnId;
  await cancel(f);
  await f.executor.reconcileHeldRun();
  assert.equal(f.executor.hasHold, false);
  assert.equal((await f.view()).status, "cancelled");
  const oldConfirm = f.packets.find(p => p.action === "reconcile" && p.input.phase === "confirm");
  assert.ok(oldConfirm.result.settled);
  if (reopen) await f.restart();
  const continued = await reply(f, firstTurn);
  for (let n = 0; n < 6; n++) await f.tick();
  const native = await f.nativeState(), secondClaim = f.journal.held();
  assert.equal(starts(native).length, 2, "a new authorized reply must start exactly one new turn");
  assert.equal(native.threads.length, 1);
  assert.equal(secondClaim.leaseEpoch, 2);
  assert.notEqual(secondClaim.lockToken, firstClaim.lockToken);
  assert.equal(f.journal.command(continued.commandId).phase, "applied");
  assert.equal((await f.view()).status, "running");
  // An exact old receipt remains replayable, but cannot settle/release the new
  // claim. The second cancellation needs its own proof and original command.
  assert.deepEqual(await f.native("reconcile", oldConfirm.input), oldConfirm.result);
  await f.tick();
  assert.equal(f.executor.hasHold, true);
  assert.equal(f.controller.store.lease(f.runId).leaseEpoch, 2);
  await cancel(f);
  await f.executor.reconcileHeldRun();
  assert.equal(f.executor.hasHold, false);
  const confirmations = f.packets.filter(p => p.action === "reconcile" && p.input.phase === "confirm");
  assert.equal(confirmations.at(-1).input.proof.claim.leaseEpoch, 2);
  assert.equal(confirmations.at(-1).input.proof.journal.commandId, continued.commandId);
  assert.notEqual(confirmations.at(-1).input.requestId, oldConfirm.input.requestId);
  assert.equal(starts(await f.nativeState()).length, 2);
});

test("legacy recovery and manual intent replay only for their original claim after SQLite reopen", async t => {
  const f = await recoveryHarness(t, { mode: "hang" });
  await f.create({ batch: false });
  await f.until(() => f.journal.latest(f.runId)?.phase === "applied");
  const claim = f.journal.held(), turnId = f.runs.getRun(f.runId).activeTurnId;
  await cancel(f);
  f.loseReply((action, input) => action === "reconcile" && input.phase === "confirm");
  await f.executor.reconcileHeldRun();
  assert.equal(f.executor.hasHold, true);
  const recovery = f.journal.reconciliation(claim);
  const db = new DatabaseSync(f.journalPath);
  try {
    db.prepare("INSERT OR REPLACE INTO state VALUES (?,?)").run(`reconciliation:${f.runId}`, JSON.stringify(recovery));
    db.prepare("INSERT OR REPLACE INTO state VALUES (?,?)").run(`manual-reconciliation:${f.runId}`, "true");
    db.prepare("DELETE FROM state WHERE key LIKE 'reconciliation-claim:%'").run();
  } finally { db.close(); }
  await f.restart();
  await f.until(() => !f.executor.hasHold);
  const attempts = f.packets.filter(p => p.action === "reconcile" && p.input.phase === "confirm");
  assert.deepEqual(attempts.at(-1).input, attempts[0].input);
  await reply(f, turnId);
  await f.until(() => startsFromRun(f) === 2);
  assert.equal(starts(await f.nativeState()).length, 2);
  assert.equal((await f.view()).status, "running");
  assert.equal(f.controller.store.lease(f.runId).leaseEpoch, 2);
  assert.ok(f.journal.reconciliation(claim).settled, "historical proof remains available by claim");
});

const startsFromRun = f => f.runs.getRun(f.runId)?.activeTurnId === "thread-1-turn-2" ? 2 : 1;

test("a legacy manual intent without recovery clears after ordinary report settlement before a new reply", async t => {
  const f = await recoveryHarness(t);
  await f.create({ batch: false });
  f.loseReply((action, input) => action === "report" && input.stopConfirmed);
  await f.until(() => !f.online);
  const claim = f.journal.held(), turnId = f.runs.getRun(f.runId).activeTurnId;
  assert.equal(f.journal.reconciliation(claim), undefined);
  const db = new DatabaseSync(f.journalPath);
  try {
    db.prepare("INSERT OR REPLACE INTO state VALUES (?,?)").run(`manual-reconciliation:${f.runId}`, "true");
  } finally { db.close(); }
  await f.restart();
  await f.until(() => !f.executor.hasHold);
  assert.equal(f.packets.filter(p => p.action === "reconcile").length, 0, "ordinary completion keeps its report path");
  f.setMode("hang");
  await f.restart();
  await reply(f, turnId);
  const nextClaim = await f.stageOffer();
  assert.equal(f.journal.reconciliationRequested(nextClaim), false, "ordinary release must retire the old manual intent before the next claim");
  for (let n = 0; n < 6; n++) await f.tick();
  assert.equal(starts(await f.nativeState()).length, 2, "the old manual intent must not seal the new reply");
  assert.equal((await f.view()).status, "running");
  const current = f.journal.held();
  assert.equal(current.leaseEpoch, 2);
  f.journal.requestReconciliation(current);
  f.journal.clearReconciliationRequest(claim);
  assert.equal(f.journal.reconciliationRequested(current), true, "old cleanup cannot clear a new claim's manual intent");
  f.journal.clearReconciliationRequest(current);
});

test("a late old resume callback and stop guard cannot borrow a new staged claim for the same run", async t => {
  const f = await recoveryHarness(t, { mode: "hang", requestTimeoutMs: 8000 });
  await f.create({ batch: false });
  await f.until(() => f.journal.latest(f.runId)?.phase === "applied");
  const originalTurn = f.runs.getRun(f.runId).activeTurnId;
  await cancel(f);
  await f.executor.reconcileHeldRun();
  await writeFile(path.join(f.base, "native.json.hold-resume"), "hold");
  const oldReply = await reply(f, originalTurn, "reply that will be sealed before it sends a turn");
  const oldTick = f.tick();
  let nextClaim;
  try {
    for (let n = 0; n < 150 && !(await f.nativeState()).heldResume; n++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await f.nativeState()).heldResume, true);
    const oldClaim = f.journal.held(), oldGuard = f.executor.captureNativeGuard(f.runId);
    await cancel(f);
    await f.executor.reconcileHeldRun();
    assert.equal(f.executor.hasHold, false);
    await reply(f, originalTurn, "new reply under an independent claim");
    nextClaim = await f.stageOffer();
    assert.equal(nextClaim.leaseEpoch, 3);
    assert.notEqual(nextClaim.lockToken, oldClaim.lockToken);
    assert.throws(() => oldGuard.assertDispatch(), { code: "LEASE_MISMATCH" });
    assert.throws(() => oldGuard.canStop(), { code: "LEASE_MISMATCH" });
    assert.ok(f.journal.reconciliation(oldClaim).settled);
  } finally {
    await writeFile(path.join(f.base, "native.json.release-resume"), "release");
    await oldTick;
  }
  assert.equal(starts(await f.nativeState()).length, 1, "late old callback must not dispatch");
  assert.equal(f.journal.held().lockToken, nextClaim.lockToken);
  assert.equal(f.runs.getRun(f.runId).status, "cancelled", "late failure must not poison the new claim");
  await f.until(() => startsFromRun(f) === 2);
  assert.equal((await f.view()).status, "running");
  const state = await f.nativeState();
  assert.equal(starts(state).length, 2);
  const oldRequestId = f.journal.command(oldReply.commandId).envelope.payload.requestId;
  assert.ok(starts(state).every(call => call.params.clientUserMessageId !== oldRequestId));
  assert.equal(f.controller.store.lease(f.runId).leaseEpoch, 3);
});
