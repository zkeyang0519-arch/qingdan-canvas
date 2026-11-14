import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { durableDispatchFixture } from "./fixtures/execution-durable-harness.mjs";

for (const delivered of [true, false]) test(`real DO sealing survives a lost inspect ACK before the native seal and prevents ${delivered ? "a staged" : "an undelivered"} command from launching after SQLite restart`, async t => {
  const cloud = await durableDispatchFixture(t, "task");
  const root = path.resolve("."), base = path.join(cloud.out, "native");
  await mkdir(base);
  const apiPath = path.join(base, "api.mjs");
  await build({ stdin: { contents: ["executor", "execution-store", "store", "device-store", "workspaces"].map(n => `export * from './runner/${n}.ts';`).join(""), resolveDir: root }, outfile: apiPath, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const api = await import(pathToFileURL(apiPath));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  let device, runs, journal, executor, registry;
  const transport = {
    status: { connectionStatus: "online", connectionEpoch: 1 },
    async executionRequest(action, body) {
      const { http, ...value } = await cloud.native(action, body);
      if (http !== 200) throw Object.assign(Error(value.error), { code: `EXECUTION_HTTP_${http}` });
      return value;
    },
    async acceptExecutionEnvelope(envelope) { return device.receiveCommand(envelope, { status: "stored" }); },
    async claimLease() { throw Error("Recovery must not renew or claim a lease"); },
    async releaseLease(workspaceId, runId, confirmed) {
      assert.equal(confirmed, true);
      const { run, rows } = await cloud.state();
      assert.equal(run.view.stopConfirmed, true);
      assert.ok(rows[`lease-release:${workspaceId}:${runId}:1`]);
      await cloud.sql("DELETE FROM agent_workspace_leases WHERE runner_id='runner' AND workspace_id=? AND run_id=? AND lease_epoch=1", workspaceId, runId);
      device.removeLease(workspaceId);
    },
  };
  const open = () => {
    device = new api.DeviceStore(path.join(base, "device.sqlite"));
    registry = new api.WorkspaceRegistry(device, { locksDir: path.join(base, "locks") });
    runs = new api.RunnerStore(path.join(base, "runs.sqlite"));
    journal = new api.ExecutionStore(path.join(base, "execution.sqlite"));
    executor = new api.RunnerExecutor({ device, registry, runs, store: journal, transport: () => transport, runnerId: "runner", ownerId: "audit-owner", authEpoch: 1, codex: { command: process.execPath, args: [path.join(root, "tests/fixtures/fake-codex.mjs")], env: { ...process.env, FAKE_CODEX_STATE: path.join(base, "codex.json") }, requestTimeoutMs: 500, shutdownTimeoutMs: 100 } });
  };
  const close = async () => { await executor.close({ stop: false }); journal.close(); runs.close(); device.close(); };
  open();
  cloud.closeNativeFirst(close);
  const registered = await registry.register({ root: workspace });
  const record = device.workspace(registered.workspaceId);
  device.removeWorkspace(registered.workspaceId);
  device.saveWorkspace({ ...record, workspaceId: "workspace" }, workspace.toLowerCase());
  let held = journal.reserve(cloud.runId, "workspace");
  await registry.acquire("workspace", cloud.runId, held.lockToken);
  held = journal.updateHold(held, "locked");
  device.saveLease({ workspaceId: "workspace", runId: cloud.runId, leaseEpoch: 1, expiresAt: cloud.expiresAt });
  journal.updateHold(held, "claimed");
  const { run } = await cloud.state();
  if (delivered) {
    journal.accept(run.commands[0].envelope, run.snapshot);
    await cloud.native("ack", { commandId: cloud.commandId, status: "stored" });
  }
  await cloud.fixture("inject", { fault: "inspect-after" });
  await executor.tick();
  const inspected = await cloud.state();
  assert.ok(Object.keys(inspected.rows).some(key => key.startsWith("exec:reconcile-ticket:")));
  assert.equal(executor.hasHold, true);
  if (delivered) assert.deepEqual(await cloud.native("ack", { commandId: cloud.commandId, status: "stored" }), { http: 200, ok: true, superseded: true });
  await close();
  await cloud.restart();
  open();
  for (let n = 0; n < 8 && executor.hasHold; n++) await executor.tick();
  assert.equal(executor.hasHold, false);
  assert.equal((await cloud.state()).run.view.status, "cancelled");
  assert.equal(await cloud.lease(), null);
  await assert.rejects(access(path.join(base, "codex.json")), { code: "ENOENT" });
});
