import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(new URL("../../node_modules/wrangler/package.json", import.meta.url))("miniflare");
const bearer = "b".repeat(64);
const principal = { ownerId: "audit-owner", runnerId: "runner", bindingId: "binding", bindingRevision: 1, authEpoch: 1 };

function packet(socket, matches) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener("message", receive); };
    const receive = ({ data }) => {
      const value = JSON.parse(data);
      if (value.type === "error") { cleanup(); reject(Error(JSON.stringify(value))); }
      else if (matches(value)) { cleanup(); resolve(value); }
    };
    const timer = setTimeout(() => { cleanup(); reject(Error("Fixture socket response timed out")); }, 5000);
    socket.addEventListener("message", receive);
  });
}

export async function checklistWritebackFixture(t) {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const out = await mkdtemp(path.join(root, ".tmp/checklist-writeback-durable-"));
  let mf, db, socket, browser, device, runs, journal, registry, executor;
  let online = false, epoch = 0, source, runId;
  const packets = [], nativePath = path.join(out, "native.json");
  const closeNative = async () => {
    if (!executor) return;
    await executor.close({ stop: false });
    journal.close(); runs.close(); device.close(); executor = undefined;
  };
  t.after(async () => {
    browser?.close(); socket?.close();
    await closeNative(); await mf?.dispose();
    assert.equal(path.dirname(out), path.join(root, ".tmp"));
    await rm(out, { recursive: true, force: true });
  });
  const workspace = path.join(out, "project");
  await mkdir(workspace);
  execFileSync("git", ["-C", workspace, "init", "-q"]);
  await writeFile(path.join(workspace, "result.txt"), "accepted-output\n");
  await build({ entryPoints: [path.join(root, "tests/fixtures/checklist-writeback-durable-worker.ts")], bundle: true, platform: "neutral", mainFields: ["module", "main"], conditions: ["workerd", "browser"], external: ["node:*", "cloudflare:*"], format: "esm", outfile: path.join(out, "worker.mjs"), logLevel: "silent" });
  await build({ stdin: { resolveDir: root, contents: ["executor", "execution-store", "store", "device-store", "workspaces"].map(name => `export * from './runner/${name}.ts';`).join("") }, bundle: true, platform: "node", format: "esm", packages: "external", outfile: path.join(out, "native-api.mjs"), logLevel: "silent" });
  const api = await import(pathToFileURL(path.join(out, "native-api.mjs")));
  const devicePath = path.join(out, "device.sqlite");
  const initial = new api.DeviceStore(devicePath);
  let registered;
  try { registered = await new api.WorkspaceRegistry(initial, { locksDir: path.join(out, "locks") }).register({ root: workspace }); }
  finally { initial.close(); }
  const workspaceId = registered.workspaceId;
  const options = convertV4MiniflareOptions({ name: "checklist-writeback-durable", port: 0, scriptPath: path.join(out, "worker.mjs"), modules: true, compatibilityDate: "2026-10-19", compatibilityFlags: ["nodejs_compat"], cf: false, log: new Log(LogLevel.ERROR), d1Databases: ["DB"], durableObjects: { RUNNER_HUBS: { className: "WritebackHub", useSQLite: true }, ROOMS: { className: "WritebackCanvas", useSQLite: true } }, bindings: { APP_ENV: "test", RUNNER_ENABLED: "true", EXECUTION_ENABLED: "true", BATCH_QUEUE_ENABLED: "true" } });
  Object.assign(options, { isolatedResourcePersistencePath: path.join(out, "isolated"), resourcePersistencePath: path.join(out, "state"), unsafeEnableSharedStorage: true, unsafeDevRegistryPath: path.join(out, "registry") });
  mf = new Miniflare(options);
  db = await mf.getD1Database("DB");
  for (const file of (await readdir(path.join(root, "migrations"))).filter(file => file.endsWith(".sql")).sort()) {
    const sql = (await readFile(path.join(root, "migrations", file), "utf8")).replace(/^--.*$/gm, "");
    await db.batch(sql.split(";").filter(statement => statement.trim()).map(statement => db.prepare(statement)));
  }
  await db.batch([
    db.prepare("INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('audit-owner','audit-owner','Audit','unused','2026')"),
    db.prepare("INSERT INTO rooms VALUES('canvas','Audit','audit-owner','unused','2026')"),
    db.prepare("INSERT INTO members VALUES('canvas','audit-owner','owner','2026')"),
    db.prepare("INSERT INTO account_sessions VALUES('audit-session','audit-owner',?)").bind(Date.now() + 120000),
    db.prepare("INSERT INTO agent_devices(runner_id,owner_id,device_name,secret_hash,workspaces_json,connection_epoch,last_seen_at) VALUES('runner','audit-owner','Audit','unused',?,0,?)").bind(JSON.stringify([registered]), Date.now()),
    db.prepare("INSERT INTO agent_bindings VALUES('binding','audit-owner','canvas','ungrouped','runner',?,1,1)").bind(workspaceId),
    db.prepare("INSERT INTO agent_connection_tokens VALUES(?,'runner','runner-connect',1,?)").bind(createHash("sha256").update(bearer).digest("hex"), Date.now() + 120000),
  ]);
  async function post(route, input) {
    const response = await mf.dispatchFetch("https://audit.test" + route, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + bearer }, body: JSON.stringify(input) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(JSON.stringify(value)), { code: `EXECUTION_HTTP_${response.status}` });
    return value;
  }
  async function connect() {
    const response = await mf.dispatchFetch("https://audit.test/fixture/connect", { headers: { Upgrade: "websocket", Authorization: "Bearer " + bearer } });
    assert.equal(response.status, 101);
    socket = response.webSocket;
    const welcome = packet(socket, value => value.type === "welcome");
    socket.accept();
    epoch = (await welcome).connectionEpoch; online = true;
  }
  async function send(type, fields, responseType) {
    const requestId = crypto.randomUUID();
    const response = packet(socket, value => value.type === responseType && value.requestId === requestId);
    socket.send(JSON.stringify({ protocolVersion: 1, connectionEpoch: epoch, type, requestId, ...fields }));
    return response;
  }
  const transport = {
    get status() { return { connectionStatus: online ? "online" : "offline", connectionEpoch: epoch }; },
    async executionRequest(action, input) {
      assert.equal(online, true, "offline Runner cannot drive a writeback retry");
      const result = await post("/api/runner/execution/" + action, { ...input, connectionEpoch: epoch });
      packets.push({ action, input: structuredClone(input), result: structuredClone(result) });
      return result;
    },
    async acceptExecutionEnvelope(envelope) { return device.receiveCommand(envelope, { status: "stored" }); },
    async claimLease(id, idRun) {
      const value = await send("lease_claim", { workspaceId: id, runId: idRun }, "lease_granted");
      const lease = { workspaceId: value.workspaceId, runId: value.runId, leaseEpoch: value.leaseEpoch, expiresAt: value.expiresAt };
      device.saveLease(lease); return lease;
    },
    async releaseLease(id, idRun, confirmedStopped) {
      assert.equal(confirmedStopped, true);
      const lease = device.lease(idRun);
      await send("lease_release", { workspaceId: id, runId: idRun, leaseEpoch: lease.leaseEpoch, confirmedStopped }, "lease_released");
      device.removeLease(id);
    },
  };
  function openNative() {
    device = new api.DeviceStore(devicePath);
    registry = new api.WorkspaceRegistry(device, { locksDir: path.join(out, "locks") });
    runs = new api.RunnerStore(path.join(out, "runs.sqlite"));
    journal = new api.ExecutionStore(path.join(out, "execution.sqlite"));
    executor = new api.RunnerExecutor({ device, registry, runs, store: journal, transport: () => transport, runnerId: "runner", ownerId: "audit-owner", authEpoch: 1, codex: { command: process.execPath, args: [path.join(root, "tests/fixtures/fake-codex.mjs")], env: { ...process.env, FAKE_CODEX_STATE: nativePath }, requestTimeoutMs: 900, shutdownTimeoutMs: 100 } });
  }
  await connect(); openNative();
  const fixture = {
    packets, get executor() { return executor; }, get runs() { return runs; },
    state: () => post("/fixture/hub", { op: "state" }),
    async canvas() {
      const value = await post("/fixture/canvas/fixture", {});
      const row = value.rows.find(row => row.id === source?.noteId);
      return { ...value, task: row?.data.blocks.find(block => block.id === source.taskId) };
    },
    async nativeState() { return JSON.parse(await readFile(nativePath, "utf8")); },
    async lease() { return db.prepare("SELECT * FROM agent_workspace_leases WHERE runner_id='runner'").first(); },
    async create() {
      await executor.context(workspaceId);
      const checklist = await post("/fixture/canvas/checklist", { principal, input: { action: "create", requestId: "create-durable-task", tasks: [{ text: "Verify local file", instruction: "Produce the required local artifact", acceptance: "File contains accepted-output", acceptanceChecks: [{ id: "file-check", kind: "artifact", required: true, description: "Result contains accepted-output", relativePath: "result.txt", predicate: { type: "textContains", text: "accepted-output" } }] }] } });
      const task = checklist.tasks[0];
      source = { noteId: task.noteId, taskId: task.taskId, generation: task.generation, specRevision: task.specRevision };
      const receipt = await post("/fixture/hub", { op: "create", tasks: [source] });
      runId = receipt.runId; return receipt;
    },
    async reopenTask() {
      const before = await fixture.canvas();
      const row = before.rows.find(row => row.id === source.noteId);
      const response = await mf.dispatchFetch("https://audit.test/fixture/canvas/socket", { headers: { Upgrade: "websocket", "X-QD-Room": "canvas", "X-QD-User": "audit-owner", "X-QD-Expires": String(Date.now() + 60000), "X-QD-Session": "audit-session", "X-QD-Task-Authors": "1" } });
      assert.equal(response.status, 101); browser = response.webSocket;
      const acknowledged = packet(browser, value => value.type === "ack" && value.opId === "user-reopen");
      browser.accept();
      const task = row.data.blocks.find(block => block.id === source.taskId);
      task.done = false; task.completedAt = null;
      browser.send(JSON.stringify({ type: "commit", opId: "user-reopen", changes: [{ id: row.id, expectedRevision: row.revision, data: row.data }] }));
      await acknowledged; browser.close(); browser = undefined;
    },
    async restartOffline() {
      online = false; socket.close(); socket = undefined;
      await closeNative(); await mf.dispose();
      mf = new Miniflare(options); db = await mf.getD1Database("DB");
      openNative();
    },
    reconnect: connect,
    async until(predicate) {
      for (let n = 0; n < 100; n++) {
        await executor.tick();
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`Runner did not reach expected state: ${JSON.stringify((await fixture.state()).rows["exec:run:" + runId]?.view)}`);
    },
    async waitFor(predicate) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail("Persisted writeback alarm did not finish while Runner stayed offline");
    },
  };
  return fixture;
}
