import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(new URL("../../node_modules/wrangler/package.json", import.meta.url))("miniflare");
const bearer = "a".repeat(64), sha = text => createHash("sha256").update(text).digest("hex");
export async function durableDispatchFixture(t, kind = "managed", mode = "expired") {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const out = await mkdtemp(path.join(root, ".tmp/execution-durable-"));
  await build({ entryPoints: [path.join(root, "tests/fixtures/execution-durable-worker.ts")], bundle: true, platform: "neutral", format: "esm", mainFields: ["module", "main"], conditions: ["workerd", "browser"], external: ["node:*", "cloudflare:*"], outfile: path.join(out, "worker.mjs"), logLevel: "silent" });
  const options = convertV4MiniflareOptions({ name: "execution-durable", port: 0, scriptPath: path.join(out, "worker.mjs"), modules: true, compatibilityDate: "2026-10-19", compatibilityFlags: ["nodejs_compat"], cf: false, log: new Log(LogLevel.ERROR), d1Databases: ["DB"], durableObjects: { RUNNER_HUBS: { className: "RecoveryHub", useSQLite: true } }, bindings: { APP_ENV: "test", RUNNER_ENABLED: "true", EXECUTION_ENABLED: "true", BATCH_QUEUE_ENABLED: "true" } });
  Object.assign(options, { isolatedResourcePersistencePath: path.join(out, "isolated"), resourcePersistencePath: path.join(out, "state"), unsafeEnableSharedStorage: true, unsafeDevRegistryPath: path.join(out, "registry") });
  let mf = new Miniflare(options), db, nativeCleanup;
  t.after(async () => { await nativeCleanup?.(); await mf.dispose(); await rm(out, { recursive: true, force: true }); });
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
    ...seeded, out, fixture: fixtureCall,
    closeNativeFirst(cleanup) { nativeCleanup = cleanup; },
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
