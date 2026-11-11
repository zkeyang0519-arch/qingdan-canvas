import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Reopening this fixture really closes/reopens SQLite and creates a new cloud
// dispatch controller, device controller, executor and native child process.
// No live app state, credentials, workspace or workerd data directory is used.
class DurableRows {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS rows(key TEXT PRIMARY KEY,data TEXT NOT NULL)");
  }
  async get(key) {
    const row = this.db.prepare("SELECT data FROM rows WHERE key=?").get(key);
    return row && JSON.parse(row.data);
  }
  async put(key, value) {
    const rows = typeof key === "string" ? [[key, value]] : Object.entries(key);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [name, data] of rows)
        this.db.prepare("INSERT INTO rows VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(name, JSON.stringify(data));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async delete(key) { return !!this.db.prepare("DELETE FROM rows WHERE key=?").run(key).changes; }
  async list({ prefix = "", limit = 1000, reverse = false } = {}) {
    const rows = this.db.prepare("SELECT key,data FROM rows ORDER BY key").all().filter(row => row.key.startsWith(prefix));
    if (reverse) rows.reverse();
    return new Map(rows.slice(0, limit).map(row => [row.key, JSON.parse(row.data)]));
  }
  async setAlarm(at) { await this.put("fixture:alarm", at); }
  close() { this.db.close(); }
}

export async function recoveryHarness(t, { mode = "normal", requestTimeoutMs = 900, runnerId = "recovery-runner" } = {}) {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const base = await mkdtemp(path.join(root, ".tmp/agent-recovery-"));
  const apiPath = path.join(base, "api.mjs");
  await build({ stdin: { contents: ["device-controller", "device-store", "execution-store", "store", "workspaces", "workspace"].map(name => `export * from './runner/${name}.ts';`).join("") + "export { ExecutionDispatch } from './worker/execution/dispatch.ts';", resolveDir: root }, bundle: true, platform: "node", format: "esm", packages: "external", outfile: apiPath, logLevel: "silent" });
  const api = await import(pathToFileURL(apiPath));
  const workspace = path.join(base, "project"), stateDir = path.join(base, "device");
  await mkdir(workspace);
  execFileSync("git", ["-C", workspace, "init", "-q"]);
  const initial = new api.DeviceStore(path.join(stateDir, "device.sqlite"));
  const registry = new api.WorkspaceRegistry(initial, { locksDir: path.join(base, "locks") });
  const registered = await registry.register({ root: workspace });
  const workspaceId = registered.workspaceId;
  const principal = { ownerId: "recovery-owner", runnerId, bindingId: "recovery-binding", bindingRevision: 1, authEpoch: 1 };
  initial.saveConfig({ ...principal, deviceName: "Isolated recovery test", serverOrigin: "http://127.0.0.1:8788", enabled: true, pairingPending: false });
  initial.close();
  const items = [1, 2, 3].map(n => ({ taskId: `task-${n}`, text: `Task ${n}`, instruction: `Execute task ${n}`, acceptance: [{ id: `artifact-${n}`, kind: "artifact", description: `Artifact ${n} exists`, required: true, relativePath: `${n}.txt`, predicate: { type: "exists" } }], source: { taskRef: { canvasId: "recovery-canvas", noteId: "recovery-note", taskId: `task-${n}` }, generation: 1, specRevision: 1 } }));
  // Acceptance reads real isolated files. Native execution counts are measured
  // from the fake app-server's durable turn/start history, never from polling.
  for (let n = 1; n <= 3; n++) await writeFile(path.join(workspace, `${n}.txt`), `fixture artifact ${n}\n`);
  let storage, dispatch, controller, transport;
  let epoch = 0, runId, created, fault, beforeRequest, writebackLoss = false;
  const packets = [], errors = [];
  const nativePath = path.join(base, "native.json");
  function openCloud() {
    storage = new DurableRows(path.join(base, "cloud.sqlite"));
    const env = {
      BATCH_QUEUE_ENABLED: "true",
      DB: { prepare(sql) { let args; return {
        bind(...values) { args = values; return this; },
        async first() {
          if (sql.includes("agent_workspace_leases")) {
            const lease = args.length === 2
              ? [...(await storage.list({ prefix: "fixture:lease:" })).values()].find(lease => lease.workspaceId === args[1])
              : await storage.get(`fixture:lease:${args[2]}`);
            return lease && { workspace_id: lease.workspaceId, run_id: lease.runId, lease_epoch: lease.leaseEpoch, expires_at: lease.expiresAt };
          }
          if (sql.includes("agent_execution_requests")) return storage.get(`fixture:reservation:${args.slice(0, 2).join(":")}`);
          if (sql.includes("agent_bindings")) return { binding_id: principal.bindingId, owner_id: principal.ownerId, runner_id: principal.runnerId, workspace_id: workspaceId, canvas_id: "recovery-canvas", revision: 1, enabled: 1 };
          if (sql.includes("agent_devices")) return { runner_id: principal.runnerId, owner_id: principal.ownerId, auth_epoch: 1, connection_epoch: epoch, last_seen_at: Date.now(), revoked_at: null, workspaces_json: JSON.stringify([{ ...registered, workspaceId, revision: 1, checks: [] }]) };
          throw Error(sql);
        },
        async run() {
          if (sql.startsWith("UPDATE agent_workspace_leases SET expires_at")) {
            const lease = await storage.get(`fixture:lease:${args[3]}`);
            if (!lease || lease.workspaceId !== args[2] || lease.leaseEpoch !== args[4]) return { meta: { changes: 0 } };
            await storage.put(`fixture:lease:${args[3]}`, { ...lease, expiresAt: args[0] });
            return { meta: { changes: 1 } };
          }
          assert.match(sql, /^INSERT OR IGNORE INTO agent_execution_requests/);
          const key = `fixture:reservation:${args.slice(0, 2).join(":")}`;
          if (!await storage.get(key)) await storage.put(key, { payload_hash: args[2], runner_id: args[3], binding_id: args[4] });
          return { success: true };
        },
        async all() {
          assert.match(sql, /agent_workspace_leases/);
          return { results: [...(await storage.list({ prefix: "fixture:lease:" })).values()].map(lease => ({ run_id: lease.runId, workspace_id: lease.workspaceId, lease_epoch: lease.leaseEpoch, expires_at: lease.expiresAt })) };
        },
      }; } },
      ROOMS: { idFromName: id => id, get: () => ({ fetch: async (_url, options) => {
        const input = JSON.parse(options.body).input;
        if (["snapshot", "validate"].includes(input.action)) {
          if (input.tasks.some(task => !items.some(item => item.taskId === task.taskId && item.source.generation === task.generation && item.source.specRevision === task.specRevision))) return new Response("changed", { status: 409 });
          // Match real Canvas validation: an already completed source is sealed.
          for (const task of input.tasks) if (await storage.get(`fixture:done:${task.taskId}`)) return new Response("source already completed", { status: 409 });
          return Response.json({ items: items.filter(item => input.tasks.some(task => task.taskId === item.taskId)) });
        }
        assert.equal(input.action, "finalize");
        const receiptKey = `fixture:receipt:${input.requestId}`;
        const prior = await storage.get(receiptKey);
        const calls = await storage.get("fixture:finalize-calls") ?? [];
        await storage.put("fixture:finalize-calls", [...calls, input]);
        if (prior) { assert.deepEqual(prior.input, input); return Response.json(prior.result); }
        const key = `fixture:done:${input.source.taskRef.taskId}`;
        assert.equal(await storage.get(key), undefined, "a source can only be completed once");
        const result = { status: "applied" };
        await storage.put({ [key]: { runId: input.runId, turnId: input.completedTurnId, effects: 1 }, [receiptKey]: { input, result } });
        if (writebackLoss) { writebackLoss = false; transport.close(); throw Error("fault: canvas completion committed but reply lost"); }
        return Response.json(result);
      } }) },
    };
    dispatch = new api.ExecutionDispatch(storage, env);
  }
  const request = async (route, fields) => {
    try {
      const response = await dispatch.fetch(new Request(`https://isolated/execution/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) }));
      const value = await response.json();
      if (!response.ok) throw Object.assign(Error(value.error), { code: `EXECUTION_HTTP_${response.status}` });
      return value;
    }
    catch (error) {
      // The in-process dispatch throws HttpError; the real HTTP transport maps
      // its status to this code. Keep the consumer fixture on that contract.
      if (error.status) error.code = `EXECUTION_HTTP_${error.status}`;
      errors.push({ route, error: error.message }); throw error;
    }
  };
  const native = (action, input) => request(`native/${action}`, { runnerId: principal.runnerId, authEpoch: 1, input: { ...input, connectionEpoch: epoch } });
  async function openDevice() {
    controller = new api.RunnerDeviceController({ stateDir, serverOrigin: "http://127.0.0.1:8788", locksDir: path.join(base, "locks"), executionEnabled: true, credentials: { read: async () => "isolated-test-only" }, executionCodex: { command: process.execPath, args: [path.join(root, "tests/fixtures/fake-codex.mjs")], env: { ...process.env, FAKE_CODEX_STATE: nativePath, FAKE_CODEX_MODE: mode }, requestTimeoutMs, shutdownTimeoutMs: 100 }, transportFactory(options) {
      transport = {
        status: { connectionStatus: "offline", connectionEpoch: ++epoch, lastHeartbeatAt: null, error: null },
        async start() { this.status.connectionStatus = "online"; },
        close() { this.status.connectionStatus = "offline"; },
        reconnect() { this.status.connectionStatus = "online"; this.status.connectionEpoch = ++epoch; },
        async updateWorkspaces() {},
        async acceptExecutionEnvelope(envelope) { return options.store.receiveCommand(envelope, { status: "stored" }); },
        async executionRequest(action, input) {
          if (this.status.connectionStatus !== "online") throw Error("fault: disconnected");
          await beforeRequest?.(action,input);
          const result = await native(action, input);
          packets.push({ action, input: structuredClone(input), result: structuredClone(result), epoch });
          if (fault?.(action, input, result)) { fault = undefined; this.close(); throw Error("fault: committed response lost"); }
          return result;
        },
        async claimLease(id, idRun) {
          let lease = await storage.get(`fixture:lease:${idRun}`);
          if (!lease) {
            const leaseEpoch = (await storage.get(`fixture:lease-epoch:${id}`) ?? 0) + 1;
            lease = { workspaceId: id, runId: idRun, leaseEpoch, expiresAt: Date.now() + 600_000 };
            await storage.put({ [`fixture:lease:${idRun}`]: lease, [`fixture:lease-epoch:${id}`]: leaseEpoch });
          }
          options.store.saveLease(lease); return lease;
        },
        async releaseLease(id, idRun, confirmedStopped) {
          assert.equal(confirmedStopped, true);
          await storage.delete(`fixture:lease:${idRun}`); options.store.removeLease(id);
        },
      };
      return transport;
    } });
    await controller.start();
    // Drive ticks explicitly, retaining the actual controller lifecycle but
    // eliminating wall-clock races from its ordinary polling interval.
    clearInterval(controller.execution.executor.timer);
    await controller.execution.executor.tick();
  }
  openCloud();
  await openDevice();
  t.after(async () => {
    await controller.close();
    storage.close();
    // Every deletion target is created under this test's unique workspace path.
    await rm(base, { recursive: true, force: true });
  });
  const fixture = {
    base, workspace, workspaceId, items, principal, packets, errors,
    journalPath: path.join(stateDir, "execution", api.digest([principal.ownerId, principal.runnerId]), "execution.sqlite"),
    get controller() { return controller; }, get executor() { return controller.execution.executor; },
    get journal() { return controller.execution.journal; }, get runs() { return controller.execution.runs; },
    get storage() { return storage; }, get dispatch() { return dispatch; }, get runId() { return runId; },
    get online() { return transport.status.connectionStatus === "online"; },
    get epoch() { return epoch; },
    setMode(value) { mode = value; },
    loseReply(predicate) { fault = predicate; },
    beforeRequest(callback) { beforeRequest=callback; },
    loseWritebackReply() { writebackLoss = true; },
    disconnect() { transport.close(); },
    async reconnect() { await controller.reconnect(principal.ownerId); },
    native,
    async control(action, { requestId = crypto.randomUUID(), expectedRevision, expectedTurnId } = {}) {
      const view = await fixture.view();
      return request("queue", { principal, input: { requestId, bindingId: principal.bindingId, bindingRevision: 1, runId, action, expectedRevision: expectedRevision ?? view.queue.revision, ...(expectedTurnId ? { expectedTurnId } : {}) } });
    },
    async expireLease() {
      const lease = { ...controller.store.lease(runId), expiresAt: Date.now() - 1 };
      controller.store.saveLease(lease);
      await storage.put(`fixture:lease:${runId}`, lease);
      return lease;
    },
    async restart(mutateNative) {
      // A crash does not send a stop RPC. Preserve that distinction from the
      // user-facing graceful stop operation while closing every local handle.
      await controller.execution.executor.close({ stop: false });
      await controller.close();
      if(mutateNative) {
        const state=JSON.parse(await readFile(nativePath,"utf8"));
        mutateNative(state);
        await writeFile(nativePath,JSON.stringify(state));
      }
      storage.close();
      openCloud();
      await openDevice();
    },
    async tick() { await controller.execution.executor.tick(); },
    // Fault tests can advance only the durable consumer stages while an older
    // RPC is paused, creating an adversarial ABA boundary without a second
    // native consumer or bypassing public Dispatch/lease authorization.
    async stageOffer() {
      const { offers } = await native("poll", {}), offer = offers[0];
      assert.ok(offer);
      const journal = fixture.journal;
      let held = journal.reserve(offer.runId, offer.workspaceId);
      assert.ok(held);
      await controller.registry.acquire(held.workspaceId, held.runId, held.lockToken);
      held = journal.updateHold(held, "locked");
      const lease = await transport.claimLease(held.workspaceId, held.runId);
      held = journal.updateHold(held, "claimed");
      held = journal.bindClaim(held, lease.leaseEpoch);
      const delivery = (await native("poll", {})).deliveries[0];
      await transport.acceptExecutionEnvelope(delivery.envelope);
      journal.accept(delivery.envelope, delivery.snapshot);
      return held;
    },
    async until(predicate) {
      for (let attempt = 0; attempt < 100; attempt++) {
        await fixture.tick();
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.fail(`recovery condition not reached; cloud errors=${JSON.stringify(errors.slice(-4))}; run=${JSON.stringify(fixture.runs.getRun(runId))}`);
    },
    async create({ batch = true, requestId = "recovery-submit" } = {}) {
      await controller.executionContext(principal.ownerId, workspaceId);
      const intent = await request("intent", { principal, input: { requestId, bindingId: principal.bindingId, bindingRevision: 1, kind: "task", ...(batch ? { autoComplete: true, sourceTasks: items.map(item => ({ noteId: item.source.taskRef.noteId, taskId: item.taskId, generation: 1, specRevision: 1 })) } : { instruction: "Single task that permits a later reply" }) } });
      runId = intent.input.runId;
      created = await dispatch.tool(principal, "codex_create_run", intent.input);
      return created;
    },
    async view() { return (await dispatch.tool(principal, "codex_get_run", { runId })).run; },
    async nativeState() { return readFile(nativePath, "utf8").then(JSON.parse, () => ({ calls: [], threads: [] })); },
    async finish() { await fixture.until(async () => (await fixture.view()).queue?.phase === "completed" && !fixture.executor.hasHold); },
    async assertExactlyOnce() {
      const state = await fixture.nativeState();
      assert.equal(state.calls.filter(call => call.method === "thread/start").length, 1);
      assert.equal(state.threads.length, 1);
      const starts = state.calls.filter(call => call.method === "turn/start");
      assert.equal(starts.length, 3);
      assert.equal(new Set(starts.map(call => call.params.clientUserMessageId)).size, 3);
      assert.deepEqual([...new Set(starts.map(call => call.params.threadId))], [state.threads[0].id]);
      const view = await fixture.view();
      assert.equal(view.threadId, state.threads[0].id);
      assert.equal(view.queue.phase, "completed");
      assert.deepEqual(view.batch.items.map(item => item.status), ["done", "done", "done"]);
      assert.deepEqual(view.batch.items.map(item => item.writeback.status), ["applied", "applied", "applied"]);
      const effects = [...(await storage.list({ prefix: "fixture:done:" })).values()];
      assert.equal(effects.length, 3);
      assert.deepEqual(effects.map(item => item.effects), [1, 1, 1]);
      assert.equal(new Set(effects.map(item => item.runId)).size, 1);
      assert.deepEqual(effects.map(item => item.turnId), state.threads[0].turns.map(turn => turn.id));
      assert.equal((await storage.list({ prefix: "exec:run:" })).size, 1);
      assert.equal((await storage.get(`exec:run:${runId}`)).commands.length, 1);
      assert.equal(fixture.executor.hasHold, false);
      assert.equal(await storage.get("exec:queue-workspace:" + workspaceId), undefined);
    },
  };
  return fixture;
}
