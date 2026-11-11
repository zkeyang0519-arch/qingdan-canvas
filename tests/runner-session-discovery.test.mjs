import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const base = await mkdtemp(path.resolve(".tmp/session-discovery-"));
await build({
  stdin: {
    contents:
      "export * from './runner/device-controller.ts'; export * from './runner/credentials.ts';",
    resolveDir: process.cwd(),
  },
  outfile: path.join(base, "api.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
});
const { RunnerDeviceController, MemoryCredentialStore } = await import(
  pathToFileURL(path.join(base, "api.mjs"))
);
test.after(() => rm(base, { recursive: true, force: true }));

async function fixture(t) {
  const dir = await mkdtemp(path.join(base, "case-"));
  const project = path.join(dir, "project");
  await mkdir(project);
  const statePath = path.join(dir, "codex.json");
  const threads = [
    {
      id: "session-a",
      name: "网站迭代",
      cwd: project,
      source: "vscode",
      updatedAt: 100,
      status: { type: "idle" },
      turns: [],
    },
    {
      id: "session-b",
      name: "另一项目",
      cwd: path.join(dir, "missing"),
      source: "cli",
      updatedAt: 90,
      status: { type: "idle" },
      turns: [],
    },
  ];
  await writeFile(statePath, JSON.stringify({ threads, calls: [] }));
  let registered = [];
  const controller = new RunnerDeviceController({
    stateDir: path.join(dir, "device"),
    serverOrigin: "http://127.0.0.1:8788",
    credentials: new MemoryCredentialStore(),
    locksDir: path.join(dir, "locks"),
    executionCodex: {
      command: process.execPath,
      args: [path.resolve("tests/fixtures/fake-codex.mjs")],
      env: { ...process.env, FAKE_CODEX_STATE: statePath },
      shutdownTimeoutMs: 100,
    },
    fetch: async (_url, init) =>
      new Response(
        JSON.stringify({
          runnerId: JSON.parse(init.body).runnerId,
          ownerId: "alice",
          authEpoch: 1,
        }),
      ),
    transportFactory: (options) => ({
      status: {
        connectionStatus: "online",
        connectionEpoch: 1,
        lastHeartbeatAt: null,
        error: null,
      },
      start: async () => {},
      close() {},
      reconnect() {},
      updateWorkspaces: async () => {
        registered = options.workspaces();
      },
    }),
  });
  t.after(() => controller.close());
  return {
    controller,
    project,
    statePath,
    state: async () => JSON.parse(await readFile(statePath, "utf8")),
    registered: () => registered,
    pair: () =>
      controller.pair({
        ownerId: "alice",
        pairingCode: "code",
        deviceName: "我的电脑",
      }),
  };
}

test("sessions are discoverable before pairing or directory registration and preserve pagination", async (t) => {
  const f = await fixture(t);
  const first = await f.controller.listCodexSessions("alice", {});
  assert.equal(first.sessions[0].threadId, "session-a");
  assert.equal(first.sessions[0].cwd, f.project);
  assert.equal(first.nextCursor, "1");
  const second = await f.controller.listCodexSessions("alice", {
    cursor: first.nextCursor,
    searchTerm: "另一",
  });
  assert.equal(second.sessions[0].threadId, "session-b");
  assert.equal(second.nextCursor, null);
  assert.deepEqual(f.controller.status("alice").workspaces, []);
  const calls = (await f.state()).calls;
  const listed = calls.filter((c) => c.method === "thread/list");
  assert.equal(listed[0].params.cwd, undefined);
  assert.equal(listed[1].params.searchTerm, "另一");
  assert.equal(listed[0].params.sortKey, "updated_at");
  assert.ok(
    !calls.some((c) =>
      ["thread/start", "thread/resume", "turn/start"].includes(c.method),
    ),
  );
});

test("selecting reads the actual session directory, registers it once and never executes the source thread", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.controller.selectCodexSession("alice", "session-a"));
  await f.pair();
  const selected = await f.controller.selectCodexSession("alice", "session-a");
  assert.equal(selected.workspace.displayPath, f.project);
  assert.equal(selected.session.threadId, "session-a");
  assert.equal(selected.runnerId, f.controller.status("alice").runnerId);
  assert.equal(f.registered().length, 1);
  const again = await f.controller.selectCodexSession("alice", "session-a");
  assert.equal(again.workspace.workspaceId, selected.workspace.workspaceId);
  await assert.rejects(f.controller.selectCodexSession("alice", "session-b"));
  await assert.rejects(
    f.controller.selectCodexSession("alice", "missing-thread"),
  );
  assert.equal(f.controller.status("alice").workspaces.length, 1);
  assert.ok(
    !(await f.state()).calls.some((c) =>
      ["thread/start", "thread/resume", "turn/start"].includes(c.method),
    ),
  );
});

test("another signed-in account cannot enumerate or select this paired device's sessions", async (t) => {
  const f = await fixture(t);
  await f.pair();
  assert.throws(() => f.controller.status("bob"), {
    code: "OWNER_MISMATCH",
    message: /已绑定其他轻单账号/,
  });
  await assert.rejects(
    f.controller.listCodexSessions("bob", {}),
    (e) => e.code === "OWNER_MISMATCH",
  );
  await assert.rejects(
    f.controller.selectCodexSession("bob", "session-a"),
    (e) => e.code === "OWNER_MISMATCH",
  );
  assert.equal((await f.state()).calls.length, 0);
});

test("a session at a drive root has a usable project name", async (t) => {
  const f = await fixture(t);
  const state = await f.state();
  const driveRoot = path.parse(f.project).root;
  state.threads.push({
    ...state.threads[0],
    id: "session-root",
    cwd: driveRoot,
  });
  await writeFile(f.statePath, JSON.stringify(state));
  await f.pair();
  const selected = await f.controller.selectCodexSession(
    "alice",
    "session-root",
  );
  assert.equal(selected.workspace.displayPath, driveRoot);
  assert.equal(selected.workspace.name, driveRoot);
});
