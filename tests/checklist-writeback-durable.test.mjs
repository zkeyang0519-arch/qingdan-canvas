import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { checklistWritebackFixture } from "./fixtures/checklist-writeback-durable-harness.mjs";

test("Runner and real DO restart recover the original completion receipt by alarm without rechecking a user-reopened task", { timeout: 30000 }, async t => {
  const f = await checklistWritebackFixture(t);
  const { runId } = await f.create();
  await f.until(async () => (await f.state()).rows[`exec:writebacks:${runId}`]?.entries[0].status === "pending");
  const before = await f.state();
  const queue = before.rows[`exec:writebacks:${runId}`];
  const entry = queue.entries[0];
  const run = before.rows[`exec:run:${runId}`];
  const proofKey = `exec:queue-proof:${runId}:${entry.completedTurnId}:verification.completed`;
  const proof = before.rows[proofKey];
  assert.equal(entry.attempts, 1);
  assert.equal(before.alarmRuns, 0);
  assert.equal(before.alarm, entry.nextAt);
  assert.equal(proof.runId, runId);
  assert.equal(proof.threadId, run.view.threadId);
  assert.equal(proof.turnId, entry.completedTurnId);
  assert.equal(proof.payload.results[0].status, "passed");
  assert.equal(proof.payload.results[0].outputHash, createHash("sha256").update("accepted-output\n").digest("hex"));
  assert.deepEqual(f.runs.getRun(runId).verification.results, proof.payload.results);
  const committed = await f.canvas();
  assert.equal(committed.task.done, true);
  assert.equal(committed.calls.length, 1);
  assert.equal(committed.calls[0].result.status, "applied");
  const nativeBefore = await f.nativeState();
  assert.equal(nativeBefore.calls.filter(call => call.method === "turn/start").length, 1);

  await f.reopenTask();
  const reopened = await f.canvas();
  assert.equal(reopened.task.done, false);
  await f.restartOffline();
  assert.deepEqual(f.runs.getRun(runId).verification.results, proof.payload.results);
  const packetCount = f.packets.length;
  // Only read fixture state while Runner is offline. No poll, batch-gate,
  // rewritten nextAt or direct retry call can cause the pending write to run.
  let recovered;
  await f.waitFor(async () => {
    recovered = await f.state();
    return recovered.rows[`exec:writebacks:${runId}`].entries[0].status === "applied";
  });
  assert.ok(recovered.alarmRuns >= 1);
  assert.equal(f.packets.length, packetCount);
  assert.equal(recovered.rows[`exec:writebacks:${runId}`].entries[0].requestId, entry.requestId);
  assert.deepEqual(recovered.rows[proofKey], proof);
  const replayed = await f.canvas();
  assert.equal(replayed.calls.length, 2);
  assert.deepEqual(replayed.calls[1], replayed.calls[0]);
  assert.equal(replayed.task.done, false);
  assert.equal(replayed.sequence, reopened.sequence);

  await f.reconnect();
  await f.until(async () => (await f.state()).rows[`exec:run:${runId}`].view.queue.phase === "completed" && !f.executor.hasHold);
  const after = await f.state(), nativeAfter = await f.nativeState();
  assert.equal(after.rows[`exec:run:${runId}`].view.stopConfirmed, true);
  assert.deepEqual(after.rows[proofKey], proof);
  assert.equal(nativeAfter.calls.filter(call => call.method === "thread/start").length, 1);
  assert.equal(nativeAfter.calls.filter(call => call.method === "turn/start").length, 1);
  assert.ok(nativeAfter.calls.filter(call => call.method === "initialize").length > nativeBefore.calls.filter(call => call.method === "initialize").length);
  assert.equal(await f.lease(), null);
  const final = await f.canvas();
  assert.equal(final.task.done, false);
  assert.equal(final.sequence, reopened.sequence);
  assert.equal(final.calls.length, 2);
});
