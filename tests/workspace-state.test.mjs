import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import * as persistence from "../src/agent/workspace-state.js";
import { browserLocks } from "./fixtures/browser-locks.mjs";

const dom = new JSDOM('<div id="root"></div>', {
  url: "http://127.0.0.1:8790/",
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
const { localStorage, sessionStorage } = window;
let root, result;
const setItem = window.Storage.prototype.setItem;
test.beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  navigator.locks = browserLocks();
  root = createRoot(document.getElementById("root"));
});
test.afterEach(async () => {
  window.Storage.prototype.setItem = setItem;
  await act(async () => root.unmount());
});
test.after(() => dom.window.close());
function Draft({ name = "alice/project/run" }) {
  result = persistence.useWorkspaceDraft(name, "", true);
  return React.createElement("p", { role: "alert" }, result[2]?.warning);
}
const mount = (Component) =>
  act(async () => root.render(React.createElement(Component)));
async function reopen() {
  await act(async () => root.unmount());
  sessionStorage.clear();
  root = createRoot(document.getElementById("root"));
}
test("draft migrates session data once, survives new session and reports denied persistence", async () => {
  sessionStorage.setItem(
    "qingdan.agent-draft:alice/project/run",
    JSON.stringify("旧草稿"),
  );
  await mount(Draft);
  assert.equal(result[0], "旧草稿");
  await reopen();
  await mount(Draft);
  assert.equal(result[0], "旧草稿");
  window.Storage.prototype.setItem = () => {
    throw new DOMException("denied", "SecurityError");
  };
  await act(async () => result[1]("仅内存"));
  assert.equal(result[0], "仅内存");
  assert.match(document.body.textContent, /保存|存储/);
  await act(async () =>
    root.render(React.createElement(Draft, { name: "bob/project/run" })),
  );
  assert.equal(result[0], "");
});
test("exact requests preserve immutable body and checkpoint across reopening without sending", async () => {
  assert.equal(typeof persistence.createWorkspaceRequests, "function");
  const scope = persistence.workspaceScope({
    accountId: "alice",
    canvasId: "room",
    sectionId: "page",
    binding: {
      bindingId: "binding",
      revision: 1,
      runnerId: "runner",
      workspaceId: "workspace",
    },
    chatId: "chat",
    runId: "run",
  });
  const store = persistence.createWorkspaceRequests(scope);
  const build = (requestId) => ({
    path: "/api/test",
    method: "POST",
    body: { requestId, expectedRevision: 3, message: "原文" },
  });
  const record = await store.prepare("send", build);
  const original = structuredClone(record.request);
  record.request.body.message = "外部修改";
  await store.checkpoint(record.requestId, {
    input: { runId: "run", snapshotId: "snapshot" },
  });
  sessionStorage.clear();
  const restored = persistence.createWorkspaceRequests(scope);
  assert.deepEqual(restored.getSnapshot().records[0].request, original);
  assert.deepEqual(restored.getSnapshot().records[0].checkpoint, {
    input: { runId: "run", snapshotId: "snapshot" },
  });
  assert.equal(
    (await restored.prepare("send", build)).requestId,
    record.requestId,
  );
  await assert.rejects(
    restored.prepare("send", (id) => ({
      ...build(id),
      body: { requestId: id, expectedRevision: 4, message: "新文" },
    })),
    /待核对|内容/,
  );
  await restored.resolve(record.requestId, "acknowledged");
  assert.equal(
    persistence.createWorkspaceRequests(scope).getSnapshot().records.length,
    0,
  );
});
test("two clients coordinate exact identity; missing lock capability fails closed except safe stop", async () => {
  assert.equal(typeof persistence.createWorkspaceRequests, "function");
  const a = persistence.createWorkspaceRequests("scope");
  const b = persistence.createWorkspaceRequests("scope");
  const build = (requestId) => ({
    path: "/api/test",
    method: "POST",
    body: { requestId, text: "同一操作" },
  });
  const [one, two] = await Promise.all([
    a.prepare("send", build),
    b.prepare("send", build),
  ]);
  assert.equal(one.requestId, two.requestId);
  navigator.locks = undefined;
  const noLocks = persistence.createWorkspaceRequests("other");
  await assert.rejects(noLocks.prepare("send", build), /标签|协调|浏览器/);
  assert.equal(noLocks.getSnapshot().records.length, 0);
  const stop = await noLocks.prepare(
    "stop",
    (requestId) => ({
      path: "/api/agent/execution/tools",
      method: "POST",
      body: {
        bindingId: "b",
        name: "codex_cancel_run",
        arguments: { runId: "r", requestId },
      },
    }),
    { safeStop: true },
  );
  assert.ok(stop.requestId);
  assert.match(noLocks.getSnapshot().warning, /保存|存储|标签/);
});
test("request scopes separate every account, project, binding, chat and run identity", async () => {
  assert.equal(typeof persistence.workspaceScope, "function");
  const base = {
    accountId: "a",
    canvasId: "c",
    sectionId: "p",
    binding: { bindingId: "b", revision: 1, runnerId: "r", workspaceId: "w" },
    chatId: "t",
    runId: "run",
  };
  const scopes = [
    base,
    ...["accountId", "canvasId", "sectionId", "chatId", "runId"].map((key) => ({
      ...base,
      [key]: "different",
    })),
    ...["bindingId", "revision", "runnerId", "workspaceId"].map((key) => ({
      ...base,
      binding: { ...base.binding, [key]: key === "revision" ? 2 : "different" },
    })),
  ].map(persistence.workspaceScope);
  assert.equal(new Set(scopes).size, 10);
});
test("legacy adoption retains the original wire identity and rejects mismatched IDs", async () => {
  assert.equal(typeof persistence.createWorkspaceRequests, "function");
  const store = persistence.createWorkspaceRequests("legacy");
  const legacy = {
    requestId: "original-id",
    request: {
      path: "/api/test",
      method: "POST",
      body: { requestId: "original-id", expectedRevision: 4, text: "原文" },
    },
    checkpoint: { runId: "old-run" },
  };
  await store.adopt("save", legacy);
  const restored = persistence.createWorkspaceRequests("legacy").getSnapshot()
    .records[0];
  assert.equal(restored.requestId, "original-id");
  assert.deepEqual(restored.request, legacy.request);
  await assert.rejects(
    store.adopt("different", { ...legacy, requestId: "new-id" }),
    /身份|编号/,
  );
});
test("a browser rejecting lock access still allows safe stop without pretending it is durable", async () => {
  navigator.locks = {
    request: async () => {
      throw new DOMException("denied", "SecurityError");
    },
  };
  const store = persistence.createWorkspaceRequests("denied-lock");
  const record = await store.prepare(
    "stop",
    (requestId) => ({
      path: "/api/agent/execution/tools",
      method: "POST",
      body: {
        bindingId: "b",
        name: "codex_cancel_run",
        arguments: { runId: "r", requestId },
      },
    }),
    { safeStop: true },
  );
  assert.ok(record.requestId);
  assert.equal(store.getSnapshot().durable, false);
  assert.match(store.getSnapshot().warning, /标签|协调|保存/);
});

test("a full unresolved request journal still admits a safe stop without evicting requests", async () => {
  const store = persistence.createWorkspaceRequests("full-journal");
  for (let index = 0; index < 100; index++) {
    await store.prepare(`send-${index}`, (requestId) => ({
      path: "/api/test",
      method: "POST",
      body: { requestId, text: `message-${index}` },
    }));
  }
  const record = await store.prepare(
    "stop",
    (requestId) => ({
      path: "/api/agent/execution/tools",
      method: "POST",
      body: {
        bindingId: "b",
        name: "codex_cancel_run",
        arguments: { runId: "r", requestId },
      },
    }),
    { safeStop: true },
  );
  assert.ok(record.requestId);
  assert.equal(store.getSnapshot().records.length, 101);
});
