import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import WebSocket, { WebSocketServer } from "ws";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  cp,
} from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as manager from "../scripts/lib/agent-install.mjs";
import * as launcher from "../scripts/lib/agent-experience-launcher.mjs";
import * as bridge from "../scripts/lib/agent-install-bridge.mjs";
import { ExperienceService } from "../scripts/lib/agent-experience-service.mjs";
import { createExperienceServer } from "../scripts/lib/agent-experience-server.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function until(check) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(10);
  }
  assert.fail("condition did not settle");
}
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "qd-lifecycle-"));
  const root = path.join(base, "before");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "qingdan-canvas",
      scripts: { "dev:agent": "node scripts/dev-agent.mjs" },
    }),
  );
  await writeFile(
    path.join(root, "scripts/dev-agent.mjs"),
    "setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0));\n",
  );
  await writeFile(
    path.join(root, "scripts/agent-install.mjs"),
    `import ${JSON.stringify(new URL("../scripts/agent-install.mjs", import.meta.url).href)};\n`,
  );
  const f = {
    root,
    stateDir: path.join(root, ".tmp/agent-install-test"),
    checkDependencies: false,
    probePort: async () => true,
    probeReady: async () => true,
    startupTimeoutMs: 3000,
    locksDir: path.join(base, "locks"),
  };
  t.after(async () => {
    for (const options of [f, f.moved].filter(Boolean))
      await manager.stop({ ...options, interruptActive: true }).catch(() => {});
    assert.ok(
      path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    await rm(base, { recursive: true, force: true });
  });
  await manager.install(f);
  f.move = async () => {
    const movedRoot = path.join(base, "after");
    assert.ok(
      path.resolve(root).startsWith(base + path.sep) &&
        movedRoot.startsWith(base + path.sep),
    );
    await rename(root, movedRoot);
    f.moved = {
      ...f,
      root: movedRoot,
      stateDir: path.join(movedRoot, ".tmp/agent-install-test"),
      relocate: true,
    };
    return f.moved;
  };
  return f;
}
async function experience(root, status = "passed") {
  const id = randomUUID(),
    workspace = path.join(root, ".tmp/agent-experience/projects", id);
  await mkdir(workspace, { recursive: true });
  await mkdir(workspace + ".runner");
  const db = new DatabaseSync(
    path.join(workspace + ".runner", "runner.sqlite"),
  );
  db.exec("CREATE TABLE runs (data TEXT NOT NULL)");
  db.prepare("INSERT INTO runs VALUES (?)").run(
    JSON.stringify({ active: false, terminal: true }),
  );
  db.close();
  const ledger = {
    version: 1,
    currentId: id,
    sessions: {
      [id]: {
        id,
        workspace,
        status,
        attemptAt: "2026-11-01T00:00:00Z",
        progress: [],
      },
    },
  };
  await writeFile(
    path.join(root, ".tmp/agent-experience/sessions.json"),
    JSON.stringify(ledger),
  );
  return { id, workspace, ledger };
}

test("explicit relocation preserves identity and terminal experience evidence, then starts at the new root", async (t) => {
  const f = await fixture(t),
    entry = await experience(f.root);
  const key = await readFile(path.join(f.stateDir, "control.key"), "utf8");
  const original = JSON.parse(
    await readFile(path.join(f.stateDir, "install.json"), "utf8"),
  );
  const moved = await f.move();
  await assert.rejects(manager.start(moved), /identity/);
  assert.equal(
    typeof manager.repair,
    "function",
    "explicit relocation repair is missing",
  );
  const result = await manager.repair(moved);
  assert.equal(result.repaired, true);
  const manifest = JSON.parse(
    await readFile(path.join(moved.stateDir, "install.json"), "utf8"),
  );
  assert.equal(manifest.installationId, original.installationId);
  assert.equal(manifest.projectRoot, moved.root);
  assert.equal(
    await readFile(path.join(moved.stateDir, "control.key"), "utf8"),
    key,
  );
  const service = new ExperienceService({ projectRoot: moved.root });
  assert.equal(
    (await service.status()).current.workspace,
    path.join(moved.root, ".tmp/agent-experience/projects", entry.id),
  );
  await service.close();
  assert.equal((await manager.start(moved)).ready, true);
  await manager.stop(moved);
  assert.equal((await manager.repair(moved)).repaired, true);
  if (process.platform === "win32") {
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(moved.stateDir, "agent.ps1"),
        "-Action",
        "repair",
        "-Relocate",
      ],
      { cwd: os.tmpdir(), windowsHide: true },
    );
    assert.equal(JSON.parse(stdout).alreadyRepaired, true);
  }
});

test("relocation refuses copies, live unverified PID and active experience without changing evidence", async (t) => {
  assert.equal(
    typeof manager.repair,
    "function",
    "explicit relocation repair is missing",
  );
  const f = await fixture(t);
  const copyRoot = path.join(path.dirname(f.root), "copy");
  await cp(f.root, copyRoot, { recursive: true });
  await assert.rejects(
    manager.repair({
      ...f,
      root: copyRoot,
      stateDir: path.join(copyRoot, ".tmp/agent-install-test"),
      relocate: true,
    }),
    /old checkout|copy/i,
  );
  await writeFile(
    path.join(f.stateDir, "runtime.json"),
    JSON.stringify({ pid: process.pid, instanceId: randomUUID() }),
  );
  const moved = await f.move();
  const before = await readFile(
    path.join(moved.stateDir, "install.json"),
    "utf8",
  );
  await assert.rejects(manager.repair(moved), /live|unverified|identity/i);
  await rm(path.join(moved.stateDir, "runtime.json"));
  await experience(moved.root, "needs_review");
  await assert.rejects(manager.repair(moved), /active|unknown|review|核对/i);
  assert.equal(
    await readFile(path.join(moved.stateDir, "install.json"), "utf8"),
    before,
  );
});

test("relocation can resume after ledger publication but before manifest publication", async (t) => {
  assert.equal(
    typeof manager.repair,
    "function",
    "explicit relocation repair is missing",
  );
  const f = await fixture(t);
  await experience(f.root);
  await deviceEvidence(f.root, "never-created");
  const moved = await f.move();
  const originalRename = fsPromises.rename;
  let interrupted = false;
  t.mock.method(fsPromises, "rename", async (from, to) => {
    if (!interrupted && to === path.join(moved.stateDir, "install.json")) {
      interrupted = true;
      throw Error("fixture interrupted publication");
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(manager.repair(moved), /fixture interrupted/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(interrupted, true);
  await assert.rejects(manager.start(moved), /repair|relocation|identity/i);
  await assert.rejects(
    async () => {
      const control = await bridge.openSourceControl({ root: moved.root });
      await control.close();
    },
    /repair|relocation/i,
    "a source launcher must not bypass an interrupted relocation",
  );
  const ledgerFile = path.join(
    moved.root,
    ".tmp/agent-experience/sessions.json",
  );
  const savedLedger = await readFile(ledgerFile, "utf8");
  const activeLedger = JSON.parse(savedLedger);
  Object.values(activeLedger.sessions)[0].status = "needs_review";
  await writeFile(ledgerFile, JSON.stringify(activeLedger));
  await assert.rejects(manager.repair(moved), /active|unknown|review|核对/i);
  await writeFile(ledgerFile, savedLedger);
  await manager.repair(moved);
  const service = new ExperienceService({ projectRoot: moved.root });
  assert.equal((await service.status()).current.status, "passed");
  await service.close();
  assert.equal((await manager.diagnose(moved)).status, "stopped");
});

test("relocation also verifies another source controller in the moved checkout", async (t) => {
  const f = await fixture(t);
  const control = await bridge.openSourceControl({ root: f.root });
  t.after(() => control.close());
  const moved = await f.move();
  try {
    await assert.rejects(
      manager.repair(moved),
      /live|running|unverified|identity/i,
    );
  } finally {
    await control.close();
  }
});

test("explicit source relocation repairs its management identity without installing an entry script", async (t) => {
  const f = await fixture(t);
  const control = await bridge.openSourceControl({ root: f.root });
  await control.close();
  const moved = await f.move(),
    options = {
      ...moved,
      source: true,
      stateDir: path.join(moved.root, ".tmp/agent-install-source"),
    };
  await manager.repair(options);
  assert.equal((await manager.diagnose(options)).status, "stopped");
  await assert.rejects(readFile(path.join(options.stateDir, "agent.ps1")), {
    code: "ENOENT",
  });
});

for (const mode of ["authenticated", "invalid-proof", "silent"]) {
  test(
    `relocation refuses an ${mode} old control endpoint even without a runtime record`,
    { skip: process.platform !== "win32" },
    async (t) => {
      const f = await fixture(t);
      const manifest = JSON.parse(
        await readFile(path.join(f.stateDir, "install.json"), "utf8"),
      );
      const secret = await readFile(
        path.join(f.stateDir, "control.key"),
        "utf8",
      );
      const sockets = new Set();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        let challenge,
          identity = {
            projectRoot: manifest.projectRoot,
            installationId: manifest.installationId,
            pid: process.pid,
            instanceId: randomUUID(),
          };
        socket.on("data", (buffer) => {
          const value = JSON.parse(buffer.toString().trim());
          if (mode === "silent") return;
          if (value.challenge) {
            challenge = value.challenge;
            socket.write(
              JSON.stringify({
                identity,
                proof:
                  mode === "invalid-proof"
                    ? "0".repeat(64)
                    : manager.signature(secret, [
                        "server",
                        challenge,
                        identity,
                      ]),
              }) + "\n",
            );
          } else {
            const result = {
              ...identity,
              active: { count: 0, unknown: [] },
              stopping: false,
            };
            socket.end(
              JSON.stringify({
                result,
                proof: manager.signature(secret, [
                  "result",
                  challenge,
                  identity,
                  result,
                ]),
              }) + "\n",
            );
          }
        });
      });
      await new Promise((r) => server.listen(manager.pipeAddress(manifest), r));
      const moved = await f.move();
      const before = await readFile(
        path.join(moved.stateDir, "install.json"),
        "utf8",
      );
      try {
        await assert.rejects(
          manager.repair(moved),
          mode === "authenticated"
            ? /still running/
            : mode === "silent"
              ? /timed out/
              : /identity/,
        );
        assert.equal(
          await readFile(path.join(moved.stateDir, "install.json"), "utf8"),
          before,
        );
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((r) => server.close(r));
      }
    },
  );
}

async function deviceEvidence(root, kind) {
  const dir = path.join(root, ".tmp/runner-device"),
    runnerId = randomUUID();
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "device.sqlite"));
  db.exec(
    "CREATE TABLE metadata(key TEXT PRIMARY KEY,data TEXT); CREATE TABLE leases(data TEXT); CREATE TABLE workspaces(data TEXT); CREATE TABLE commands(data TEXT,receipt TEXT);",
  );
  db.prepare("INSERT INTO metadata VALUES ('device',?)").run(
    JSON.stringify({ ownerId: "audit-owner", runnerId }),
  );
  if (kind === "lease")
    db.prepare("INSERT INTO leases VALUES (?)").run(
      JSON.stringify({ runId: "old", expiresAt: 1 }),
    );
  if (kind === "missing")
    db.prepare("INSERT INTO commands VALUES (?,?)").run(
      JSON.stringify({ commandId: "cmd", runId: "run" }),
      JSON.stringify({ status: "stored" }),
    );
  db.close();
  if (["never-created", "lease", "missing"].includes(kind)) return;
  const execution = path.join(
    dir,
    "execution",
    createHash("sha256")
      .update(JSON.stringify(["audit-owner", runnerId]))
      .digest("hex"),
  );
  await mkdir(execution, { recursive: true });
  const journal = new DatabaseSync(path.join(execution, "execution.sqlite"));
  journal.exec(
    "CREATE TABLE state(key TEXT,data TEXT); CREATE TABLE commands(key TEXT,data TEXT); CREATE TABLE runs(key TEXT,data TEXT);",
  );
  if (kind === "held")
    journal
      .prepare("INSERT INTO state VALUES ('held',?)")
      .run(JSON.stringify({ runId: "r", phase: "local_release" }));
  journal.close();
  if (kind === "non-file") {
    await mkdir(path.join(execution, "adapter.sqlite"));
    return;
  }
  const runs = new DatabaseSync(path.join(execution, "adapter.sqlite"));
  runs.exec("CREATE TABLE runs(run_id TEXT,data TEXT);");
  if (kind === "native")
    runs
      .prepare("INSERT INTO runs VALUES ('r',?)")
      .run(JSON.stringify({ active: false, terminal: false }));
  runs.close();
}
for (const kind of ["lease", "missing", "held", "native", "non-file"]) {
  test(`relocation refuses ${kind} device evidence without initializing or clearing it`, async (t) => {
    assert.equal(
      typeof manager.repair,
      "function",
      "explicit relocation repair is missing",
    );
    const f = await fixture(t);
    await deviceEvidence(f.root, kind);
    const moved = await f.move();
    const file = path.join(moved.root, ".tmp/runner-device/device.sqlite");
    const before = await readFile(file);
    await assert.rejects(
      manager.repair(moved),
      /active|unknown|evidence|held|lease|journal|核对/i,
    );
    assert.deepEqual(await readFile(file), before);
  });
}
test("relocation preserves a known never-created executor and external workspace registration", async (t) => {
  assert.equal(
    typeof manager.repair,
    "function",
    "explicit relocation repair is missing",
  );
  const f = await fixture(t);
  await deviceEvidence(f.root, "never-created");
  const file = path.join(f.root, ".tmp/runner-device/device.sqlite");
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO workspaces VALUES (?)").run(
    JSON.stringify({
      root: path.dirname(f.root),
      lockRoot: path.dirname(f.root),
    }),
  );
  db.close();
  const before = await readFile(file),
    moved = await f.move();
  await manager.repair(moved);
  assert.deepEqual(
    await readFile(path.join(moved.root, ".tmp/runner-device/device.sqlite")),
    before,
  );
  await manager.start(moved);
  assert.equal((await manager.stop(moved)).stopped, true);
});

test("ordinary stop still refuses unknown files, WAL, non-file journals and unmatched executor identities", async (t) => {
  const f = await fixture(t);
  await deviceEvidence(f.root, "never-created");
  const moved = await f.move();
  await manager.repair(moved);
  await manager.start(moved);
  const base = path.join(moved.root, ".tmp/runner-device/execution");
  const current = path.join(base, (await fsPromises.readdir(base))[0]);
  for (const entry of [
    "unrecognized.dat",
    "execution.sqlite-wal",
    "execution.sqlite.consumer-journal",
    "adapter.sqlite",
    "foreign",
  ]) {
    const target =
      entry === "foreign" ? path.join(base, entry) : path.join(current, entry);
    assert.ok(target.startsWith(moved.root + path.sep));
    if (["adapter.sqlite", "foreign"].includes(entry)) await mkdir(target);
    else await writeFile(target, "fixture evidence");
    try {
      await assert.rejects(manager.stop(moved), /active|unknown/i);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  }
  await manager.stop(moved);
});

for (const kind of [
  "foreign identity",
  "unknown residue",
  "stale consumer journal",
]) {
  test(`relocation refuses a missing journal with ${kind}`, async (t) => {
    const f = await fixture(t);
    await deviceEvidence(f.root, "never-created");
    await experience(f.root);
    const device = new DatabaseSync(
      path.join(f.root, ".tmp/runner-device/device.sqlite"),
      { readOnly: true },
    );
    const config = JSON.parse(
      device.prepare("SELECT data FROM metadata WHERE key='device'").get().data,
    );
    device.close();
    const key =
      kind === "foreign identity"
        ? "other-identity"
        : createHash("sha256")
            .update(JSON.stringify([config.ownerId, config.runnerId]))
            .digest("hex");
    const directory = path.join(f.root, ".tmp/runner-device/execution", key);
    await mkdir(directory, { recursive: true });
    if (kind === "stale consumer journal") {
      const consumer = new DatabaseSync(
        path.join(directory, "execution.sqlite.consumer"),
      );
      consumer.exec(
        "CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('retained consumer');",
      );
      consumer.close();
      await writeFile(
        path.join(directory, "execution.sqlite.consumer-journal"),
        "retained evidence",
      );
    }
    if (kind === "unknown residue")
      await writeFile(
        path.join(directory, "unrecognized.dat"),
        "retained evidence",
      );
    const moved = await f.move();
    const movedDirectory = path.join(
      moved.root,
      ".tmp/runner-device/execution",
      key,
    );
    const files = {
      manifest: path.join(moved.stateDir, "install.json"),
      ledger: path.join(moved.root, ".tmp/agent-experience/sessions.json"),
      entry: path.join(moved.stateDir, "agent.ps1"),
      consumer: path.join(movedDirectory, "execution.sqlite.consumer"),
      ...(kind === "stale consumer journal"
        ? {
            residue: path.join(
              movedDirectory,
              "execution.sqlite.consumer-journal",
            ),
          }
        : {}),
      ...(kind === "unknown residue"
        ? { residue: path.join(movedDirectory, "unrecognized.dat") }
        : {}),
    };
    const bytes = (file) =>
      readFile(file).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    const before = new Map(
      await Promise.all(
        Object.entries(files).map(async ([name, file]) => [
          name,
          await bytes(file),
        ]),
      ),
    );
    const attempts = [];
    // Run both attempts before asserting: a destructive first refusal must not
    // turn the same retained directory into an accepted second repair.
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await manager.repair(moved).then(
        () => false,
        (error) => {
          assert.match(error.message, /active|unknown|evidence/i);
          return true;
        },
      );
      const unchanged = Object.fromEntries(
        await Promise.all(
          Object.entries(files).map(async ([name, file]) => {
            const after = await bytes(file),
              prior = before.get(name);
            return [
              name,
              prior === null
                ? after === null
                : after !== null && prior.equals(after),
            ];
          }),
        ),
      );
      attempts.push({ rejected, ...unchanged });
    }
    const expected = {
      rejected: true,
      ...Object.fromEntries(Object.keys(files).map((name) => [name, true])),
    };
    assert.deepEqual(attempts, [expected, expected]);
  });
}

test("relocation reserves the known never-created executor until publication finishes", async (t) => {
  const f = await fixture(t);
  await deviceEvidence(f.root, "never-created");
  const moved = await f.move();
  const device = new DatabaseSync(
    path.join(moved.root, ".tmp/runner-device/device.sqlite"),
    { readOnly: true },
  );
  const config = JSON.parse(
    device.prepare("SELECT data FROM metadata WHERE key='device'").get().data,
  );
  device.close();
  const directory = path.join(
    moved.root,
    ".tmp/runner-device/execution",
    createHash("sha256")
      .update(JSON.stringify([config.ownerId, config.runnerId]))
      .digest("hex"),
  );
  let protectedDuringPublish = false,
    ownJournalDuringPublish = false;
  const originalRename = fsPromises.rename;
  t.mock.method(fsPromises, "rename", async (from, to) => {
    if (to === path.join(moved.stateDir, "install.json")) {
      await mkdir(directory, { recursive: true });
      ownJournalDuringPublish = await readFile(
        path.join(directory, "execution.sqlite.consumer-journal"),
      ).then(
        () => true,
        () => false,
      );
      const competing = new DatabaseSync(
        path.join(directory, "execution.sqlite.consumer"),
      );
      try {
        competing.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      } catch (error) {
        protectedDuringPublish = /locked/.test(String(error));
      } finally {
        competing.close();
      }
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await manager.repair(moved);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(
    protectedDuringPublish,
    true,
    "a new executor could start during relocation publication",
  );
  assert.equal(
    ownJournalDuringPublish,
    true,
    "the current reservation's own journal was not exercised",
  );
  await assert.rejects(readFile(path.join(directory, "execution.sqlite")), {
    code: "ENOENT",
  });
});

async function stalledProxy(t, options = {}) {
  const pending = new Set();
  const upstream = createServer();
  upstream.on("upgrade", (_req, socket) => {
    pending.add(socket);
    socket.resume();
    socket.on("end", () => socket.end());
    socket.on("close", () => pending.delete(socket));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const server = createExperienceServer({
    service: {},
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    ...options,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const client = net.createConnection({ host: "127.0.0.1", port });
  client.on("error", () => {});
  client.resume();
  t.after(async () => {
    client.destroy();
    for (const socket of pending) socket.destroy();
    server.closeConnections();
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
  });
  await once(client, "connect");
  client.write(
    `GET /api/test HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
  );
  await until(() => pending.size === 1);
  return { server, client, pending };
}
test("closing the proxy tears down pending upgrades while the upstream remains alive", async (t) => {
  const f = await stalledProxy(t);
  f.server.closeConnections();
  const closed = new Promise((r) => f.server.close(() => r(true)));
  assert.equal(
    await Promise.race([closed, pause(400).then(() => false)]),
    true,
    "pending upgrade kept the server alive",
  );
  await until(() => f.client.destroyed && f.pending.size === 0);
});
test("a stalled upstream opening handshake has a finite timeout", async (t) => {
  const f = await stalledProxy(t, { handshakeTimeoutMs: 50 });
  await pause(250);
  assert.equal(
    f.client.destroyed,
    true,
    "opening handshake was never timed out",
  );
  assert.equal(f.pending.size, 0);
});
test("proxy shutdown terminates established WebSockets and refuses subsequent upgrades", async () => {
  const upstream = createServer(),
    peers = new WebSocketServer({ server: upstream });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const server = createExperienceServer({
    service: {},
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = new WebSocket(origin.replace("http:", "ws:") + "/api/test", {
    origin,
  });
  let late;
  try {
    await once(first, "open");
    const closed = once(first, "close");
    server.closeConnections();
    await closed;
    late = new WebSocket(origin.replace("http:", "ws:") + "/api/test", {
      origin,
    });
    late.on("error", () => {});
    await new Promise((resolve) => late.once("close", resolve));
    assert.equal(late.readyState, WebSocket.CLOSED);
    await until(() => peers.clients.size === 0);
  } finally {
    first.terminate();
    late?.terminate();
    server.closeConnections();
    await new Promise((r) => server.close(r));
    for (const peer of peers.clients) peer.terminate();
    await new Promise((r) => peers.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

test("web supervisor exhausts three retries then manual recovery uses the same initialized runner", async () => {
  assert.equal(
    typeof launcher.createWebSupervisor,
    "function",
    "web-only supervisor is missing",
  );
  const delays = [],
    states = [];
  let runs = 0,
    initialized = 0,
    builds = 0;
  const live = deferred();
  const supervisor = launcher.createWebSupervisor({
    run: async () => {
      runs++;
      if (runs <= 4) throw Error("offline");
      await live.promise;
    },
    sleep: async (ms) => delays.push(ms),
    onState: (state) => states.push(state),
  });
  const done = launcher.startExperience({
    root: process.cwd(),
    run: async () => builds++,
    onReady: async () => initialized++,
    isClosing: () => false,
    supervisor,
  });
  await until(() => supervisor.status().phase === "recovery_required");
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(runs, 4);
  assert.equal(initialized, 1);
  assert.equal(builds, 1);
  supervisor.recover();
  supervisor.recover();
  await until(() => runs === 5);
  assert.equal(initialized, 1);
  supervisor.close();
  live.resolve();
  await done;
  assert.equal(states.at(-1).phase, "stopped");
});
test("closing during web retry backoff prevents a late child launch", async () => {
  assert.equal(
    typeof launcher.createWebSupervisor,
    "function",
    "web-only supervisor is missing",
  );
  let runs = 0;
  const supervisor = launcher.createWebSupervisor({
    run: async () => {
      runs++;
      throw Error("offline");
    },
  });
  const done = supervisor.start();
  await until(() => supervisor.status().phase === "backoff");
  supervisor.close();
  await done;
  await tick();
  assert.equal(runs, 1);
});
