import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";
const bundle = await build({
  entryPoints: [resolve("worker/execution/dispatch.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { ExecutionDispatch } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const principal = {
  ownerId: "alice",
  runnerId: "runner",
  bindingId: "binding",
  bindingRevision: 1,
  authEpoch: 1,
};
function fixture() {
  const rows = new Map(),
    reservations = new Map();
  let failKey = null,
    leases = [];
  const storage = {
    async get(key) {
      return structuredClone(rows.get(key));
    },
    async put(key, value) {
      if (typeof key === "string") rows.set(key, structuredClone(value));
      else
        for (const [k, v] of Object.entries(key))
          rows.set(k, structuredClone(v));
    },
    async delete(key) {
      if (failKey === key) {
        failKey = null;
        throw Error("injected storage failure");
      }
      return rows.delete(key);
    },
    async list({ prefix = "", limit = 1000, reverse = false } = {}) {
      let found = [...rows]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b));
      if (reverse) found.reverse();
      return new Map(structuredClone(found.slice(0, limit)));
    },
  };
  const device = {
    runner_id: "runner",
    owner_id: "alice",
    auth_epoch: 1,
    connection_epoch: 1,
    last_seen_at: Date.now(),
    revoked_at: null,
    workspaces_json: JSON.stringify([
      {
        workspaceId: "workspace",
        name: "Demo",
        revision: 1,
        checks: [],
        displayPath: "demo",
      },
    ]),
  };
  const binding = {
    binding_id: "binding",
    owner_id: "alice",
    runner_id: "runner",
    workspace_id: "workspace",
    revision: 1,
    enabled: 1,
  };
  const env = {
    DB: {
      prepare(sql) {
        let args;
        return {
          bind(...value) {
            args = value;
            return this;
          },
          async first() {
            if (sql.includes("agent_execution_requests"))
              return reservations.get(args.join(":"));
            if (sql.includes("agent_bindings")) return binding;
            if (sql.includes("agent_devices")) return device;
            throw Error(sql);
          },
          async run() {
            if (
              sql.startsWith("INSERT OR IGNORE INTO agent_execution_requests")
            )
              reservations.set(args.slice(0, 2).join(":"), {
                payload_hash: args[2],
                runner_id: args[3],
                binding_id: args[4],
              });
            return { success: true };
          },
          async all() {
            return { results: structuredClone(leases) };
          },
        };
      },
    },
  };
  const dispatch = new ExecutionDispatch(storage, env);
  const native = async (action, input) =>
    (
      await dispatch.fetch(
        new Request("https://runner/execution/native/" + action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runnerId: "runner",
            authEpoch: 1,
            input: { connectionEpoch: 1, ...input },
          }),
        }),
      )
    ).json();
  const putRun = async (
    id = "run",
    {
      terminal = false,
      envelope = true,
      status = terminal ? "verifying" : "running",
      command = "command",
    } = {},
  ) => {
    const payload = {
      type: "create_run",
      requestId: "create-" + id,
      runId: id,
      bindingId: "binding",
      bindingRevision: 1,
      kind: "task",
      snapshotId: "snapshot",
      payloadHash: "a".repeat(64),
    };
    const now = new Date().toISOString();
    const r = {
      principal,
      snapshot: { runId: id, workspaceId: "workspace", kind: "task" },
      reportCommandId: command,
      outputBytes: 0,
      truncated: false,
      view: {
        runId: id,
        bindingId: "binding",
        workspaceId: "workspace",
        kind: "task",
        status,
        threadId: "thread",
        turnId: "turn-new",
        terminal,
        stopConfirmed: terminal,
        reportRevision: 0,
        commandId: command,
        createdAt: now,
        updatedAt: now,
        lastSeq: 0,
      },
      commands: [
        {
          payload,
          receipt: {
            runId: id,
            commandId: command,
            status: "accepted",
            acceptedAt: now,
          },
          envelope: envelope
            ? {
                protocolVersion: 1,
                commandId: command,
                runId: id,
                bindingRevision: 1,
                authEpoch: 1,
                leaseEpoch: 1,
                payloadHash: "b".repeat(64),
                issuedAt: now,
                expiresAt: new Date(Date.now() + 300000).toISOString(),
                payload,
              }
            : null,
          ack: null,
          sequence: 1,
          eventFloor: 0,
        },
      ],
    };
    await storage.put("exec:run:" + id, r);
    return r;
  };
  return {
    storage,
    rows,
    native,
    dispatch,
    putRun,
    fail(key) {
      failKey = key;
    },
    lease(value) {
      leases = value;
    },
  };
}
const report = {
  runId: "run",
  commandId: "command",
  revision: 1,
  status: "verifying",
  threadId: "thread",
  turnId: "turn-new",
  terminal: true,
  stopConfirmed: true,
};

test("terminal report retries finish pending and active cleanup after either storage interruption", async () => {
  for (const failedKey of ["exec:pending:run", "exec:active"]) {
    const f = fixture();
    await f.putRun();
    await f.putRun("next", { envelope: false });
    await f.storage.put({
      "exec:pending:run": "run",
      "exec:pending:next": "next",
      "exec:active": "run",
    });
    f.fail(failedKey);
    await assert.rejects(f.native("report", report), /injected/);
    const retry = await f.native("report", report);
    assert.equal(retry.settled, true);
    assert.equal(await f.storage.get("exec:active"), undefined);
    assert.equal(await f.storage.get("exec:pending:run"), undefined);
    assert.deepEqual((await f.native("poll", {})).offers, [
      { runId: "next", workspaceId: "workspace" },
    ]);
    await f.storage.put("exec:active", "another");
    await f.native("report", report);
    assert.equal(await f.storage.get("exec:active"), "another");
  }
});
test("queued cancellation receipt retries finish cleanup without another command", async () => {
  const f = fixture();
  await f.putRun("run", { envelope: false });
  await f.storage.put("exec:pending:run", "run");
  const input = { requestId: "cancel", runId: "run" };
  f.fail("exec:pending:run");
  await assert.rejects(
    f.dispatch.tool(principal, "codex_cancel_run", input),
    /injected/,
  );
  const retry = await f.dispatch.tool(principal, "codex_cancel_run", input);
  assert.equal(retry.status, "accepted");
  assert.equal(await f.storage.get("exec:pending:run"), undefined);
  assert.equal((await f.storage.get("exec:run:run")).commands.length, 2);
});
test("delayed events and clock offsets cannot overwrite report-established current turn", async () => {
  const f = fixture();
  await f.putRun();
  const future = new Date(Date.now() + 5000);
  for (const [i, time] of [
    future.toISOString(),
    new Date(+future + 8 * 3600000).toISOString().replace("Z", "+08:00"),
  ].entries()) {
    await f.native("events", {
      events: [
        {
          protocolVersion: 1,
          eventId: "old-" + i,
          runnerId: "runner",
          runId: "run",
          threadId: "thread",
          turnId: "turn-old",
          seq: i + 1,
          occurredAt: time,
          type: "turn.started",
          payload: {},
        },
      ],
    });
  }
  const r = await f.storage.get("exec:run:run");
  assert.equal(r.view.turnId, "turn-new");
  assert.equal(r.view.status, "running");
  assert.equal(r.view.lastSeq, 2);
});
test("reply cannot overflow pending cap and active cancellation remains reachable beyond a prefix page", async () => {
  const f = fixture();
  await f.putRun("finished", { terminal: true });
  for (let i = 0; i < 100; i++)
    await f.storage.put("exec:pending:a" + String(i).padStart(3, "0"), "a" + i);
  await assert.rejects(
    f.dispatch.tool(principal, "codex_continue_run", {
      requestId: "reply",
      runId: "finished",
      expectedTurnId: "turn-new",
      message: "continue",
      mode: "reply",
    }),
    /上限/,
  );
  assert.equal((await f.storage.get("exec:run:finished")).view.terminal, true);
  const active = await f.putRun("zz-active", {
    status: "cancel_requested",
    envelope: false,
    command: "cancel",
  });
  active.commands[0].payload = {
    type: "cancel_run",
    requestId: "cancel",
    runId: "zz-active",
  };
  await f.storage.put({
    "exec:run:zz-active": active,
    "exec:pending:zz-active": "zz-active",
    "exec:active": "zz-active",
  });
  f.lease([
    {
      run_id: "zz-active",
      workspace_id: "workspace",
      lease_epoch: 1,
      expires_at: Date.now() + 60000,
    },
  ]);
  assert.equal(
    (await f.native("poll", {})).deliveries[0]?.envelope.payload.type,
    "cancel_run",
  );
});
test("stored ACK signals retired delivery, and stale terminal reports cannot authorize lease release", async () => {
  const f = fixture(),
    r = await f.putRun();
  await f.storage.put("exec:command-run:command", "run");
  await f.native("ack", { commandId: "command", status: "stored" });
  r.commands[0].settled = true;
  r.view.commandId = "next";
  r.commands.push({
    ...r.commands[0],
    receipt: { ...r.commands[0].receipt, commandId: "next" },
    settled: false,
    payload: {
      type: "continue_run",
      runId: "run",
      requestId: "next",
      mode: "steer",
      expectedTurnId: "turn-new",
      message: "new",
    },
  });
  await f.storage.put("exec:run:run", r);
  assert.equal(
    (await f.native("ack", { commandId: "command", status: "stored" }))
      .superseded,
    true,
  );
  assert.equal((await f.native("report", report)).settled, undefined);
});
