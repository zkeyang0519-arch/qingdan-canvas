import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
let api;
try {
  const b = await build({
    entryPoints: ["worker/execution/checklist-writeback.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  api = await import(
    "data:text/javascript;base64," +
      Buffer.from(b.outputFiles[0].text).toString("base64")
  );
} catch (error) {
  test("checklist completion bridge loads", () => assert.fail(error.message));
}
const principal = {
  ownerId: "alice",
  runnerId: "runner",
  bindingId: "binding",
  bindingRevision: 1,
  authEpoch: 1,
};
function fixture() {
  const rows = new Map(),
    calls = [],
    receipts = new Set();
  let clock = 100000,
    fail = false,
    failSave = false,
    mode = "applied",
    writes = 0;
  const storage = {
    async get(k) {
      return structuredClone(rows.get(k));
    },
    async put(k, v) {
      if (
        failSave &&
        typeof k === "object" &&
        Object.hasOwn(k, "exec:writebacks:run")
      ) {
        failSave = false;
        throw Error("lost local save");
      }
      if (typeof k === "string") {
        if (failSave && k === "exec:writebacks:run") {
          failSave = false;
          throw Error("lost local save");
        }
        rows.set(k, structuredClone(v));
      } else
        for (const [key, value] of Object.entries(k))
          rows.set(key, structuredClone(value));
    },
    async delete(k) {
      return rows.delete(k);
    },
    async list({ prefix = "", limit = 1000 }) {
      return new Map(
        [...rows]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .slice(0, limit)
          .map(([k, v]) => [k, structuredClone(v)]),
      );
    },
    async setAlarm(t) {
      rows.set("alarm", t);
    },
  };
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          async first() {
            return sql.includes("agent_bindings")
              ? {
                  canvas_id: "canvas",
                  section_id: "section",
                  workspace_id: "workspace",
                }
              : {
                  workspaces_json: JSON.stringify([
                    { workspaceId: "workspace" },
                  ]),
                };
          },
        };
      },
    },
    ROOMS: {
      idFromName(id) {
        assert.equal(id, "canvas");
        return id;
      },
      get() {
        return {
          async fetch(url, init) {
            assert.equal(
              url,
              "https://canvas.internal/internal/agent-checklist",
            );
            const body = JSON.parse(init.body);
            assert.deepEqual(body.principal, principal);
            calls.push(body.input);
            if (fail)
              return Response.json(
                { error: "temporary unavailable" },
                { status: 503 },
              );
            if (mode === "forbidden")
              return Response.json({ error: "revoked" }, { status: 403 });
            if (!receipts.has(body.input.requestId) && mode === "applied") {
              receipts.add(body.input.requestId);
              writes++;
            }
            return Response.json({
              status: mode,
              message: mode === "conflict" ? "待办已改变" : undefined,
            });
          },
        };
      },
    },
  };
  const source = {
    taskRef: { canvasId: "canvas", noteId: "note", taskId: "task" },
    generation: 1,
    specRevision: 1,
  };
  const run = {
    principal,
    snapshot: {
      kind: "task",
      runId: "run",
      batch: {
        autoComplete: true,
        items: [{ taskId: "task", text: "原待办", source }],
      },
    },
    view: {
      runId: "run",
      status: "verifying",
      batch: {
        currentIndex: 0,
        items: [
          {
            taskId: "task",
            text: "原待办",
            status: "done",
            summary: "已完成",
            completedTurnId: "turn-1",
          },
        ],
      },
    },
  };
  const open = () => new api.ChecklistWritebacks(storage, env, () => clock);
  return {
    rows,
    storage,
    env,
    run,
    calls,
    open,
    advance(ms = 120000) {
      clock += ms;
    },
    fail(v) {
      fail = v;
    },
    failSave() {
      failSave = true;
    },
    mode(v) {
      mode = v;
    },
    get writes() {
      return writes;
    },
  };
}
if (api) {
  test("a valid done receipt marks only its immutable real task once", async () => {
    const f = fixture(),
      bridge = f.open();
    await f.storage.put(await bridge.stage(f.run));
    await bridge.flushRun("run");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].source.taskRef.noteId, "note");
    assert.equal(f.calls[0].completedTurnId, "turn-1");
    assert.equal(f.writes, 1);
    assert.equal(
      (await bridge.decorate(f.run)).batch.items[0].writeback.status,
      "applied",
    );
    await bridge.flushRun("run");
    await f.storage.put(await bridge.stage(f.run));
    await bridge.flushRun("run");
    assert.equal(f.calls.length, 1);
  });
  test("missing completion proof, cancellation and opt-out never create completion jobs", async () => {
    for (const kind of ["proof", "cancel", "opt-out"]) {
      const f = fixture();
      if (kind === "proof") delete f.run.view.batch.items[0].completedTurnId;
      else if (kind === "cancel") f.run.view.status = "cancelled";
      else f.run.snapshot.batch.autoComplete = false;
      const bridge = f.open();
      assert.deepEqual(await bridge.stage(f.run), {});
      await bridge.retryDue();
      assert.equal(f.calls.length, 0);
    }
  });
  test("writeback survives transient failure and process replacement without rerunning the task", async () => {
    const f = fixture();
    f.fail(true);
    await f.storage.put(await f.open().stage(f.run));
    await f.open().flushRun("run");
    assert.equal(
      (await f.open().decorate(f.run)).batch.items[0].writeback.status,
      "pending",
    );
    f.fail(false);
    f.advance();
    await f.open().retryDue();
    assert.equal(f.writes, 1);
    assert.equal(f.calls[0].requestId, f.calls[1].requestId);
  });
  test("changed or unauthorized checklist tasks are preserved and not retried forever", async () => {
    for (const state of ["conflict", "forbidden"]) {
      const f = fixture();
      f.mode(state);
      const bridge = f.open();
      await f.storage.put(await bridge.stage(f.run));
      await bridge.flushRun("run");
      assert.equal(f.writes, 0);
      assert.equal(
        (await bridge.decorate(f.run)).batch.items[0].writeback.status,
        state === "conflict" ? "conflict" : "failed",
      );
      f.advance();
      await bridge.retryDue();
      assert.equal(f.calls.length, 1);
    }
  });
  test("lost writeback acknowledgement retries the same receipt without checking a task twice", async () => {
    const f = fixture(),
      bridge = f.open();
    await f.storage.put(await bridge.stage(f.run));
    f.failSave();
    await assert.rejects(bridge.flushRun("run"));
    f.advance();
    await f.open().retryDue();
    assert.equal(f.calls.length, 2);
    assert.equal(f.writes, 1);
    assert.equal(f.calls[0].requestId, f.calls[1].requestId);
  });
  test("writeback retry and heartbeat share the earlier alarm", async () => {
    const f = fixture();
    await f.storage.put("state", { lastHeartbeat: Date.now() });
    await f.storage.put("exec:writeback-next", Date.now() + 2000);
    await api.scheduleExecutionAlarm(f.storage);
    assert.ok(f.rows.get("alarm") < Date.now() + 5000);
  });

  test("one retry invocation processes at most one completion so cancellation stays responsive", async () => {
    const f = fixture(),
      bridge = f.open();
    const task = f.run.snapshot.batch.items[0],
      progress = f.run.view.batch.items[0];
    f.run.snapshot.batch.items = [1, 2, 3].map((n) => ({
      ...structuredClone(task),
      taskId: `task-${n}`,
      source: {
        ...task.source,
        taskRef: { ...task.source.taskRef, taskId: `task-${n}` },
      },
    }));
    f.run.view.batch.items = [1, 2, 3].map((n) => ({
      ...progress,
      taskId: `task-${n}`,
    }));
    await f.storage.put(await bridge.stage(f.run));
    await bridge.flushRun("run");
    assert.equal(f.calls.length, 1);
    await bridge.retryDue();
    assert.equal(f.calls.length, 2);
    await bridge.retryDue();
    assert.equal(f.calls.length, 3);
  });

  test("an earlier due writeback is not starved behind more than a hundred later run IDs", async () => {
    const f = fixture(),
      bridge = f.open();
    for (let i = 0; i < 110; i++) {
      const run = structuredClone(f.run);
      run.view.runId = run.snapshot.runId = `a-${String(i).padStart(3, "0")}`;
      await f.storage.put(await bridge.stage(run));
    }
    f.advance(-100000);
    const first = structuredClone(f.run);
    first.view.runId = first.snapshot.runId = "z-earliest";
    await f.storage.put(await bridge.stage(first));
    await bridge.retryDue();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].runId, "z-earliest");
  });
}
