import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
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

test("model discovery reads every available page and preserves each model's fast capability without executing", async (t) => {
  const f = await fixture(t);
  const state = await f.state();
  state.models = Array.from({ length: 9 }, (_, index) => ({
    id: `catalog-${index}`,
    model: `provider/model-${index}`,
    displayName: `Available Model ${index}`,
    isDefault: index === 0,
    ...(index === 0 ? { serviceTiers: [{ id: "fast", name: "Fast" }] } : {}),
    ...(index === 8 ? { additionalSpeedTiers: ["fast"] } : {}),
  }));
  state.models.splice(4, 0, {
    id: "hidden-model",
    model: "hidden-model",
    displayName: "Hidden",
    hidden: true,
  });
  state.modelPageSize = 3;
  await writeFile(f.statePath, JSON.stringify(state));
  const result = await f.controller.listCodexModels("alice");
  assert.deepEqual(
    result.models.map((model) => model.id),
    Array.from({ length: 9 }, (_, index) => `provider/model-${index}`),
  );
  assert.deepEqual(result.models.at(-1), {
    id: "provider/model-8",
    name: "Available Model 8",
    isDefault: false,
    supportsFast: true,
  });
  assert.equal(result.models[0].isDefault, true);
  assert.equal(result.models[0].supportsFast, true);
  assert.equal(result.models[1].supportsFast, false);
  const calls = (await f.state()).calls;
  const listed = calls.filter((call) => call.method === "model/list");
  assert.deepEqual(
    listed.map((call) => call.params.cursor),
    [null, "3", "6"],
  );
  assert.ok(
    listed.every(
      (call) =>
        call.params.includeHidden === false && call.params.limit === 100,
    ),
  );
  assert.ok(
    !calls.some((call) =>
      ["thread/start", "thread/resume", "turn/start"].includes(call.method),
    ),
  );
});

test("model discovery rejects a repeated cursor instead of returning a truncated catalog", async (t) => {
  const f = await fixture(t);
  const state = await f.state();
  state.models = Array.from({ length: 8 }, (_, index) => ({
    id: `model-${index}`,
    model: `model-${index}`,
    displayName: `Model ${index}`,
  }));
  state.modelPageSize = 2;
  state.modelCursorLoop = true;
  await writeFile(f.statePath, JSON.stringify(state));
  await assert.rejects(f.controller.listCodexModels("alice"), {
    code: "CODEX_PROTOCOL_ERROR",
    message: /模型列表分页未推进/,
  });
  const calls = (await f.state()).calls;
  assert.equal(calls.filter((call) => call.method === "model/list").length, 2);
  assert.ok(
    !calls.some((call) =>
      ["thread/start", "thread/resume", "turn/start"].includes(call.method),
    ),
  );
});

test("bound project model discovery prefers its active session and reads effective Codex speed", async (t) => {
  const f = await fixture(t);
  await f.pair();
  const { runnerId, workspace } = await f.controller.selectCodexSession(
    "alice",
    "session-a",
  );
  const scope = { runnerId, workspaceId: workspace.workspaceId };
  const state = await f.state();
  state.config = {
    model: "configured",
    service_tier: "priority",
    model_reasoning_effort: "medium",
    instructions: "private configuration",
  };
  state.models = [
    {
      model: "catalog-default",
      displayName: "Catalog default",
      isDefault: true,
    },
    {
      model: "configured",
      displayName: "Configured",
      serviceTiers: [{ id: "priority" }],
    },
    {
      model: "project-model",
      displayName: "Project model",
      serviceTiers: [{ id: "priority" }],
    },
  ];
  state.threads[0].model = "configured";
  state.threads.unshift({
    ...state.threads[1],
    id: "outside-project",
    cwd: f.project + "-unrelated",
    model: "catalog-default",
    status: { type: "active" },
  });
  state.threads.push({
    ...state.threads.find((thread) => thread.id === "session-a"),
    id: "active-in-project",
    model: "project-model",
    reasoningEffort: "high",
    status: { type: "active", activeFlags: [] },
  });
  state.threads.unshift({
    ...state.threads.at(-1),
    id: "qingdan-task",
    name: "轻单 · 自定义设置执行",
    model: "catalog-default",
  });
  await writeFile(f.statePath, JSON.stringify(state));

  const result = await f.controller.listCodexModels("alice", scope);
  assert.deepEqual(result.current, {
    model: "project-model",
    fastMode: true,
    reasoningEffort: "high",
    source: "project",
    status: "active",
  });
  assert.equal(
    result.models.find((model) => model.id === "project-model").supportsFast,
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /private configuration|outside-project/,
  );
  await assert.rejects(
    f.controller.listCodexModels("alice", { ...scope, runnerId: "other" }),
    {
      code: "ACCESS_DENIED",
    },
  );
  await assert.rejects(
    f.controller.listCodexModels("alice", { ...scope, workspaceId: "missing" }),
  );
  const latest = await f.state();
  latest.threads = latest.threads.map((thread) =>
    thread.cwd === f.project
      ? { ...thread, model: "retired-model", reasoningEffort: "ultra" }
      : thread,
  );
  await writeFile(f.statePath, JSON.stringify(latest));
  assert.deepEqual(
    (await f.controller.listCodexModels("alice", scope)).current,
    {
      model: "configured",
      fastMode: true,
      reasoningEffort: "medium",
      source: "config",
      status: null,
    },
  );
  assert.ok(
    !(await f.state()).calls.some((call) =>
      ["thread/start", "thread/resume", "turn/start"].includes(call.method),
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

test("verifying a previously registered workspace rejects a replaced directory without changing its registration", async (t) => {
  const f = await fixture(t);
  await f.pair();
  const { runnerId, workspace } = await f.controller.selectCodexSession(
    "alice",
    "session-a",
  );
  const scope = { runnerId, workspaceId: workspace.workspaceId };
  assert.deepEqual(await f.controller.verifyWorkspace("alice", scope), {
    runnerId,
    workspace,
  });
  await rename(f.project, f.project + "-original");
  await mkdir(f.project);
  await assert.rejects(f.controller.verifyWorkspace("alice", scope), {
    code: "WORKSPACE_CHANGED",
  });
  assert.deepEqual(f.controller.status("alice").workspaces, [workspace]);
  assert.deepEqual(f.registered(), [workspace]);
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
