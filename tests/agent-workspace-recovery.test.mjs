import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import React, { act } from "react";
import { browserLocks } from "./fixtures/browser-locks.mjs";

const dom = new JSDOM('<div id="root"></div>', {
  url: "http://127.0.0.1:8790/",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  sessionStorage: dom.window.sessionStorage,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const timers = new Map();
let timerId = 0;
window.setInterval = (fn, ms) => {
  timers.set(++timerId, { fn, ms });
  return timerId;
};
window.clearInterval = (id) => timers.delete(id);
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/workspace-recovery-"));
await build({
  entryPoints: ["src/agent/BatchPanel.jsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
  logLevel: "silent",
});
const { default: BatchPanel } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (el) =>
      el.textContent.trim() === label ||
      el.getAttribute("aria-label") === label,
  );
const field = (label) => document.querySelector(`[aria-label="${label}"]`);
const click = async (el) => {
  assert.ok(el);
  assert.equal(el.disabled, false);
  await act(async () => el.click());
};
const edit = async (el, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
const tick = async () =>
  act(async () => {
    for (const t of [...timers.values()].filter((t) => t.ms === 2500)) t.fn();
  });
let root;
const setItem = window.Storage.prototype.setItem;
test.beforeEach(() => {
  window.Storage.prototype.setItem = setItem;
  root = createRoot(document.getElementById("root"));
  timers.clear();
  sessionStorage.clear();
  localStorage.clear();
  navigator.locks = browserLocks();
});
test.afterEach(async () => {
  window.Storage.prototype.setItem = setItem;
  await act(async () => root.unmount());
});
test.after(() => dom.window.close());
async function reopen() {
  await act(async () => root.unmount());
  sessionStorage.clear();
  root = createRoot(document.getElementById("root"));
}
const binding = {
  bindingId: "binding",
  revision: 1,
  runnerId: "runner",
  workspaceId: "workspace",
  enabled: true,
};
const running = {
  runId: "run",
  bindingId: "binding",
  kind: "task",
  sourceBacked: true,
  status: "running",
  terminal: false,
  stopConfirmed: false,
  threadId: "thread",
  turnId: "turn",
  queue: {
    managed: true,
    revision: 1,
    phase: "running",
    currentIndex: 0,
    pauseRequested: false,
    canResume: false,
  },
  batch: {
    currentIndex: 0,
    items: [{ taskId: "task", text: "隔离任务", status: "running" }],
  },
};
const blocked = {
  ...running,
  status: "failed",
  terminal: true,
  stopConfirmed: true,
  queue: { ...running.queue, phase: "blocked" },
};
const completed = {
  ...running,
  status: "completed",
  terminal: true,
  stopConfirmed: true,
  queue: { ...running.queue, phase: "completed", revision: 2 },
  batch: {
    currentIndex: 0,
    items: [{ taskId: "task", text: "隔离任务", status: "done" }],
  },
};
const detail = (run) => ({
  result: {
    run: structuredClone(run),
    events: [],
    nextAfterSeq: 0,
    hasMore: false,
  },
});
function fixture(initialRun = running) {
  const calls = [];
  let override = async () => undefined;
  const requestCloud = async (route, options = {}) => {
    calls.push({ route, ...options });
    const result = await override(route, options);
    if (result !== undefined) return result;
    if (route.startsWith("/api/agent/bindings?"))
      return { binding: { ...binding } };
    if (route.includes("/runs?"))
      return { runs: [structuredClone(initialRun)] };
    if (options.body?.name === "codex_get_run") return detail(initialRun);
    if (options.body?.name === "codex_cancel_run")
      return { result: { status: "accepted", runId: "run" } };
    throw Error("Unexpected mock route " + route);
  };
  const props = {
    roomId: "room",
    userId: "alice",
    pages: [{ id: "section", title: "隔离项目" }],
    initialTarget: {
      sectionId: "section",
      bindingId: "binding",
      bindingRevision: 1,
      runId: "run",
    },
    requestCloud,
    embedded: true,
  };
  return {
    calls,
    props,
    intercept: (fn) => (override = fn),
    mount: (extra = {}) =>
      act(async () =>
        root.render(React.createElement(BatchPanel, { ...props, ...extra })),
      ),
  };
}
test("late polls cannot roll completed progress back, and slower valid replies are not starved", async () => {
  const f = fixture();
  await f.mount();
  const releases = [];
  f.intercept((route, options) =>
    options.body?.name === "codex_get_run"
      ? new Promise((resolve) => releases.push(resolve))
      : undefined,
  );
  await tick();
  await tick();
  assert.equal(releases.length, 2);
  await act(async () => releases[1](detail(completed)));
  assert.match(document.body.textContent, /本批次已全部完成/);
  await act(async () => releases[0](detail(running)));
  assert.match(document.body.textContent, /本批次已全部完成/);
  assert.equal(button("立即停止"), undefined);
  await reopen();
  const g = fixture();
  await g.mount();
  const slow = [];
  g.intercept((route, options) =>
    options.body?.name === "codex_get_run"
      ? new Promise((resolve) => slow.push(resolve))
      : undefined,
  );
  await tick();
  await tick();
  await act(async () => slow[0](detail(completed)));
  assert.match(
    document.body.textContent,
    /本批次已全部完成/,
    "first useful reply renders while the next poll is pending",
  );
  await act(async () => slow[1](detail(completed)));
});
test("followup and exact uncertain request survive full reopen; restore and inspection never replay execution", async () => {
  const f = fixture(blocked);
  let fail = true;
  f.intercept(async (route, options) => {
    if (options.body?.name === "codex_continue_run") {
      if (fail) throw Error("回执丢失");
      return { result: { status: "accepted", runId: "run" } };
    }
  });
  await f.mount();
  await edit(field("补充执行说明"), "保留原补充要求");
  await click(button("补充说明并继续当前项"));
  const first = f.calls.find((c) => c.body?.name === "codex_continue_run");
  assert.ok(first);
  await reopen();
  await f.mount();
  assert.equal(field("补充执行说明").value, "保留原补充要求");
  assert.equal(
    f.calls.filter((c) => c.body?.name === "codex_continue_run").length,
    1,
  );
  await click(button("核对原操作"));
  assert.equal(
    f.calls.filter((c) => c.body?.name === "codex_continue_run").length,
    1,
  );
  await edit(field("补充执行说明"), "新草稿不替换原请求");
  fail = false;
  await click(button("重试原操作"));
  const second = f.calls.filter(
    (c) => c.body?.name === "codex_continue_run",
  )[1];
  assert.deepEqual(second.body, first.body);
  assert.equal(field("补充执行说明").value, "新草稿不替换原请求");
  await reopen();
  await f.mount({ userId: "bob" });
  assert.equal(field("补充执行说明").value, "");
  assert.equal(button("重试原操作"), undefined);
});
test("successful polling clears only read failures and preserves unresolved command errors", async () => {
  const f = fixture(blocked);
  let failRead = true;
  f.intercept(async (route, options) => {
    if (options.body?.name === "codex_get_run" && failRead)
      throw Error("服务暂时断线");
    if (options.body?.name === "codex_continue_run")
      throw Error("发送回执未知");
  });
  await f.mount();
  assert.match(document.body.textContent, /服务暂时断线/);
  failRead = false;
  await tick();
  assert.doesNotMatch(document.body.textContent, /服务暂时断线/);
  await edit(field("补充执行说明"), "继续要求");
  await click(button("补充说明并继续当前项"));
  await tick();
  assert.match(document.body.textContent, /发送回执未知/);
});
test("denied storage visibly blocks new execution but permits inspection and safe stop", async () => {
  const f = fixture(blocked);
  await f.mount();
  window.Storage.prototype.setItem = function () {
    throw new DOMException("denied", "SecurityError");
  };
  await edit(field("补充执行说明"), "无法持久化");
  await click(button("补充说明并继续当前项"));
  assert.equal(
    f.calls.some((c) => c.body?.name === "codex_continue_run"),
    false,
  );
  assert.match(document.body.textContent, /保存|存储/);
  await click(button("刷新批次"));
  assert.ok(field("补充执行说明"));
  await click(button("立即停止"));
  await click(button("确认停止本批次"));
  assert.equal(
    f.calls.filter((c) => c.body?.name === "codex_cancel_run").length,
    1,
  );
});
