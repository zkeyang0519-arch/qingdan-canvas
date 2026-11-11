import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserLocks } from "./fixtures/browser-locks.mjs";
import {
  createWorkspaceRequests,
  workspaceScope,
} from "../src/agent/workspace-state.js";

const dom = new JSDOM('<div id="root"></div>', {
  url: "http://127.0.0.1:8788",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/journal-ownership-"));
await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
export { default as ChatPanel } from './src/agent/ChatPanel.jsx';
export { default as ChecklistPanel } from './src/agent/ChecklistPanel.jsx';
export { ProjectSummary } from './src/agent/ProjectSummaryPanel.jsx';
export { default as ExecutionPanel } from './src/agent/ExecutionPanel.jsx';
`,
  },
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
  logLevel: "silent",
});
const ui = await import(pathToFileURL(resolve(dir, "ui.mjs")));
rmSync(dir, { recursive: true, force: true });
let root;
test.beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  navigator.locks = browserLocks();
  root = createRoot(document.getElementById("root"));
});
test.afterEach(async () => {
  await act(async () => root.unmount());
});
test.after(() => dom.window.close());
const binding = {
  bindingId: "binding",
  revision: 1,
  runnerId: "runner",
  workspaceId: "workspace",
  enabled: true,
};
const scope = (runId = null) =>
  workspaceScope({
    accountId: "alice",
    canvasId: "canvas",
    sectionId: "section",
    binding,
    runId,
  });
const raw = (runId) => createWorkspaceRequests(scope(runId));
const exact = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const op = (action, body) => exact([action, body]);
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (b) =>
      b.textContent.trim() === label || b.getAttribute("aria-label") === label,
  );
async function click(label) {
  const b = button(label);
  assert.ok(b, label);
  assert.equal(b.disabled, false, label);
  await act(async () => b.click());
}
async function until(check) {
  for (let i = 0; i < 30; i++) {
    let done;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = check();
    });
    if (done) return;
  }
  assert.fail(document.body.textContent);
}
function fixture() {
  const calls = [];
  const project = {
    bindingId: "binding",
    bindingRevision: 1,
    status: "uninitialized",
    ready: false,
    summaryRevision: 0,
    summary: null,
    activeRunId: null,
  };
  const thread = {
    id: "chat",
    bindingId: "binding",
    title: "原聊天",
    createdAt: "2026-11-11T00:00:00Z",
  };
  const message = {
    id: "message",
    chatId: "chat",
    role: "user",
    text: "原消息",
    tasks: [],
    memories: [],
  };
  const job = {
    id: "job",
    chatId: "chat",
    userMessageId: "message",
    status: "succeeded",
  };
  let accepted = false;
  const view = {
    canvasId: "canvas",
    sectionId: "section",
    tasks: [],
    sequence: 1,
  };
  const requestCloud = async (route, options = {}) => {
    calls.push({
      route,
      ...options,
      body: options.body && structuredClone(options.body),
    });
    if (route.startsWith("/api/agent/bindings?")) return { binding };
    if (route === "/api/agent/devices")
      return {
        devices: [
          {
            runnerId: "runner",
            status: "online",
            workspaces: [{ workspaceId: "workspace", name: "fixture" }],
          },
        ],
      };
    if (route.startsWith("/api/agent/project/state")) return { ...project };
    if (route.startsWith("/api/agent/project/"))
      return { ...project, status: "ready", ready: true };
    if (route.startsWith("/api/agent/chat/state"))
      return {
        provider: { configured: true, model: "fixture" },
        threads: accepted ? [thread] : [],
        thread: accepted ? thread : null,
        messages: accepted ? [message] : [],
        job: accepted ? job : null,
        memories: [],
        memoryEpoch: 0,
      };
    if (route.startsWith("/api/agent/chat/request?"))
      return accepted
        ? { found: true, thread, message, job }
        : { found: false };
    if (route === "/api/agent/chat/send") {
      accepted = true;
      return { thread, message, job };
    }
    if (route.includes("/runs?")) return { runs: [] };
    if (route.endsWith("/checklist"))
      return options.body.action === "abandon_request"
        ? { status: "sealed" }
        : view;
    if (route.endsWith("/intents"))
      return { input: input(options.body.requestId) };
    if (route.endsWith("/tools")) {
      if (options.body.name === "codex_create_run")
        return { result: { runId: "run", status: "accepted" } };
      if (options.body.name === "codex_get_run")
        return {
          result: {
            run: {
              runId: options.body.arguments.runId,
              kind: "summary",
              status: "running",
              terminal: false,
              stopConfirmed: false,
            },
            events: [],
          },
        };
      if (options.body.name === "codex_cancel_run")
        return {
          result: { runId: options.body.arguments.runId, status: "accepted" },
        };
      if (options.body.name === "codex_list_projects")
        return { result: { projects: [] } };
    }
    throw Error("unexpected " + route);
  };
  return {
    calls,
    project,
    requestCloud,
    requestLocal: async () => ({
      runnerId: "runner",
      connectionStatus: "online",
    }),
  };
}
async function mount(name, f, extra = {}) {
  const props = {
    userId: "alice",
    roomId: "canvas",
    pages: [{ id: "section", title: "fixture" }],
    requestCloud: f.requestCloud,
    requestLocal: f.requestLocal,
    ...extra,
  };
  if (name === "ProjectSummary")
    Object.assign(props, {
      pageId: "section",
      binding,
      call: f.requestCloud,
      loadBinding: async () => binding,
    });
  await act(async () =>
    root.render(React.createElement(ui[name], { key: name, ...props })),
  );
  await until(() =>
    name === "ProjectSummary"
      ? button("开始总结") || button("停止总结")
      : name === "ChatPanel"
        ? button("刷新聊天与记忆")?.disabled === false
        : name === "ChecklistPanel"
          ? button("刷新清单")?.disabled === false
          : button("刷新状态")?.disabled === false,
  );
}
const input = (requestId) => ({
  requestId,
  runId: "run",
  bindingId: "binding",
  bindingRevision: 1,
  kind: "task",
  snapshotId: "snapshot",
  payloadHash: "a".repeat(64),
});
async function pendingDispatch() {
  const payload = {
    bindingId: "binding",
    bindingRevision: 1,
    kind: "task",
    sourceTasks: [
      { noteId: "note", taskId: "task", generation: 1, specRevision: 1 },
    ],
    autoComplete: false,
    executionPermissions: { profile: "workspace_manual" },
  };
  const store = raw();
  const record = await store.prepare(op("dispatch", payload), (requestId) => ({
    path: "/api/agent/execution/intents",
    method: "POST",
    body: { requestId, ...payload },
  }));
  await store.checkpoint(record.requestId, {
    result: { input: input(record.requestId) },
    nextRequest: {
      path: "/api/agent/execution/tools",
      method: "POST",
      body: {
        bindingId: "binding",
        name: "codex_create_run",
        arguments: input(record.requestId),
      },
    },
  });
  return raw().getSnapshot().records[0];
}
async function pendingAbandon() {
  const payload = {
    tasks: [
      { text: "保留的待办", instruction: "原要求", acceptance: "原标准" },
    ],
  };
  const store = raw();
  const record = await store.prepare(op("create", payload), (requestId) => ({
    path: "/api/agent/execution/checklist",
    method: "POST",
    body: { bindingId: "binding", action: "create", requestId, ...payload },
  }));
  const { bindingId: _, ...request } = record.request.body;
  await store.checkpoint(record.requestId, {
    abandonRequest: {
      path: record.request.path,
      method: "POST",
      body: { bindingId: "binding", action: "abandon_request", request },
    },
  });
  return raw().getSnapshot().records[0];
}
const mutationPosts = (f) =>
  f.calls.filter(
    (c) =>
      c.method === "POST" &&
      !["list", "receipt"].includes(c.body?.action) &&
      !["codex_get_run", "codex_list_projects"].includes(c.body?.name),
  );

for (const kind of ["dispatch", "abandon"])
  test(`foreign Chat and Summary leave checklist ${kind} intact; its owner completes the saved phase`, async () => {
    const original = await (kind === "dispatch"
      ? pendingDispatch()
      : pendingAbandon());
    const f = fixture();
    await mount("ProjectSummary", f);
    assert.ok(
      !button("重试原总结操作"),
      "summary must not offer foreign retry",
    );
    assert.equal(
      button("开始总结").disabled,
      false,
      "foreign pending does not block summary",
    );
    await click("开始总结");
    assert.deepEqual(raw().getSnapshot().records, [original]);
    assert.equal(mutationPosts(f).length, 1);
    await mount("ChatPanel", f);
    assert.ok(!button("重试原操作"), "chat must not offer foreign retry");
    await click("刷新聊天与记忆");
    assert.deepEqual(raw().getSnapshot().records, [original]);
    assert.equal(mutationPosts(f).length, 1);
    await mount("ChecklistPanel", f);
    await click(kind === "dispatch" ? "重试原操作" : "重试封存");
    await until(() => raw().getSnapshot().records.length === 0);
    const sent = mutationPosts(f).at(-1);
    assert.deepEqual(
      { path: sent.route, method: sent.method, body: sent.body },
      kind === "dispatch"
        ? original.checkpoint.nextRequest
        : original.checkpoint.abandonRequest,
    );
    assert.equal(mutationPosts(f).length, 2);
  });

test("pending chat send survives foreign panels and only Chat completes its durable draft cleanup", async () => {
  const original = await raw().prepare("send:new", (requestId) => ({
    path: "/api/agent/chat/send",
    method: "POST",
    body: {
      requestId,
      bindingId: "binding",
      bindingRevision: 1,
      text: "原消息",
    },
  }));
  const draftKey =
    "qingdan.agent-draft:" +
    JSON.stringify([
      ["alice", "canvas", "section"],
      JSON.stringify(["binding", 1, "runner", "workspace"]),
      "new",
      "chat",
    ]);
  window.localStorage.setItem(
    draftKey,
    JSON.stringify({ version: 1, value: "原消息" }),
  );
  const f = fixture();
  await mount("ProjectSummary", f);
  assert.ok(!button("重试原总结操作"), "summary must not offer chat retry");
  await mount("ChecklistPanel", f);
  assert.ok(
    !document.querySelector('[aria-label="待核对清单操作"]'),
    "chat request is not a checklist pending operation",
  );
  assert.doesNotMatch(document.body.textContent, /操作信息不符/);
  assert.deepEqual(raw().getSnapshot().records, [original]);
  assert.equal(mutationPosts(f).length, 0);
  assert.equal(
    JSON.parse(window.localStorage.getItem(draftKey)).value,
    "原消息",
  );
  await mount("ChatPanel", f);
  await click("重试原操作");
  await until(() => raw().getSnapshot().records.length === 0);
  assert.equal(JSON.parse(window.localStorage.getItem(draftKey)).value, "");
  assert.deepEqual(
    mutationPosts(f).map((c) => c.body),
    [original.request.body],
  );
});

test("owner guards reject foreign replay, checkpoint and all settlement outcomes without altering legacy records", async () => {
  const original = await pendingDispatch();
  const summary = createWorkspaceRequests(scope(), { owner: "summary" });
  await assert.rejects(
    summary.prepare(original.operationKey, () => original.request),
    /归属|入口/,
  );
  await assert.rejects(
    summary.adopt(original.operationKey, original),
    /归属|入口/,
  );
  await assert.rejects(summary.checkpoint(original.requestId, {}), /归属|入口/);
  for (const outcome of ["acknowledged", "rejected", "sealed"])
    await assert.rejects(
      summary.resolve(original.requestId, outcome),
      /归属|入口/,
    );
  assert.deepEqual(raw().getSnapshot().records, [original]);
});

test("Summary and its recovery ExecutionPanel reuse the same summary stop identity", async () => {
  const f = fixture();
  Object.assign(f.project, {
    status: "running",
    activeRunId: "summary-run",
    recoveryRuns: [{ runId: "summary-run" }],
  });
  await mount("ProjectSummary", f);
  await click("停止总结");
  const first = raw("summary-run").getSnapshot().records[0];
  assert.equal(first.operationKey, "summary:stop");
  await mount("ExecutionPanel", f, {
    initialPageId: "section",
    initialRunId: "summary-run",
    recoveryOnly: true,
  });
  await click("请求停止");
  assert.deepEqual(
    mutationPosts(f)
      .filter((c) => c.body.name === "codex_cancel_run")
      .map((c) => c.body),
    [first.request.body, first.request.body],
  );
  assert.deepEqual(raw("summary-run").getSnapshot().records, [first]);
});

test("unrecognized legacy records stay visible and read-only without being reclassified by their label", async () => {
  const original = await raw().prepare("summary:refresh", (requestId) => ({
    path: "/api/agent/future-operation",
    method: "POST",
    body: { requestId },
  }));
  const f = fixture();
  for (const panel of ["ProjectSummary", "ChecklistPanel", "ChatPanel"]) {
    await mount(panel, f);
    assert.ok(document.querySelector('[aria-label="未识别的恢复记录"]'));
    assert.ok(!button("重试原总结操作") && !button("重试原操作"));
    assert.deepEqual(raw().getSnapshot().records, [original]);
  }
  assert.equal(mutationPosts(f).length, 0);
});

test("owner views preserve the full journal capacity and legacy safe-stop identity", async () => {
  const full = raw();
  for (let i = 0; i < 100; i++)
    await full.prepare(`send:chat-${i}`, (requestId) => ({
      path: "/api/agent/chat/send",
      method: "POST",
      body: {
        requestId,
        chatId: `chat-${i}`,
        text: "pending",
        bindingId: "binding",
        bindingRevision: 1,
      },
    }));
  const summary = createWorkspaceRequests(scope(), { owner: "summary" });
  assert.equal(summary.getSnapshot().records.length, 100);
  assert.equal(summary.getSnapshot().ownedRecords.length, 0);
  await assert.rejects(
    summary.prepare("summary:initialize", (requestId) => ({
      path: "/api/agent/project/initialize",
      method: "POST",
      body: { requestId, bindingId: "binding", bindingRevision: 1 },
    })),
    /较多/,
  );
  const stop = {
    requestId: "legacy-stop",
    request: {
      path: "/api/agent/execution/tools",
      method: "POST",
      body: {
        bindingId: "binding",
        name: "codex_cancel_run",
        arguments: { runId: "run", requestId: "legacy-stop" },
      },
    },
    checkpoint: { old: true },
  };
  const checklist = createWorkspaceRequests(scope(), { owner: "checklist" });
  navigator.locks = undefined;
  const adopted = await checklist.adopt(op("stop", "run"), stop, {
    safeStop: true,
  });
  assert.deepEqual(adopted.request, stop.request);
  assert.equal(checklist.getSnapshot().durable, false);
  navigator.locks = browserLocks();
  const promoted = await checklist.prepare(
    op("stop", "run"),
    () => stop.request,
    { safeStop: true },
  );
  assert.equal(promoted.requestId, "legacy-stop");
  assert.deepEqual(promoted.checkpoint, stop.checkpoint);
  assert.equal(raw().getSnapshot().records.length, 101);
  assert.equal(checklist.getSnapshot().ownedRecords.length, 1);
  assert.equal(checklist.getSnapshot().durable, true);
});

test("a summary 4xx settles only its own record and leaves the foreign checkpoint untouched", async () => {
  const original = await pendingAbandon(),
    f = fixture(),
    base = f.requestCloud;
  f.requestCloud = async (route, options) => {
    if (route === "/api/agent/project/initialize")
      throw Object.assign(Error("fixture rejected"), { status: 409 });
    return base(route, options);
  };
  await mount("ProjectSummary", f);
  await click("开始总结");
  assert.deepEqual(raw().getSnapshot().records, [original]);
  assert.equal(mutationPosts(f).length, 0);
});
