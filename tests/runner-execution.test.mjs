import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { makeSnapshot } from "./fixtures/agent-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const dir = await mkdtemp(path.join(root, ".tmp/runner-execution-test-"));
test.after(() => rm(dir, { recursive: true, force: true }));
let api;
try {
  await build({
    stdin: {
      contents: [
        "executor",
        "execution-store",
        "store",
        "device-store",
        "workspaces",
        "workspace",
        "transport",
        "device-controller",
      ]
        .map((file) => "export * from './runner/" + file + ".ts';")
        .concat(
          "export { ExecutionDispatch } from './worker/execution/dispatch.ts';",
        )
        .join(""),
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: path.join(dir, "api.mjs"),
    logLevel: "silent",
  });
  api = await import(pathToFileURL(path.join(dir, "api.mjs")));
} catch (error) {
  test("native execution can be loaded", () => assert.fail(error.message));
}

if (api) {
  async function fixture(t, mode = "normal") {
    const base = await mkdtemp(path.join(dir, "case-"));
    const workspace = path.join(base, "project");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-q"]);
    const baseline = await api.readGitBaseline(workspace);
    const device = new api.DeviceStore(path.join(base, "device.sqlite"));
    const registry = new api.WorkspaceRegistry(device, {
      locksDir: path.join(base, "locks"),
    });
    const { workspaceId } = await registry.register({
      root: workspace,
      checks: [{ checkId: "test", label: "Test" }],
    });
    const statePath = path.join(base, "fake.json");
    let now = Date.now(),
      epoch = 0,
      current = null,
      online = true;
    const reports = [],
      acks = [],
      events = [],
      releases = [],
      contexts = [],
      eventPages = [];
    let failReport = false,
      superseded = false,
      ignoreTerminal = false,
      partialEventAck = false;
    let onStored = () => {},
      dispatchRequest;
    let revoked = false;
    const transport = {
      get status() {
        return {
          connectionStatus: online ? "online" : "offline",
          connectionEpoch: 1,
        };
      },
      async executionRequest(action, body) {
        if (dispatchRequest) return dispatchRequest(action, body);
        if (revoked && action !== "poll")
          throw Object.assign(Error("binding revoked"), {
            code: "EXECUTION_REVOKED",
          });
        if (action === "poll")
          return !current
            ? { offers: [], deliveries: [] }
            : device.lease(current.envelope.runId)
              ? { offers: [], deliveries: [current] }
              : {
                  offers: [{ runId: current.envelope.runId, workspaceId }],
                  deliveries: [],
                };
        if (action === "ack") {
          acks.push(body);
          if (body.status === "stored") onStored();
          if (superseded && body.status === "stored")
            return { ok: true, superseded: true };
        }
        if (action === "report") {
          if (failReport) throw Error("report lost");
          reports.push(body);
          if (body.stopConfirmed)
            return ignoreTerminal
              ? { ok: true, ignored: true }
              : { ok: true, settled: true };
        }
        if (action === "events") {
          events.push(...body.events);
          eventPages.push(body.events);
          return {
            eventIds: (partialEventAck
              ? body.events.slice(0, 1)
              : body.events
            ).map((e) => e.eventId),
          };
        }
        if (action === "context") contexts.push(...body.contexts);
        return { ok: true };
      },
      async acceptExecutionEnvelope() {
        return { status: "stored" };
      },
      async claimLease(workspaceId, runId) {
        const existing = device.lease(runId);
        if (existing) return existing;
        const lease = {
          workspaceId,
          runId,
          leaseEpoch: ++epoch,
          expiresAt: now + 60_000,
        };
        device.saveLease(lease);
        return lease;
      },
      async releaseLease(id, runId, confirmedStopped) {
        assert.equal(id, workspaceId);
        assert.equal(confirmedStopped, true);
        releases.push(runId);
        device.removeLease(workspaceId);
        current = null;
      },
    };
    let runner, journal, executor;
    function open() {
      const dbPath = path.join(base, "adapter.sqlite");
      runner = new api.RunnerStore(dbPath);
      journal = new api.ExecutionStore(path.join(base, "execution.sqlite"));
      executor = new api.RunnerExecutor({
        store: journal,
        runs: runner,
        device,
        registry,
        transport: () => transport,
        runnerId: "runner-a",
        ownerId: "owner-a",
        authEpoch: 1,
        now: () => now,
        codex: {
          command: process.execPath,
          args: [path.join(root, "tests/fixtures/fake-codex.mjs")],
          env: {
            ...process.env,
            FAKE_CODEX_STATE: statePath,
            FAKE_CODEX_MODE: mode,
            FAKE_RUNNER_DB: dbPath,
          },
          requestTimeoutMs: 900,
          shutdownTimeoutMs: 300,
        },
      });
      return executor;
    }
    open();
    t.after(async () => {
      await executor.close();
      journal.close();
      runner.close();
      device.close();
    });
    function delivery(
      payload = { type: "create_run" },
      extra = {},
      runId = "run-a",
    ) {
      const snapshot = makeSnapshot({ runId, workspaceId, ...extra });
      snapshot.context.gitBaseline = baseline;
      snapshot.payloadHash = api.digest({
        ...snapshot,
        payloadHash: undefined,
      });
      const commandId = payload.commandId ?? "command-" + payload.type;
      const { commandId: _, ...input } = payload;
      const command = {
        runId,
        requestId: "request-" + commandId,
        ...(input.type === "create_run"
          ? {
              kind: snapshot.kind,
              bindingId: snapshot.bindingId,
              bindingRevision: snapshot.bindingRevision,
              snapshotId: snapshot.snapshotId,
              payloadHash: snapshot.payloadHash,
            }
          : {}),
        ...input,
      };
      const envelope = {
        protocolVersion: 1,
        commandId,
        runId,
        authEpoch: 1,
        bindingRevision: snapshot.bindingRevision,
        leaseEpoch: device.lease(runId)?.leaseEpoch ?? epoch + 1,
        payloadHash: api.digest(command),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        payload: command,
      };
      return { envelope, snapshot };
    }
    return {
      get executor() {
        return executor;
      },
      get runner() {
        return runner;
      },
      get journal() {
        return journal;
      },
      device,
      registry,
      workspaceId,
      workspace,
      reports,
      acks,
      events,
      releases,
      contexts,
      eventPages,
      base,
      delivery,
      useDispatch(intercept) {
        const principal = {
          ownerId: "owner-a",
          runnerId: "runner-a",
          bindingId: "binding-a",
          bindingRevision: 1,
          authEpoch: 1,
        };
        const rows = new Map(),
          requests = new Map();
        const dispatch = new api.ExecutionDispatch(
          {
            async get(key) {
              return structuredClone(rows.get(key));
            },
            async put(key, value) {
              for (const [name, row] of Object.entries(
                typeof key === "string" ? { [key]: value } : key,
              ))
                rows.set(name, structuredClone(row));
            },
            async delete(key) {
              return rows.delete(key);
            },
            async list({ prefix, limit }) {
              return new Map(
                structuredClone(
                  [...rows]
                    .filter(([key]) => key.startsWith(prefix))
                    .sort(([a], [b]) => a.localeCompare(b))
                    .slice(0, limit),
                ),
              );
            },
          },
          {
            DB: {
              prepare(sql) {
                return {
                  bind: (...args) => ({
                    async first() {
                      if (sql.includes("agent_execution_requests"))
                        return requests.get(args.join(":"));
                      if (sql.includes("agent_bindings"))
                        return {
                          canvas_id: "canvas-a",
                          workspace_id: workspaceId,
                        };
                      if (sql.includes("agent_devices"))
                        return {
                          runner_id: principal.runnerId,
                          owner_id: principal.ownerId,
                          auth_epoch: 1,
                          connection_epoch: 1,
                          last_seen_at: Date.now(),
                          workspaces_json: JSON.stringify([
                            { workspaceId, revision: 1, checks: [] },
                          ]),
                        };
                      throw Error(sql);
                    },
                    async run() {
                      assert.match(
                        sql,
                        /^INSERT OR IGNORE INTO agent_execution_requests/,
                      );
                      requests.set(args.slice(0, 2).join(":"), {
                        payload_hash: args[2],
                        runner_id: args[3],
                        binding_id: args[4],
                      });
                    },
                    async all() {
                      assert.match(sql, /FROM agent_workspace_leases/);
                      return {
                        results: device.leases().map((lease) => ({
                          run_id: lease.runId,
                          workspace_id: lease.workspaceId,
                          lease_epoch: lease.leaseEpoch,
                          expires_at: lease.expiresAt,
                        })),
                      };
                    },
                  }),
                };
              },
            },
          },
        );
        const request = async (path, fields) =>
          (
            await dispatch.fetch(
              new Request(`https://runner/execution/${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(fields),
              }),
            )
          ).json();
        const native = (action, input) =>
          request(`native/${action}`, {
            runnerId: principal.runnerId,
            authEpoch: principal.authEpoch,
            input: { ...input, connectionEpoch: 1 },
          });
        dispatchRequest = (action, input) =>
          intercept(action, input, () => native(action, input));
        return {
          native,
          tool: (name, input) => dispatch.tool(principal, name, input),
          intent: (input) => request("intent", { principal, input }),
        };
      },
      queue(value) {
        current = value;
      },
      async calls(method) {
        const state = await readFile(statePath, "utf8").then(
          JSON.parse,
          () => ({ calls: [] }),
        );
        return state.calls.filter((v) => v.method === method);
      },
      async tickUntil(predicate) {
        for (let i = 0; i < 30; i++) {
          await executor.tick();
          if (await predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.fail("expected execution state did not arrive");
      },
      setReportFailure(value) {
        failReport = value;
      },
      setSuperseded() {
        superseded = true;
      },
      setIgnoredTerminal(value) {
        ignoreTerminal = value;
      },
      setPartialEventAck(value) {
        partialEventAck = value;
      },
      onStored(fn) {
        onStored = fn;
      },
      advance(ms) {
        now += ms;
      },
      disconnect() {
        online = false;
      },
      revoke() {
        revoked = true;
      },
      async restart() {
        await executor.close({ stop: false });
        journal.close();
        runner.close();
        open();
      },
    };
  }

  test("duplicate delivery and report loss survive restart; reply uses same chat and new lease", async (t) => {
    const f = await fixture(t);
    const create = f.delivery();
    f.queue(create);
    f.setReportFailure(true);
    await f.executor.tick();
    assert.equal((await f.calls("thread/start")).length, 1);
    assert.equal(f.releases.length, 0);
    await f.restart();
    f.setReportFailure(false);
    await f.tickUntil(() => f.releases.length === 1);
    const first = f.reports.at(-1);
    assert.equal(first.status, "verifying");
    assert.equal(first.stopConfirmed, true);
    assert.equal((await f.calls("thread/start")).length, 1);
    f.queue(
      f.delivery({
        type: "continue_run",
        expectedTurnId: first.turnId,
        message: "Reply",
        mode: "reply",
      }),
    );
    await f.tickUntil(() => f.releases.length === 2);
    const next = f.reports.at(-1);
    assert.equal(next.commandId, "command-continue_run");
    assert.equal(next.threadId, first.threadId);
    assert.notEqual(next.turnId, first.turnId);
    assert.ok(next.revision > first.revision);
    assert.equal((await f.calls("turn/start")).length, 2);
  });

  test("foreign snapshot is rejected without creating a chat", async (t) => {
    const f = await fixture(t);
    f.queue(f.delivery(undefined, { ownerId: "foreign-owner" }));
    await f.tickUntil(() => f.acks.some((ack) => ack.status === "rejected"));
    assert.equal((await f.calls("thread/start")).length, 0);
  });

  for (const recovery of ["retry", "restart", "cancel after restart"]) {
    test(`two steers survive a lost stored ACK: ${recovery}`, async (t) => {
      const f = await fixture(t, "hang");
      let loseStoredFor,
        lost = false,
        holdApplied = false;
      const server = f.useDispatch(async (action, input, send) => {
        if (
          holdApplied &&
          action === "ack" &&
          input.commandId === loseStoredFor &&
          input.status === "applied"
        )
          throw Error("outcome ACK not received by server");
        const result = await send();
        if (
          action === "ack" &&
          input.commandId === loseStoredFor &&
          input.status === "stored" &&
          !lost
        ) {
          assert.equal(result.ok, true);
          lost = true;
          throw Error("lost stored ACK response after server commit");
        }
        return result;
      });
      await f.executor.context(f.workspaceId);
      const { input } = await server.intent({
        requestId: "create",
        bindingId: "binding-a",
        bindingRevision: 1,
        kind: "task",
        instruction: "Run a test task",
      });
      await server.tool("codex_create_run", input);
      const { runId } = input;
      const getRun = async () =>
        (await server.tool("codex_get_run", { runId })).run;
      await f.tickUntil(async () => (await getRun()).status === "running");
      const { turnId } = await getRun();
      const steer = (requestId) =>
        server.tool("codex_continue_run", {
          runId,
          requestId,
          mode: "steer",
          message: requestId,
          expectedTurnId: turnId,
        });
      const first = await steer("steer-a");
      const second = await steer("steer-b");
      loseStoredFor = first.commandId;
      await f.executor.tick();
      assert.equal(lost, true);
      assert.equal(f.journal.command(first.commandId)?.phase, "staged");
      assert.deepEqual(await f.calls("turn/steer"), []);

      if (recovery !== "retry") await f.restart();
      if (recovery === "cancel after restart") {
        const cancellation = await server.tool("codex_cancel_run", {
          runId,
          requestId: "cancel",
        });
        await f.tickUntil(() => f.releases.length === 1);
        assert.equal((await getRun()).status, "cancelled");
        assert.equal(
          f.journal.latest(runId)?.envelope.commandId,
          cancellation.commandId,
        );
        assert.deepEqual(await f.calls("turn/steer"), []);
        assert.equal((await f.calls("turn/interrupt")).length, 1);
        return;
      }
      holdApplied = recovery === "retry";
      await f.executor.tick();
      const steerCalls = async () =>
        (await f.calls("turn/steer")).map(
          (call) => call.params.clientUserMessageId,
        );
      assert.deepEqual(await steerCalls(), ["steer-a"]);
      if (holdApplied) {
        assert.equal(f.journal.command(first.commandId)?.phase, "applied");
        assert.equal(
          (await server.native("poll", {})).deliveries[0]?.envelope.commandId,
          first.commandId,
        );
        await f.executor.tick();
        assert.deepEqual(await steerCalls(), ["steer-a"]);
        holdApplied = false;
      }
      await f.executor.tick();
      await f.executor.tick();
      assert.deepEqual(await steerCalls(), ["steer-a", "steer-b"]);
      assert.equal(f.journal.command(first.commandId)?.phase, "applied");
      assert.equal(f.journal.command(second.commandId)?.phase, "applied");
      assert.deepEqual((await server.native("poll", {})).deliveries, []);
    });
  }

  test("stored ACK supersession prevents launch; first-seen cancel proves no turn started", async (t) => {
    const f = await fixture(t);
    f.setSuperseded();
    f.queue(f.delivery());
    await f.executor.tick();
    assert.equal((await f.calls("thread/start")).length, 0);
    assert.equal(f.releases.length, 0);
  });

  test("first-seen cancellation reports confirmed stop without opening Codex", async (t) => {
    const f = await fixture(t);
    f.queue(f.delivery({ type: "cancel_run" }));
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal(f.reports.at(-1).status, "cancelled");
    assert.equal(f.reports.at(-1).stopConfirmed, true);
    assert.equal((await f.calls("thread/start")).length, 0);
  });

  test("lease expiry interrupts an active turn before the lock can be released", async (t) => {
    const f = await fixture(t, "hang");
    f.queue(f.delivery());
    await f.tickUntil(() => f.runner.getRun("run-a")?.activeTurnId);
    assert.equal(f.releases.length, 0);
    f.advance(60_001);
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal((await f.calls("turn/interrupt")).length, 1);
    assert.equal(f.reports.at(-1).stopConfirmed, true);
    assert.equal(f.runner.getRun("run-a").terminal, true);
  });

  test("lease expiry between acceptance and dispatch cannot create a Codex chat", async (t) => {
    const f = await fixture(t);
    f.queue(f.delivery());
    f.onStored(() => f.advance(60_001));
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal((await f.calls("thread/start")).length, 0);
    assert.equal(f.reports.at(-1).status, "failed");
    assert.equal(f.reports.at(-1).stopConfirmed, true);
  });

  test("altered duplicate cannot replace the journal or open another chat, and another run must wait", async (t) => {
    const f = await fixture(t, "hang");
    const create = f.delivery();
    f.queue(create);
    await f.tickUntil(() => f.runner.getRun("run-a")?.activeTurnId);
    const prior = f.runner.getRun("run-a");
    f.queue({ ...create, snapshot: { ...create.snapshot, memoryEpoch: 999 } });
    await f.executor.tick();
    f.queue(f.delivery(undefined, {}, "run-b"));
    await f.executor.tick();
    assert.equal((await f.calls("thread/start")).length, 1);
    assert.equal(f.runner.getRun("run-a").digest, prior.digest);
    assert.equal(f.runner.getRun("run-b"), null);
    assert.equal(f.device.lease("run-b"), null);
    assert.equal(f.releases.length, 0);
  });

  test("a lost turn/start reply is reconciled after process exit without resending the turn", async (t) => {
    const f = await fixture(t, "exit-turn-start");
    f.queue(f.delivery());
    await f.tickUntil(() => f.runner.getRun("run-a")?.pendingRequestId);
    await f.restart();
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal(f.reports.at(-1).status, "verifying");
    assert.equal((await f.calls("turn/start")).length, 1);
    assert.equal((await f.calls("thread/start")).length, 1);
  });

  test("an interrupt receipt alone never releases the canonical project lock", async (t) => {
    const f = await fixture(t, "ignore-cancel");
    f.queue(f.delivery());
    await f.tickUntil(() => f.runner.getRun("run-a")?.activeTurnId);
    f.queue(f.delivery({ type: "cancel_run" }));
    await f.tickUntil(() =>
      f.reports.some((r) => r.status === "reconciliation_required"),
    );
    assert.equal((await f.calls("turn/interrupt")).length, 1);
    assert.equal(f.releases.length, 0);
    await assert.rejects(f.registry.acquire(f.workspaceId, "another-run"), {
      code: "WORKSPACE_BUSY",
    });
    await assert.rejects(f.registry.remove(f.workspaceId), {
      code: "WORKSPACE_BUSY",
    });
  });

  test("replacing an active registered directory interrupts the old turn and never launches in the new one", async (t) => {
    const f = await fixture(t, "hang");
    f.queue(f.delivery());
    await f.tickUntil(() => f.runner.getRun("run-a")?.activeTurnId);
    await rename(f.workspace, f.workspace + "-old");
    await mkdir(f.workspace);
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal((await f.calls("turn/interrupt")).length, 1);
    await assert.rejects(f.executor.context(f.workspaceId), {
      code: "WORKSPACE_CHANGED",
    });
    assert.equal((await f.calls("thread/start")).length, 1);
  });

  test("an ignored terminal report preserves the lease until the latest command settles it", async (t) => {
    const f = await fixture(t);
    f.setIgnoredTerminal(true);
    f.queue(f.delivery());
    await f.tickUntil(() => f.reports.some((r) => r.stopConfirmed));
    const old = f.reports.at(-1);
    assert.equal(f.releases.length, 0);
    await assert.rejects(f.registry.acquire(f.workspaceId, "another-run"), {
      code: "WORKSPACE_BUSY",
    });
    f.setIgnoredTerminal(false);
    f.queue(
      f.delivery({
        type: "continue_run",
        expectedTurnId: old.turnId,
        message: "Arrived late",
        mode: "steer",
      }),
    );
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal(f.reports.at(-1).commandId, "command-continue_run");
    assert.equal((await f.calls("turn/steer")).length, 0);
  });

  test("event outbox retries the exact byte-bounded page after partial acknowledgement", async (t) => {
    const f = await fixture(t, "hang");
    f.queue(f.delivery());
    await f.tickUntil(() => f.runner.getRun("run-a")?.activeTurnId);
    const first = f.eventPages.length;
    f.setPartialEventAck(true);
    for (let i = 0; i < 60; i++)
      f.runner.appendEvent("runner-a", "run-a", "output.delta", {
        text: "\x01".repeat(32_000),
      });
    await f.executor.tick();
    assert.ok(
      f.eventPages[first].length > 1 && f.eventPages[first].length < 50,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(f.eventPages[first])) < 1_800_000,
    );
    assert.ok(
      f.eventPages[first].every(
        (e) => Buffer.byteLength(JSON.stringify(e)) <= 110_000,
      ),
    );
    f.setPartialEventAck(false);
    await f.executor.tick();
    assert.deepEqual(f.eventPages[first + 1], f.eventPages[first]);
    await f.executor.tick();
    assert.notEqual(
      f.eventPages.at(-1)[0].eventId,
      f.eventPages[first][0].eventId,
    );
  });

  test("project context sends the actual Git baseline and only bounded metadata", async (t) => {
    const f = await fixture(t);
    f.queue(f.delivery());
    await f.tickUntil(() => f.releases.length === 1);
    const context = await f.executor.context(f.workspaceId);
    assert.deepEqual(
      context.gitBaseline,
      await api.readGitBaseline(f.workspace),
    );
    assert.equal(context.workspaceId, f.workspaceId);
    assert.deepEqual(Object.keys(context.threads[0]).sort(), [
      "threadId",
      "title",
      "updatedAt",
    ]);
    assert.deepEqual(f.contexts, [context]);
    f.disconnect();
    await assert.rejects(f.executor.context(f.workspaceId), {
      code: "RUNNER_OFFLINE",
    });
  });

  test("one device state cannot be consumed by overlapping launcher instances", async (t) => {
    const f = await fixture(t);
    const other = new api.ExecutionStore(path.join(f.base, "execution.sqlite"));
    t.after(() => other.close());
    assert.throws(() => other.acquireConsumer(), { code: "EXECUTOR_BUSY" });
    await f.restart();
    assert.throws(() => other.acquireConsumer(), { code: "EXECUTOR_BUSY" });
  });

  test("revoked binding interrupts an active turn even when polling still answers", async (t) => {
    const f = await fixture(t, "hang");
    f.queue(f.delivery());
    await f.tickUntil(() => f.runner.getRun("run-a")?.activeTurnId);
    f.revoke();
    f.advance(3_001);
    await f.tickUntil(() => f.runner.getRun("run-a").terminal);
    assert.equal((await f.calls("turn/interrupt")).length, 1);
    assert.equal(f.releases.length, 0);
    await assert.rejects(f.registry.acquire(f.workspaceId, "another-run"), {
      code: "WORKSPACE_BUSY",
    });
  });

  test("summary runtime is capped from turn dispatch even with a healthy lease", async (t) => {
    const f = await fixture(t, "hang");
    f.queue(
      f.delivery(undefined, {
        kind: "summary",
        task: null,
        allowedCheckIds: [],
      }),
    );
    await f.tickUntil(() => f.runner.getRun("run-a")?.activeTurnId);
    const lease = f.device.lease("run-a");
    f.device.saveLease({ ...lease, expiresAt: lease.expiresAt + 300_000 });
    f.advance(299_999);
    await f.executor.tick();
    assert.equal((await f.calls("turn/interrupt")).length, 0);
    f.advance(2);
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal((await f.calls("turn/interrupt")).length, 1);
    assert.equal(f.reports.at(-1).stopConfirmed, true);
  });

  test("native execution HTTP uses private device bearer and current socket epoch", async (t) => {
    const f = await fixture(t);
    const requests = [];
    const socket = new EventEmitter();
    socket.readyState = 1;
    socket.send = () => {};
    socket.close = () => {
      socket.readyState = 3;
    };
    const transport = new api.RunnerTransport({
      store: f.device,
      runnerId: "runner-a",
      ownerId: "owner-a",
      authEpoch: 1,
      serverOrigin: "http://127.0.0.1:8788",
      secret: async () => "device-secret",
      workspaces: () => [],
      fetch: async (url, input) => {
        if (String(url).endsWith("/token"))
          return Response.json({
            runnerId: "runner-a",
            ownerId: "owner-a",
            authEpoch: 1,
            token: "private-bearer",
            expiresAt: Date.now() + 60_000,
          });
        requests.push({ url: String(url), ...input });
        return Response.json({ offers: [], deliveries: [] });
      },
      socketFactory: () => socket,
    });
    t.after(() => transport.close());
    await assert.rejects(transport.executionRequest("poll", {}), {
      code: "RUNNER_OFFLINE",
    });
    await transport.start();
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          protocolVersion: 1,
          type: "welcome",
          runnerId: "runner-a",
          authEpoch: 1,
          connectionEpoch: 7,
        }),
      ),
    );
    await transport.executionRequest("poll", { connectionEpoch: 999 });
    assert.equal(
      requests[0].url,
      "http://127.0.0.1:8788/api/runner/execution/poll",
    );
    assert.equal(requests[0].headers.Authorization, "Bearer private-bearer");
    assert.equal(requests[0].headers.Origin, undefined);
    assert.equal(requests[0].redirect, "error");
    assert.deepEqual(JSON.parse(requests[0].body), { connectionEpoch: 7 });
    assert.ok(!JSON.stringify(transport.status).includes("private-bearer"));
  });
}
