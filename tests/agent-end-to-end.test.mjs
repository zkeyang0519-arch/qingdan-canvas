import test from "node:test";
import assert from "node:assert/strict";
import { recoveryHarness } from "./fixtures/agent-recovery-harness.mjs";

test("three source tasks run in one Codex chat and persist exactly one verified writeback per task", async t => {
  const f = await recoveryHarness(t);
  await f.create();
  await f.finish();
  await f.assertExactlyOnce();
  const proofs = f.packets.filter(packet => packet.action === "events").flatMap(packet => packet.input.events).filter(event => event.type === "verification.completed");
  assert.equal(new Set(proofs.map(event => event.turnId)).size, 3);
  assert.ok(proofs.every(event => event.payload.results.every(result => result.status === "passed" && /^[a-f0-9]{64}$/.test(result.outputHash))));
});
