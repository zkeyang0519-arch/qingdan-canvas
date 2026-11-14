import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
let acquireInstance;
try {
  ({ acquireInstance } = await import("../instance.mjs"));
} catch {}
test("kernel-backed single instance exists", () =>
  assert.equal(typeof acquireInstance, "function"));
if (acquireInstance) {
  async function dir(t) {
    const p = await mkdtemp(path.join(os.tmpdir(), "qd-connector-instance-"));
    t.after(() => rm(p, { recursive: true, force: true }));
    return p;
  }
  test("repeated launch reuses the live instance without a second owner", async (t) => {
    const d = await dir(t),
      first = await acquireInstance(d);
    t.after(() => first.release());
    await first.publish("http://127.0.0.1:50001", "a".repeat(64));
    const second = await acquireInstance(d, { probe: async () => true });
    assert.equal(second.existing.instanceId, first.instanceId);
    assert.equal(second.existing.token, "a".repeat(64));
    assert.equal(second.release, undefined);
  });
  test("stale runtime after process death does not block a new kernel owner", async (t) => {
    const d = await dir(t);
    await writeFile(
      path.join(d, "runtime.json"),
      JSON.stringify({ pid: 123, instanceId: "stale" }),
    );
    const first = await acquireInstance(d);
    t.after(() => first.release());
    await first.publish("http://127.0.0.1:50002", "b".repeat(64));
    assert.notEqual(
      JSON.parse(await readFile(path.join(d, "runtime.json"), "utf8"))
        .instanceId,
      "stale",
    );
  });
  test("unresponsive existing instance is reported, never overwritten or killed", async (t) => {
    const d = await dir(t),
      first = await acquireInstance(d);
    t.after(() => first.release());
    await first.publish("http://127.0.0.1:50003", "c".repeat(64));
    await assert.rejects(
      () => acquireInstance(d, { probe: async () => false, waitMs: 100 }),
      (e) => e.code === "INSTANCE_BUSY",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(d, "runtime.json"), "utf8"))
        .instanceId,
      first.instanceId,
    );
  });
  test("release removes only this instance metadata and unlocks next launch", async (t) => {
    const d = await dir(t),
      first = await acquireInstance(d);
    await first.publish("http://127.0.0.1:50004", "d".repeat(64));
    await first.release();
    await assert.rejects(
      () => readFile(path.join(d, "runtime.json"), "utf8"),
      (e) => e.code === "ENOENT",
    );
    const next = await acquireInstance(d);
    t.after(() => next.release());
    assert.notEqual(next.instanceId, first.instanceId);
  });
}
