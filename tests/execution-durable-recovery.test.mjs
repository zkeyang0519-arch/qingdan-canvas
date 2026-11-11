import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(new URL("../node_modules/wrangler/package.json", import.meta.url))("miniflare");
const bearer = "a".repeat(64), sha = text => createHash("sha256").update(text).digest("hex");
async function fixture(t, kind = "managed", mode = "expired") {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const out = await mkdtemp(path.join(root, ".tmp/execution-durable-"));
  await build({ entryPoints: [path.join(root, "tests/fixtures/execution-durable-worker.ts")], bundle: true, platform: "neutral", format: "esm", mainFields: ["module", "main"], conditions: ["workerd", "browser"], external: ["node:*", "cloudflare:*"], outfile: path.join(out, "worker.mjs"), logLevel: "silent" });
  const options = convertV4MiniflareOptions({ name: "execution-durable", port: 0, scriptPath: path.join(out, "worker.mjs"), modules: true, compatibilityDate: "2026-10-19", compatibilityFlags: ["nodejs_compat"], cf: false, log: new Log(LogLevel.ERROR), d1Databases: ["DB"], durableObjects: { RUNNER_HUBS: { className: "RecoveryHub", useSQLite: true } }, bindings: { APP_ENV: "test", RUNNER_ENABLED: "true", EXECUTION_ENABLED: "true", BATCH_QUEUE_ENABLED: "true" } });
  Object.assign(options, { isolatedResourcePersistencePath: path.join(out, "isolated"), resourcePersistencePath: path.join(out, "state"), unsafeEnableSharedStorage: true, unsafeDevRegistryPath: path.join(out, "registry") });
  let mf = new Miniflare(options), db;
  t.after(async () => { await mf.dispose(); await rm(out, { recursive: true, force: true }); });
  db = await mf.getD1Database("DB");
  for (const file of (await readdir(path.join(root, "migrations"))).filter(f => f.endsWith(".sql")).sort()) {
    const sql = (await readFile(path.join(root, "migrations", file), "utf8")).replace(/^--.*$/gm, "");
    await db.batch(sql.split(";").filter(s => s.trim()).map(s => db.prepare(s)));
  }
  await db.batch([
    db.prepare("INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('audit-owner','audit-owner','Audit','unused','2026')"),
    db.prepare("INSERT INTO rooms VALUES('canvas','Audit','audit-owner','unused','2026')"),
    db.prepare("INSERT INTO agent_devices(runner_id,owner_id,device_name,secret_hash,workspaces_json,connection_epoch,last_seen_at) VALUES('runner','audit-owner','Audit','unused',?,1,?)").bind(JSON.stringify([{ workspaceId: "workspace", name: "Audit", displayPath: "synthetic", revision: 1, checks: [] }]), Date.now()),
    db.prepare("INSERT INTO agent_bindings VALUES('binding','audit-owner','canvas','section','runner','workspace',1,1)"),
    db.prepare("INSERT INTO agent_connection_tokens VALUES(?,'runner','runner-connect',1,?)").bind(sha(bearer), Date.now() + 3600000),
  ]);
  async function call(url, input, token = bearer) {
    const response = await mf.dispatchFetch("https://audit.test" + url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(input) });
    return { http: response.status, ...await response.json() };
  }
  const fixtureCall = (op, input = {}) => call("/fixture", { op, ...input });
  const seeded = await fixtureCall("seed", { kind, mode });
  assert.equal(seeded.http, 200, JSON.stringify(seeded));
  const { runId, commandId, snapshotHash } = seeded;
  return {
    ...seeded, fixture: fixtureCall,
    native: (action, input = {}, token) => call("/api/runner/execution/" + action, { connectionEpoch: 1, ...input }, token),
    async state() { const rows = await fixtureCall("state"); return { rows, run: rows["exec:run:" + runId] }; },
    async sql(sql, ...values) { return db.prepare(sql).bind(...values).run(); },
    async lease() { return db.prepare("SELECT * FROM agent_workspace_leases WHERE runner_id='runner'").first(); },
    async restart() { await mf.dispose(); mf = new Miniflare(options); db = await mf.getD1Database("DB"); },
    inspect(extra = {}) { return this.native("reconcile", { phase: "inspect", runId, workspaceId: "workspace", leaseEpoch: 1, ...extra }); },
    confirmation(ticket, proofKind = "never_dispatched") {
      return { phase: "confirm", runId, recoveryId: ticket.recoveryId, requestId: "stop-" + ticket.recoveryId, proof: { kind: proofKind, consumerHeld: true, claim: { runId, workspaceId: "workspace", leaseEpoch: 1, lockToken: "durable-original-claim" }, journal: { commandId, snapshotHash, sealed: true }, ...(proofKind === "never_dispatched" ? { commandState: "not_received", launchStage: "absent", turnStartRecorded: false } : { threadId: "thread", turnId: "turn0", turnsStopped: true, backgroundTerminalsStopped: true }) }, report: { runId, commandId: ticket.currentCommandId, revision: ticket.reportRevision + 1, status: "cancelled", threadId: proofKind === "native_stopped" ? "thread" : null, turnId: proofKind === "native_stopped" ? "turn0" : null, terminal: true, stopConfirmed: true } };
    },
  };
}

for (const fault of ["control-before", "control-after"]) test(`queue control remains retryable across actual DO restart: ${fault}`, async t => {
  const f = await fixture(t, "managed", "queue");
  const input = { bindingId: "binding", bindingRevision: 1, runId: f.runId, requestId: "pause-once", expectedRevision: 1, action: "pause" };
  await f.fixture("inject", { fault });
  assert.equal((await f.fixture("control", { input })).http, 500);
  await f.restart();
  const retry = await f.fixture("control", { input });
  assert.equal(retry.http, 200, JSON.stringify(retry));
  assert.equal(retry.queue.pauseRequested, true);
  assert.deepEqual(await f.fixture("control", { input }), retry);
});

for (const fault of ["repair-before", "repair-after"]) test(`repair count and permit survive actual DO restart together: ${fault}`, async t => {
  const f = await fixture(t, "managed", "queue");
  const input = { runId: f.runId, commandId: f.commandId, fromIndex: 0, completedTurnId: "turn0", reportRevision: 1 };
  await f.fixture("inject", { fault });
  assert.equal((await f.native("batch-gate", input)).http, 500);
  await f.restart();
  const retry = await f.native("batch-gate", input);
  assert.equal(retry.decision, "repair", JSON.stringify(retry));
  assert.deepEqual(await f.native("batch-gate", input), retry);
  assert.equal((await f.state()).run.queueState.repairs["0"], 1);
});

for (const kind of ["task", "summary", "managed"]) test(`expired ${kind} delivery has a durable stop-only reconciliation receipt`, async t => {
  const f = await fixture(t, kind);
  const before = await f.state(), lease = await f.lease();
  const inspected = await f.inspect();
  assert.equal(inspected.http, 200, JSON.stringify(inspected));
  const { ticket } = inspected;
  assert.equal(ticket.action, "stop", "an expired lease permits only stopping, never renewed execution");
  assert.equal(ticket.originalCommandId, f.commandId);
  assert.equal(ticket.snapshotHash, f.snapshotHash);
  assert.deepEqual(await f.inspect(), inspected);
  await f.restart();
  assert.deepEqual(await f.inspect(), inspected);
  const confirm = f.confirmation(ticket);
  await f.fixture("inject", { fault: "confirm-after" });
  assert.equal((await f.native("reconcile", confirm)).http, 500);
  await f.restart();
  const receipt = await f.native("reconcile", confirm);
  assert.equal(receipt.settled, true, JSON.stringify(receipt));
  assert.deepEqual(await f.native("reconcile", confirm), receipt);
  const after = await f.state();
  assert.equal(after.run.view.stopConfirmed, true);
  assert.equal(after.run.view.status, "cancelled");
  assert.equal(after.rows["exec:active"], undefined);
  assert.equal(after.rows["exec:queue-workspace:workspace"], undefined);
  assert.equal(after.rows[`lease-release:workspace:${f.runId}:1`], true);
  assert.deepEqual(after.run.commands[0].envelope, before.run.commands[0].envelope);
  assert.deepEqual(await f.lease(), lease, "server must neither renew nor release the original lease");
  assert.deepEqual(await f.native("poll"), { http: 200, offers: [], deliveries: [] });
});

test("cancellation remains visible with expired lease and native stop proof settles the current head", async t => {
  const f = await fixture(t);
  const cancellation = await f.fixture("cancel", { runId: f.runId });
  assert.equal(cancellation.http, 200);
  assert.deepEqual(await f.native("poll"), { http: 200, offers: [], deliveries: [] });
  assert.equal((await f.state()).run.view.status, "cancel_requested");
  const { ticket } = await f.inspect();
  assert.equal(ticket.currentCommandId, cancellation.commandId);
  assert.equal(ticket.action, "stop");
  assert.equal((await f.native("reconcile", f.confirmation(ticket, "native_stopped"))).settled, true);
});

test("reconciliation rejects unauthenticated clients, stale connections, changed head and lease", async t => {
  const f = await fixture(t, "task");
  assert.equal((await f.native("reconcile", {}, "")).http, 401);
  assert.equal((await f.inspect({ connectionEpoch: 2 })).http, 409);
  assert.equal((await f.inspect({ leaseEpoch: 2 })).http, 409);
  const inspected = await f.inspect(); assert.equal(inspected.http, 200, JSON.stringify(inspected));
  await f.fixture("cancel", { runId: f.runId });
  assert.equal((await f.native("reconcile", f.confirmation(inspected.ticket))).http, 409);
  const { ticket } = await f.inspect();
  await f.sql("UPDATE agent_workspace_leases SET lease_epoch=2 WHERE runner_id='runner'");
  assert.equal((await f.native("reconcile", f.confirmation(ticket))).http, 409);
  assert.equal((await f.state()).run.view.stopConfirmed, false);
});

test("absence is not a stop proof and the stop receipt cannot precede its terminal commit", async t => {
  const f = await fixture(t, "task");
  const inspected = await f.inspect(); assert.equal(inspected.http, 200, JSON.stringify(inspected));
  const confirm = f.confirmation(inspected.ticket);
  for (const proof of [{ kind: "never_dispatched" }, { ...confirm.proof, consumerHeld: false }, { ...confirm.proof, launchStage: "turn_sent" }, { ...confirm.proof, journal: { ...confirm.proof.journal, sealed: false } }]) {
    assert.equal((await f.native("reconcile", { ...confirm, proof })).http, 400);
  }
  await f.fixture("inject", { fault: "confirm-before" });
  assert.equal((await f.native("reconcile", confirm)).http, 500);
  await f.restart();
  assert.equal((await f.state()).run.view.stopConfirmed, false);
  assert.equal((await f.state()).rows[`lease-release:workspace:${f.runId}:1`], undefined);
  assert.equal((await f.native("reconcile", confirm)).settled, true);
  assert.equal((await f.native("reconcile", { ...confirm, proof: { ...confirm.proof, commandState: "staged" } })).http, 409);
});

test("a settled run never authorizes release of a different lease epoch", async t => {
  const f = await fixture(t, "task"), { ticket } = await f.inspect();
  assert.equal((await f.native("reconcile", f.confirmation(ticket))).settled, true);
  await f.sql("DELETE FROM agent_workspace_leases WHERE runner_id='runner'");
  assert.equal((await f.inspect({ leaseEpoch: 2 })).http, 409);
  assert.equal((await f.inspect()).decision, "settled");
});

test("report changes invalidate tickets, and reconnect retries keep the exact stop receipt", async t => {
  const f = await fixture(t, "task"), first = await f.inspect();
  const report = { runId: f.runId, commandId: f.commandId, revision: 1, status: "reconciliation_required", threadId: null, turnId: null, terminal: false, stopConfirmed: false };
  assert.equal((await f.native("report", report)).http, 200);
  assert.equal((await f.native("reconcile", f.confirmation(first.ticket))).http, 409);
  const { ticket } = await f.inspect(), confirm = f.confirmation(ticket);
  confirm.proof.commandState = "uncertain";
  confirm.proof.launchStage = "thread_requested";
  const bad = structuredClone(confirm); bad.proof.journal.snapshotHash = "f".repeat(64);
  assert.equal((await f.native("reconcile", bad)).http, 409);
  await f.fixture("inject", { fault: "cleanup" });
  assert.equal((await f.native("reconcile", confirm)).http, 500);
  assert.equal((await f.state()).run.view.stopConfirmed, true);
  await f.restart();
  await f.sql("UPDATE agent_devices SET connection_epoch=2,last_seen_at=? WHERE runner_id='runner'", Date.now());
  assert.equal((await f.native("reconcile", confirm)).http, 409);
  const retry = await f.native("reconcile", { ...confirm, connectionEpoch: 2 });
  assert.equal(retry.settled, true);
  assert.deepEqual(await f.native("reconcile", { ...confirm, connectionEpoch: 2 }), retry);
  assert.equal((await f.state()).rows["exec:active"], undefined);
});

test("inspection fences late execution ACKs and never overrides a renewed live lease", async t => {
  const f = await fixture(t, "task");
  await f.sql("UPDATE agent_workspace_leases SET expires_at=? WHERE runner_id='runner'", Date.now() + 600000);
  assert.equal((await f.native("ack", { commandId: f.commandId, status: "stored" })).http, 200);
  assert.equal((await f.native("ack", { commandId: f.commandId, status: "applied" })).http, 200);
  assert.equal((await f.inspect()).http, 409, "an applied run with a live lease is not an expired delivery");
  await f.sql("UPDATE agent_workspace_leases SET expires_at=? WHERE runner_id='runner'", Date.now() - 1);
  const { ticket } = await f.inspect();
  assert.deepEqual(await f.native("ack", { commandId: f.commandId, status: "stored" }), { http: 200, ok: true, superseded: true });
  assert.deepEqual(await f.native("poll"), { http: 200, offers: [], deliveries: [] });
  assert.equal((await f.native("reconcile", f.confirmation(ticket))).http, 409, "applied execution contradicts never-dispatched evidence");
  await f.sql("UPDATE agent_workspace_leases SET expires_at=? WHERE runner_id='runner'", Date.now() + 600000);
  assert.equal((await f.native("reconcile", f.confirmation(ticket, "native_stopped"))).http, 409);
  assert.equal((await f.state()).run.view.stopConfirmed, false);
});

test("a live uncertain lease only permits read-only inspection until the lease is absent", async t => {
  const f = await fixture(t, "task");
  await f.sql("UPDATE agent_workspace_leases SET expires_at=? WHERE runner_id='runner'", Date.now() + 600000);
  const live = await f.inspect();
  assert.equal(live.ticket.action, "inspect_only");
  await f.sql("DELETE FROM agent_workspace_leases WHERE runner_id='runner'");
  const absent = await f.inspect();
  assert.equal(absent.ticket.action, "stop");
  assert.notEqual(absent.ticket.recoveryId, live.ticket.recoveryId);
  assert.equal((await f.native("reconcile", f.confirmation(live.ticket))).http, 409);
  assert.equal((await f.native("reconcile", f.confirmation(absent.ticket))).settled, true);
});

async function pausedRecovery(t) {
  const f = await fixture(t, "managed", "checkpoint");
  assert.equal((await f.native("ack", { commandId: f.commandId, status: "stored" })).http, 200);
  assert.equal((await f.native("ack", { commandId: f.commandId, status: "applied" })).http, 200);
  assert.equal((await f.fixture("control", { input: { bindingId: "binding", bindingRevision: 1, runId: f.runId, requestId: "pause-checkpoint", expectedRevision: 1, action: "pause" } })).http, 200);
  assert.equal((await f.native("batch-gate", { runId: f.runId, commandId: f.commandId, fromIndex: 0, completedTurnId: "turn0", reportRevision: 1 })).decision, "wait");
  assert.equal((await f.state()).run.queueState.phase, "paused");
  await f.sql("UPDATE agent_workspace_leases SET expires_at=? WHERE runner_id='runner'", Date.now() - 60000);
  assert.equal((await f.native("report", { runId: f.runId, commandId: f.commandId, revision: 2, status: "reconciliation_required", threadId: "thread", turnId: "turn0", terminal: false, stopConfirmed: false })).http, 200);
  const recover = { bindingId: "binding", bindingRevision: 1, runId: f.runId, requestId: "recover-checkpoint", expectedRevision: (await f.state()).run.view.queue.revision, action: "recover" };
  const accepted = await f.fixture("control", { input: recover });
  assert.equal(accepted.http, 200, JSON.stringify(accepted));
  const leaseInput = { runId: f.runId, commandId: f.commandId, threadId: "thread", completedTurnId: "turn0", leaseEpoch: 1 };
  const old = await f.native("recover-lease", { ...leaseInput, phase: "inspect" });
  assert.equal(old.decision, "inspect", JSON.stringify(old));
  return { f, recover, accepted, leaseInput, old, lease: await f.lease() };
}

test("sealed checkpoint rejects old native recovery after DO restart without renewing D1", async t => {
  const { f, leaseInput, old, lease } = await pausedRecovery(t);
  await f.fixture("inject", { fault: "inspect-after" });
  assert.equal((await f.inspect()).http, 500, "stop ticket committed but its response was lost");
  await f.restart();
  const { ticket } = await f.inspect();
  assert.equal(ticket.action, "stop");
  assert.equal((await f.native("recover-lease", { ...leaseInput, phase: "inspect" })).http, 409);
  assert.equal((await f.native("recover-lease", { ...leaseInput, phase: "confirm", recoveryId: old.recoveryId })).http, 409);
  const { run } = await f.state();
  assert.equal(run.commands.find(command => command.receipt.commandId === run.view.commandId).settled, true);
  assert.equal(run.queueState.recovery, undefined, "ticket invalidation shares the stop inspection commit");
  assert.deepEqual(await f.lease(), lease);
  assert.equal((await f.native("reconcile", f.confirmation(ticket, "native_stopped"))).settled, true);
  assert.deepEqual(await f.lease(), lease);
});

test("sealed checkpoint refuses new UI recovery while replaying an old receipt without recreating tickets", async t => {
  const { f, recover, accepted, lease } = await pausedRecovery(t);
  const { ticket } = await f.inspect();
  await f.restart();
  const input = { ...recover, requestId: "new-recover-after-stop", expectedRevision: (await f.state()).run.view.queue.revision };
  assert.equal((await f.fixture("control", { input })).http, 409);
  assert.deepEqual(await f.fixture("control", { input: recover }), accepted);
  assert.equal((await f.state()).run.queueState.recovery, undefined);
  assert.deepEqual(await f.lease(), lease);
  assert.equal((await f.native("reconcile", f.confirmation(ticket, "native_stopped"))).settled, true);
});
