import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
    let onGate = () => ({ decision: "wait", queueRevision: 1 });
    const gates = [];
    let pendingResponses = [],
      failResponseAck = false;
    const responseAcks = [];
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
        if (action === "batch-gate") {
          gates.push(body);
          return onGate(body);
        }
        if (action === "responses") return { responses: pendingResponses };
        if (action === "response-ack") {
          if (failResponseAck) throw Error("response ACK lost");
          responseAcks.push(body);
          pendingResponses = pendingResponses.filter(
            (r) => r.responseId !== body.responseId,
          );
          return { ok: true };
        }
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
      gates,
      responseAcks,
      responses(value) {
        pendingResponses = value;
      },
      failResponseAck(value) {
        failResponseAck = value;
      },
      onGate(fn) {
        onGate = fn;
      },
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
      setMode(value) {
        mode = value;
      },
      async restart() {
        await executor.close({ stop: false });
        journal.close();
        runner.close();
        open();
      },
    };
  }

  function orderedBatch() {
    const base = makeSnapshot();
    const items = [1, 2, 3].map((n) => ({
      taskId: `item-${n}`,
      text: `待办 ${n}`,
      instruction: `执行第 ${n} 项`,
      acceptance: [
        {
          id: `check-${n}`,
          kind: "human",
          required: true,
          description: `第 ${n} 项完成`,
        },
      ],
    }));
    return {
      batch: { items },
      task: {
        ...base.task,
        text: items[0].text,
        instruction: items[0].instruction,
        acceptance: items[0].acceptance,
        taskRef: { ...base.task.taskRef, taskId: items[0].taskId },
      },
    };
  }
  for (const mode of ["approval", "input"]) {
    test(`native ${mode} delivery survives ACK loss and restart without repeating wire response or storing answer text`, async (t) => {
      const f = await fixture(t, mode);
      f.queue(f.delivery());
      await f.tickUntil(() =>
        f.events.some(
          (e) =>
            e.type ===
            (mode === "approval" ? "approval.requested" : "input.requested"),
        ),
      );
      const event = f.events.find(
        (e) =>
          e.type ===
          (mode === "approval" ? "approval.requested" : "input.requested"),
      );
      const response = {
        responseId: "response-once",
        pendingRequestId: event.payload.requestId,
        runId: event.runId,
        threadId: event.threadId,
        turnId: event.turnId,
        response:
          mode === "approval"
            ? { decision: "decline" }
            : { answers: { choice: { answers: ["private-answer-fixture"] } } },
      };
      f.responses([response]);
      f.failResponseAck(true);
      await f.tickUntil(
        async () => (await f.calls("server-response")).length === 1,
      );
      await f.restart();
      f.failResponseAck(false);
      await f.tickUntil(() =>
        f.responseAcks.some((a) => a.responseId === response.responseId),
      );
      assert.equal(f.responseAcks.at(-1).status, "applied");
      assert.equal((await f.calls("server-response")).length, 1);
      assert.ok(!JSON.stringify(f.events).includes("private-answer-fixture"));
      for (const name of [
        "execution.sqlite",
        "execution.sqlite-wal",
        "adapter.sqlite",
        "adapter.sqlite-wal",
      ]) {
        const bytes = await readFile(path.join(f.base, name)).catch(() =>
          Buffer.alloc(0),
        );
        assert.equal(
          bytes.includes(Buffer.from("private-answer-fixture")),
          false,
          name,
        );
      }
    });
  }
  test("native cloud response cannot target a different turn and cancellation wins before pending approval delivery", async (t) => {
    const f = await fixture(t, "approval");
    const delivery = f.delivery();
    f.queue(delivery);
    await f.tickUntil(() =>
      f.events.some((e) => e.type === "approval.requested"),
    );
    const event = f.events.find((e) => e.type === "approval.requested");
    const response = {
      responseId: "wrong-turn-response",
      pendingRequestId: event.payload.requestId,
      runId: event.runId,
      threadId: event.threadId,
      turnId: "foreign-turn",
      response: { decision: "accept" },
    };
    f.responses([response]);
    await f.tickUntil(() => f.responseAcks.length === 1);
    assert.equal(f.responseAcks[0].status, "expired");
    assert.equal((await f.calls("server-response")).length, 0);
    f.responses([
      { ...response, responseId: "cancel-race-response", turnId: event.turnId },
    ]);
    f.queue(
      f.delivery({ type: "cancel_run", commandId: "cancel-with-answer" }),
    );
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal((await f.calls("server-response")).length, 0);
    assert.ok(
      f.events.some(
        (e) =>
          e.type === "request.resolved" && e.payload.status === "cancelled",
      ),
    );
  });
  test("a persisted interaction dispatch marker is expired after restart rather than replayed to a new wire callback", async (t) => {
    const f = await fixture(t, "approval");
    f.queue(f.delivery());
    await f.tickUntil(() =>
      f.events.some((e) => e.type === "approval.requested"),
    );
    const event = f.events.find((e) => e.type === "approval.requested");
    const response = {
      responseId: "crashed-answer",
      pendingRequestId: event.payload.requestId,
      runId: event.runId,
      threadId: event.threadId,
      turnId: event.turnId,
      response: { decision: "accept" },
    };
    // Model a crash after durable intent but before delivery acknowledgement.
    f.journal.beginInteractionResponse(response);
    f.responses([response]);
    await f.restart();
    await f.tickUntil(() => f.responseAcks.length > 0);
    assert.equal(f.responseAcks[0].status, "expired");
    assert.equal((await f.calls("server-response")).length, 0);
  });
  async function firstItemReady(f) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (f.runner.getRun("run-a")?.batchPhase === "ready") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("first batch item never completed");
  }
  test("managed batch verifies real artifacts and waits for durable server permission between every item and final release", async (t) => {
    const f = await fixture(t),
      batch = orderedBatch();
    batch.batch.managed = true;
    for (const [i, item] of batch.batch.items.entries()) {
      item.acceptance = [
        {
          id: `artifact-${i}`,
          kind: "artifact",
          required: true,
          description: "exists",
          relativePath: `result-${i}.txt`,
          predicate: { type: "exists" },
        },
      ];
      await writeFile(path.join(f.workspace, `result-${i}.txt`), "ok");
    }
    batch.task.acceptance = batch.batch.items[0].acceptance;
    // These files are part of the initial authorized baseline.
    const delivery = f.delivery({ type: "create_run" }, batch);
    delivery.snapshot.context.gitBaseline = await api.readGitBaseline(
      f.workspace,
    );
    delivery.snapshot.payloadHash = api.digest({
      ...delivery.snapshot,
      payloadHash: undefined,
    });
    delivery.envelope.payload.payloadHash = delivery.snapshot.payloadHash;
    delivery.envelope.payloadHash = api.digest(delivery.envelope.payload);
    f.queue(delivery);
    await f.tickUntil(() => f.gates.length > 0);
    assert.equal((await f.calls("turn/start")).length, 1);
    const proof = f.events.find((e) => e.type === "verification.completed");
    assert.equal(proof.turnId, f.gates[0].completedTurnId);
    assert.equal(proof.payload.results[0].status, "passed");
    assert.match(proof.payload.results[0].outputHash, /^[a-f0-9]{64}$/);
    await f.restart();
    await f.executor.tick();
    assert.equal((await f.calls("turn/start")).length, 1);
    f.onGate((input) =>
      input.fromIndex < 2
        ? {
            decision: "advance",
            queueRevision: input.fromIndex + 2,
            permitId: `permit-${input.fromIndex}`,
            nextIndex: input.fromIndex + 1,
          }
        : { decision: "wait", queueRevision: 4 },
    );
    await f.tickUntil(() => f.gates.some((g) => g.fromIndex === 2));
    assert.equal((await f.calls("turn/start")).length, 3);
    assert.equal(f.releases.length, 0);
    assert.equal(f.runner.getRun("run-a").terminal, false);
    f.onGate(() => ({
      decision: "finish",
      queueRevision: 5,
      permitId: "finish",
    }));
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal(f.runner.getRun("run-a").batchPhase, "complete");
    assert.equal((await f.calls("thread/start")).length, 1);
    assert.equal(
      f.events.filter((e) => e.type === "verification.completed").length,
      3,
    );
  });
  test("managed batch repairs the same item only once and re-verifies the repaired turn after restart", async (t) => {
    const f = await fixture(t),
      batch = orderedBatch();
    batch.batch.managed = true;
    batch.batch.items = [batch.batch.items[0]];
    batch.batch.items[0].acceptance = [
      {
        id: "missing",
        kind: "artifact",
        required: true,
        description: "file exists",
        relativePath: "missing.txt",
        predicate: { type: "exists" },
      },
      {
        id: "review",
        kind: "human",
        required: true,
        description: "Review repaired artifact",
      },
    ];
    batch.task.acceptance = batch.batch.items[0].acceptance;
    f.queue(f.delivery({ type: "create_run" }, batch));
    await f.tickUntil(() => f.gates.length > 0);
    assert.equal(
      f.events.find((e) => e.type === "verification.completed").payload
        .results[0].failureKind,
      "predicate",
    );
    f.setMode("batch-exit-second");
    await f.restart();
    f.onGate(() => ({
      decision: "repair",
      queueRevision: 2,
      permitId: "repair-once",
      nextIndex: 0,
    }));
    await f.tickUntil(async () => (await f.calls("turn/start")).length === 2);
    await f.restart();
    await f.tickUntil(
      () =>
        f.events.filter((e) => e.type === "verification.completed").length ===
        2,
    );
    for (let n = 0; n < 3; n++) await f.executor.tick();
    const starts = await f.calls("turn/start");
    assert.equal(starts.length, 2);
    assert.equal(starts[1].params.clientUserMessageId, "repair-once");
    assert.match(starts[1].params.input[0].text, /missing/);
    assert.equal(new Set(starts.map((c) => c.params.threadId)).size, 1);
    assert.equal(f.runner.getRun("run-a").batch.currentIndex, 0);
    assert.equal(f.releases.length, 0);
  });
  test("managed human checks remain waiting across a long pause and immediate stop prevents the next item", async (t) => {
    const f = await fixture(t),
      batch = orderedBatch();
    batch.batch.managed = true;
    f.queue(f.delivery({ type: "create_run" }, batch));
    await f.tickUntil(() => f.gates.length > 0);
    assert.equal(
      f.events.find((e) => e.type === "verification.completed").payload
        .results[0].status,
      "needs_input",
    );
    f.advance(31 * 60_000);
    const lease = f.device.lease("run-a");
    f.device.saveLease({ ...lease, expiresAt: lease.expiresAt + 35 * 60_000 });
    await f.executor.tick();
    assert.equal(f.releases.length, 0);
    assert.equal(f.runner.getRun("run-a").batchPhase, "ready");
    // Even a malformed remote repair decision cannot turn human review into an
    // unbounded model retry loop on the native side.
    f.onGate(() => ({
      decision: "repair",
      queueRevision: 2,
      permitId: "bad-repair",
      nextIndex: 0,
    }));
    await f.executor.tick();
    assert.equal((await f.calls("turn/start")).length, 1);
    f.queue(
      f.delivery({ type: "cancel_run", commandId: "stop-managed" }, batch),
    );
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal((await f.calls("turn/start")).length, 1);
    assert.equal(f.runner.getRun("run-a").batchPhase, "cancelled");
  });
  test("managed continuation rejects a changed Git branch while ordinary task output dirtiness is allowed", async (t) => {
    const f = await fixture(t),
      batch = orderedBatch();
    batch.batch.managed = true;
    f.queue(f.delivery({ type: "create_run" }, batch));
    await f.tickUntil(() => f.gates.length > 0);
    await writeFile(path.join(f.workspace, "task-output.txt"), "new output");
    await f.executor.tick();
    assert.equal(f.runner.getRun("run-a").batchPhase, "ready");
    execFileSync("git", [
      "-C",
      f.workspace,
      "symbolic-ref",
      "HEAD",
      "refs/heads/changed",
    ]);
    f.onGate(() => ({
      decision: "advance",
      queueRevision: 2,
      permitId: "advance-after-rebind",
      nextIndex: 1,
    }));
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal((await f.calls("turn/start")).length, 1);
  });
  test("managed turn dispatch rechecks Git identity after the final authorization round trip", async (t) => {
    const f = await fixture(t),
      batch = orderedBatch();
    batch.batch.managed = true;
    f.queue(f.delivery({ type: "create_run" }, batch));
    await f.tickUntil(() => f.gates.length > 0);
    let calls = 0;
    f.onGate(() => {
      f.onStored(() => {
        if (++calls === 2)
          execFileSync("git", [
            "-C",
            f.workspace,
            "symbolic-ref",
            "HEAD",
            "refs/heads/raced-change",
          ]);
      });
      return {
        decision: "advance",
        queueRevision: 2,
        permitId: "raced-permit",
        nextIndex: 1,
      };
    });
    await f.executor.tick();
    assert.equal((await f.calls("turn/start")).length, 1);
  });
  test("executor reads an explicit local approval reviewer option only for its isolated Codex process", async (t) => {
    const previous = process.env.QINGDAN_CODEX_APPROVALS_REVIEWER;
    process.env.QINGDAN_CODEX_APPROVALS_REVIEWER = "auto_review";
    t.after(() => {
      if (previous === undefined)
        delete process.env.QINGDAN_CODEX_APPROVALS_REVIEWER;
      else process.env.QINGDAN_CODEX_APPROVALS_REVIEWER = previous;
    });
    const f = await fixture(t);
    f.queue(f.delivery());
    await f.tickUntil(() => f.releases.length === 1);
    const [thread] = await f.calls("thread/start"),
      [turn] = await f.calls("turn/start");
    assert.equal(thread.params.approvalsReviewer, "auto_review");
    assert.equal(turn.params.approvalsReviewer, "auto_review");
    assert.equal(turn.params.approvalPolicy, "on-request");
    assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(turn.params.sandboxPolicy.networkAccess, false);
  });
  test("executor advances the batch under a live lease after the original delivery expired", async (t) => {
    const f = await fixture(t),
      batch = orderedBatch();
    f.queue(f.delivery({ type: "create_run" }, batch));
    await f.executor.tick();
    await firstItemReady(f);
    assert.equal(f.releases.length, 0);
    f.advance(61000);
    const lease = f.device.lease("run-a");
    f.device.saveLease({ ...lease, expiresAt: lease.expiresAt + 120000 });
    await f.tickUntil(() => f.releases.length === 1);
    const starts = await f.calls("turn/start");
    assert.equal(starts.length, 3);
    assert.equal(new Set(starts.map((c) => c.params.threadId)).size, 1);
    assert.equal((await f.calls("thread/start")).length, 1);
    assert.equal(f.reports.at(-1).status, "verifying");
    assert.deepEqual(
      f.reports.at(-1).batch.items.map((i) => i.status),
      ["done", "done", "done"],
    );
  });
  test("executor polls cancellation before automatically dispatching the next batch item", async (t) => {
    const f = await fixture(t),
      batch = orderedBatch();
    f.queue(f.delivery({ type: "create_run" }, batch));
    await f.executor.tick();
    await firstItemReady(f);
    f.queue(
      f.delivery({ type: "cancel_run", commandId: "cancel-batch" }, batch),
    );
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal((await f.calls("turn/start")).length, 1);
    assert.equal(f.reports.at(-1).status, "cancelled");
    assert.deepEqual(
      f.reports.at(-1).batch.items.map((i) => i.status),
      ["done", "cancelled", "cancelled"],
    );
  });
  test("executor restart between batch items resumes the same chat without repeating the first item", async (t) => {
    const f = await fixture(t),
      batch = orderedBatch();
    f.queue(f.delivery({ type: "create_run" }, batch));
    await f.executor.tick();
    await firstItemReady(f);
    await f.restart();
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal((await f.calls("thread/start")).length, 1);
    assert.deepEqual(
      (await f.calls("turn/start")).map((c) => c.params.input[0].text),
      ["执行第 1 项", "执行第 2 项", "执行第 3 项"],
    );
  });

  test("an uncertain initial batch dispatch recovers its original turn and advances the remaining items", async (t) => {
    const f = await fixture(t, "exit-turn-start");
    f.queue(f.delivery({ type: "create_run" }, orderedBatch()));
    await f.executor.tick();
    assert.equal(f.journal.latest("run-a").phase, "uncertain");
    // Every turn loses its transport reply in this fixture; history proves each
    // accepted turn, so none may be resent and the original create ACK recovers.
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal((await f.calls("thread/start")).length, 1);
    assert.equal((await f.calls("turn/start")).length, 3);
    assert.equal(f.runner.getRun("run-a").batchPhase, "complete");
  });

  test("a lost reply to a paused batch recovers accepted continuation and resumes later todos", async (t) => {
    const f = await fixture(t, "batch-block-second"),
      batch = orderedBatch();
    f.queue(f.delivery({ type: "create_run" }, batch));
    await f.tickUntil(() => f.releases.length === 1);
    const paused = f.runner.getRun("run-a");
    assert.equal(paused.batchPhase, "paused");
    f.setMode("batch-exit-third");
    await f.restart();
    f.queue(
      f.delivery(
        {
          type: "continue_run",
          commandId: "batch-retry",
          expectedTurnId: paused.activeTurnId,
          mode: "reply",
          message: "已解决，请完成当前项。",
        },
        batch,
      ),
    );
    await f.executor.tick();
    assert.equal(f.journal.latest("run-a").phase, "uncertain");
    await f.tickUntil(() => f.releases.length === 2);
    assert.equal(f.runner.getRun("run-a").batchPhase, "complete");
    assert.equal((await f.calls("thread/start")).length, 1);
    assert.equal((await f.calls("turn/start")).length, 4);
    assert.equal(f.journal.latest("run-a").phase, "applied");
  });

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

  test("queued read-only summary captures its native start baseline without changing the snapshot", async (t) => {
    const f = await fixture(t);
    // The preceding task completes while the already requested summary waits.
    f.queue(f.delivery());
    await f.tickUntil(() => f.releases.length === 1);
    const summary = f.delivery(
      { type: "create_run", commandId: "summary-create" },
      { kind: "summary", task: null },
      "summary-run",
    );
    const originalSnapshot = structuredClone(summary.snapshot);
    await writeFile(
      path.join(f.workspace, "prior-task.txt"),
      "preceding task result",
    );
    f.queue(summary);
    await f.tickUntil(() => f.releases.length === 2);
    const report = f.reports.at(-1);
    assert.equal(report.status, "verifying");
    assert.deepEqual(
      report.summaryContext.gitBaseline,
      await api.readGitBaseline(f.workspace),
    );
    assert.equal(report.summaryContext.gitBaseline.dirty, true);
    assert.equal(report.summaryContext.workspaceId, f.workspaceId);
    assert.ok(
      Date.parse(report.summaryContext.capturedAt) >
        Date.parse(originalSnapshot.capturedAt),
    );
    assert.deepEqual(f.runner.getRun("summary-run").snapshot, originalSnapshot);
    assert.equal(
      (await f.calls("thread/start")).at(-1).params.sandbox,
      "read-only",
    );
    const turn = (await f.calls("turn/start")).at(-1).params;
    assert.equal(turn.approvalPolicy, "on-request");
    assert.equal(turn.sandboxPolicy.type, "readOnly");
    const evidence = JSON.parse(
      turn.additionalContext.qingdan_project_evidence.value,
    );
    assert.ok(
      evidence.files.some(
        (file) =>
          file.path === "prior-task.txt" &&
          file.content === "preceding task result",
      ),
    );
    assert.equal(evidence.gitBaseline.dirty, true);
    await f.restart();
    assert.deepEqual(
      f.runner.getRun("summary-run").summaryContext,
      report.summaryContext,
    );
  });

  test("write tasks still reject a changed baseline before creating any chat", async (t) => {
    const f = await fixture(t),
      delivery = f.delivery();
    await writeFile(
      path.join(f.workspace, "external-change.txt"),
      "changed after authorization",
    );
    f.queue(delivery);
    await f.tickUntil(() => f.releases.length === 1);
    assert.equal(f.reports.at(-1).status, "failed");
    assert.equal(f.reports.at(-1).error, "GIT_BASELINE_CHANGED");
    assert.equal((await f.calls("thread/start")).length, 0);
    assert.equal(f.reports.at(-1).summaryContext, undefined);
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
