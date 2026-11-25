import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const { outputFiles } = await build({
  stdin: {
    contents:
      "export { ExecutionRetentionOutbox } from './worker/execution/retention-outbox';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const { ExecutionRetentionOutbox } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
function fixture() {
  const data = new Map(),
    delivered = [];
  const storage = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => {
      if (typeof key === "string") data.set(key, structuredClone(value));
      else
        for (const [k, v] of Object.entries(key))
          data.set(k, structuredClone(v));
    },
    delete: async (key) => data.delete(key),
    list: async ({ prefix = "", reverse, limit = Infinity } = {}) =>
      new Map(
        [...data]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) =>
            reverse ? b.localeCompare(a) : a.localeCompare(b),
          )
          .slice(0, limit)
          .map(([key, value]) => [key, structuredClone(value)]),
      ),
  };
  let unavailable = false;
  const env = {
    CHAT_ENABLED: "true",
    AGENT_CHATS: {
      idFromName: (value) => value,
      get: (owner) => ({
        executionRetentionResult: async (value) => {
          assert.equal(owner, "owner");
          if (unavailable) throw Error("offline");
          delivered.push(value);
          return { ok: true };
        },
      }),
    },
  };
  const run = {
    principal: { ownerId: "owner", bindingId: "binding" },
    snapshot: { kind: "task", task: { instruction: "完成并验证任务" } },
    view: {
      runId: "run",
      turnId: "turn",
      reportRevision: 3,
      terminal: true,
      stopConfirmed: true,
      status: "succeeded",
      output: "已修复并运行检查",
    },
  };
  const completion = {
    eventId: "completion",
    type: "turn.completed",
    turnId: "turn",
    payload: { status: "completed", output: run.view.output },
  };
  const verification = {
    eventId: "verification",
    type: "verification.completed",
    turnId: "turn",
    payload: { results: [{ status: "passed" }] },
  };
  data.set("exec:run:run", run);
  data.set("exec:event:run:001", verification);
  data.set("exec:event:run:002", completion);
  const outbox = new ExecutionRetentionOutbox(storage, env);
  const due = () => {
    for (const [key, entry] of data)
      if (key.startsWith("exec:retention-pending:")) entry.nextAt = 0;
  };
  return {
    storage,
    data,
    delivered,
    run,
    completion,
    verification,
    outbox,
    due,
    reopen: () => new ExecutionRetentionOutbox(storage, env),
    offline: (value) => {
      unavailable = value;
    },
  };
}
test("native task review waits for terminal stop, survives delivery failure and deduplicates", async () => {
  const f = fixture();
  for (const view of [
    { terminal: false },
    { stopConfirmed: false },
    { status: "failed" },
  ])
    assert.deepEqual(
      await f.outbox.stage({ ...f.run, view: { ...f.run.view, ...view } }),
      {},
    );
  await f.storage.put(await f.outbox.stage(f.run));
  f.due();
  f.offline(true);
  await f.outbox.flush();
  assert.equal(f.delivered.length, 0);
  assert.equal(f.data.get("exec:retention-pending:run").attempts, 1);
  f.offline(false);
  f.due();
  await f.reopen().flush();
  assert.equal(f.delivered.length, 1);
  assert.deepEqual(f.delivered[0].report.verifiedEvidenceIds, ["verification"]);
  assert.deepEqual(await f.outbox.stage(f.run), {});
  await f.outbox.flush();
  assert.equal(f.delivered.length, 1);
});
test("output alone and failed verification stay suggestions; unrelated turns cannot confer evidence", async () => {
  for (const kind of ["missing", "failed", "unrelated"]) {
    const f = fixture();
    if (kind === "missing") f.data.delete("exec:event:run:001");
    if (kind === "failed") f.verification.payload.results[0].status = "failed";
    if (kind === "unrelated") f.verification.turnId = "other-turn";
    await f.storage.put(await f.outbox.stage(f.run));
    f.due();
    await f.outbox.flush();
    assert.equal(f.delivered.length, 1);
    assert.deepEqual(f.delivered[0].report.verifiedEvidenceIds, []);
  }
});
