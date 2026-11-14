import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserLocks } from "./fixtures/browser-locks.mjs";

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
const dir = mkdtempSync(resolve("node_modules/.cache/project-conversation-"));
await build({
  entryPoints: [resolve("src/agent/ChatPanel.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
});
const { default: ChatPanel } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
const button = (name) =>
  [...document.querySelectorAll("button")].find(
    (el) =>
      el.textContent.trim() === name || el.getAttribute("aria-label") === name,
  );
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

function fixture({ running = true, chatJob = null } = {}) {
  const calls = [];
  const binding = {
    bindingId: "bound",
    revision: 2,
    enabled: true,
    runnerId: "runner",
    workspaceId: "workspace",
  };
  let run = running
    ? {
        bindingId: "bound",
        runId: "project-run",
        kind: "task",
        sourceBacked: true,
        executionMode: "project",
        status: "running",
        terminal: false,
        stopConfirmed: false,
        threadId: "codex-thread",
        turnId: "turn-1",
        createdAt: "2026-11-12T01:01:00Z",
        submission: {
          text: "项目：轻单\n\n1. 修复导航\n2. 整理文档",
          tasks: [
            { taskId: "a", text: "修复导航" },
            { taskId: "b", text: "整理文档" },
          ],
          projectSummary: { overview: "轻单项目背景" },
        },
      }
    : null;
  let job = chatJob;
  let events = run
    ? [
        {
          eventId: "e1",
          seq: 1,
          type: "output.delta",
          payload: {
            text: "正在检查导航。",
            channel: "assistant",
            itemId: "m1",
          },
        },
        {
          eventId: "e2",
          seq: 2,
          type: "output.delta",
          payload: {
            text: "",
            channel: "command",
            itemId: "cmd1",
            title: "npm test",
            phase: "started",
          },
        },
        {
          eventId: "e3",
          seq: 3,
          type: "output.delta",
          payload: {
            text: "12 tests passed",
            channel: "command",
            itemId: "cmd1",
            phase: "delta",
          },
        },
      ]
    : [];
  const requestCloud = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.startsWith("/api/agent/bindings?")) return { binding };
    if (path.startsWith("/api/agent/chat/state"))
      return {
        provider: { configured: true, model: "test-model" },
        threads: [{ id: "chat", title: "当前事项的很长标题" }],
        thread: { id: "chat" },
        messages: [
          {
            id: "u1",
            role: "user",
            text: "请整理项目",
            createdAt: "2026-11-12T01:00:00Z",
          },
          {
            id: "a1",
            role: "assistant",
            text: "**可以开始**",
            createdAt: "2026-11-12T01:00:01Z",
          },
        ],
        memories: [],
        memoryEpoch: 0,
        hasMore: false,
        job,
      };
    if (path.startsWith("/api/agent/execution/runs?"))
      return { runs: run ? [run] : [] };
    if (path === "/api/agent/execution/tools") {
      if (options.body.name === "codex_get_run")
        return {
          result: {
            run: structuredClone(run),
            events: events.filter(
              (e) => e.seq > (options.body.arguments.afterSeq || 0),
            ),
            nextAfterSeq: events.at(-1)?.seq || 0,
            hasMore: false,
          },
        };
      if (options.body.name === "codex_cancel_run")
        return { result: { status: "accepted", runId: run.runId } };
    }
    if (path === "/api/agent/chat/cancel") {
      job = { ...job, status: "cancelled" };
      return { job };
    }
    if (path === "/api/agent/execution/queue") {
      run = {
        ...run,
        queue: {
          ...run.queue,
          phase: "running",
          revision: run.queue.revision + 1,
        },
      };
      return { queue: run.queue };
    }
    throw Error(`Unexpected path ${path}`);
  };
  return {
    calls,
    requestCloud,
    patchRun(patch) {
      run = { ...run, ...patch };
    },
    finish() {
      run = {
        ...run,
        status: "cancelled",
        terminal: true,
        stopConfirmed: true,
      };
    },
    add(text) {
      events.push({
        eventId: `e${events.length + 1}`,
        seq: events.length + 1,
        type: "output.delta",
        payload: { text, channel: "assistant", itemId: "m2" },
      });
    },
  };
}
async function mount(f) {
  await act(async () =>
    root.render(
      React.createElement(ChatPanel, {
        roomId: "room",
        userId: "owner",
        pages: [{ id: "section", title: "轻单" }],
        embedded: true,
        requestCloud: f.requestCloud,
        requestLocal: f.requestLocal,
        execution: { page: { id: "section", title: "轻单" } },
      }),
    ),
  );
}
test("project chat ignores old Codex composer preferences and sends only to the lightweight assistant", async () => {
  const f = fixture({ running: false });
  const cloud = f.requestCloud;
  const sent = [];
  f.requestLocal = async () => ({
    models: [{ id: "old-model", name: "Old model", supportsFast: true }],
  });
  const settingsKey = JSON.stringify([
    ["owner", "room", "section"],
    JSON.stringify(["bound", 2, "runner", "workspace"]),
    "composer-settings",
  ]);
  window.localStorage.setItem(
    `qingdan.agent-draft:${settingsKey}`,
    JSON.stringify({
      version: 1,
      value: { agent: "codex", model: "old-model", fastMode: true },
    }),
  );
  f.requestCloud = async (path, options = {}) => {
    if (path === "/api/agent/chat/send") {
      sent.push(options.body);
      return {
        thread: { id: "chat" },
        message: { id: "sent-1", role: "user", text: options.body.text },
        job: { id: "job", status: "running", chatId: "chat" },
      };
    }
    return cloud(path, options);
  };
  await mount(f);
  assert.ok(
    !document.querySelector('[aria-label="Agent 选择"]'),
    "no Codex mode selector in project chat",
  );
  assert.ok(!document.querySelector('[aria-label="模型选择"]'));
  assert.equal(button("快速模式"), undefined);
  assert.doesNotMatch(document.body.textContent, /Enter 开始/);
  const input = document.querySelector('[aria-label="聊天消息"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(input, "整理这个项目");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => button("开始").click());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "整理这个项目");
  assert.equal(sent[0].executionSettings, undefined);
  assert.equal(
    f.calls.some((call) => call.path === "/api/agent/execution/intents"),
    false,
  );
});

test("old composer execution requests remain recoverable with their original model and identity", async () => {
  const { createWorkspaceRequests, workspaceScope } =
    await import("../src/agent/workspace-state.js");
  const binding = {
    bindingId: "bound",
    revision: 2,
    runnerId: "runner",
    workspaceId: "workspace",
  };
  const store = createWorkspaceRequests(
    workspaceScope({
      accountId: "owner",
      canvasId: "room",
      sectionId: "section",
      binding,
    }),
    { owner: "chat" },
  );
  const record = await store.prepare("composer-execution", (requestId) => ({
    path: "/api/agent/execution/intents",
    method: "POST",
    body: {
      requestId,
      bindingId: "bound",
      bindingRevision: 2,
      kind: "task",
      instruction: "原执行",
      executionSettings: { model: "old-model", fastMode: true },
    },
  }));
  const f = fixture({ running: false });
  const cloud = f.requestCloud;
  const intents = [],
    starts = [];
  let loseAck = true;
  f.requestCloud = async (path, options = {}) => {
    if (path === "/api/agent/execution/intents") {
      intents.push(options.body);
      return {
        input: {
          requestId: options.body.requestId,
          runId: "composer-run",
          bindingId: "bound",
          bindingRevision: 2,
          kind: "task",
          snapshotId: "snapshot",
          payloadHash: "a".repeat(64),
        },
      };
    }
    if (options.body?.name === "codex_create_run") {
      starts.push(options.body.arguments);
      if (loseAck) {
        loseAck = false;
        throw Error("响应丢失");
      }
      return { result: { runId: "composer-run", status: "accepted" } };
    }
    return cloud(path, options);
  };
  await mount(f);
  await act(async () => button("重试原操作").click());
  await act(async () => button("重试原操作").click());
  assert.equal(intents.length, 1);
  assert.deepEqual(intents[0], record.request.body);
  assert.deepEqual(starts[0], starts[1]);
});

test("project submission and Codex output share the chat timeline with a scoped stop control", async () => {
  const f = fixture();
  await mount(f);
  const timeline = document.querySelector('[aria-label="聊天消息记录"]');
  assert.match(timeline.textContent, /修复导航/);
  assert.match(timeline.textContent, /整理文档/);
  assert.match(timeline.textContent, /正在检查导航/);
  assert.match(timeline.textContent, /12 tests passed/);
  assert.ok(timeline.querySelector(".agent-chat-user"));
  assert.ok(timeline.querySelector(".agent-chat-assistant strong"));
  assert.ok(button("停止"));
  await act(async () => button("停止").click());
  const stops = f.calls.filter((c) => c.body?.name === "codex_cancel_run");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].body.arguments.runId, "project-run");
  assert.match(document.body.textContent, /正在停止/);
  assert.match(timeline.textContent, /正在检查导航/);
});

test("a completed run displays its directly delivered result without paging thousands of old events", async () => {
  const f = fixture();
  const cloud = f.requestCloud;
  const completed = {
    terminal: true,
    stopConfirmed: true,
    status: "verifying",
    output: "已完成全部修改，验证通过。",
    resultReadComplete: true,
    lastSeq: 30000,
  };
  f.patchRun(completed);
  let reads = 0;
  f.requestCloud = async (path, options = {}) => {
    const response = await cloud(path, options);
    if (options.body?.name === "codex_get_run") {
      reads++;
      const cursor = options.body.arguments.afterSeq || 0;
      response.result = {
        ...response.result,
        nextAfterSeq: Math.min(cursor + 50, 30000),
        hasMore: cursor + 50 < 30000,
      };
    }
    return response;
  };
  await mount(f);
  assert.match(
    document.querySelector(".agent-chat-execution").textContent,
    /已完成全部修改/,
  );
  assert.equal(
    reads,
    1,
    "the final answer must stop the historical log pagination",
  );
  assert.equal(document.querySelector(".agent-execution-program-line"), null);
});

test("skipping completed logs preserves next-turn events that arrived before their state report", async () => {
  const f = fixture(), cloud = f.requestCloud, cursors = [];
  f.patchRun({ terminal: true, stopConfirmed: true, status: "verifying", output: "旧轮结果", resultReadComplete: true, resultSeq: 30000, lastSeq: 30002, reportRevision: 1 });
  const incoming = [
    { eventId: "future-message", seq: 30001, turnId: "next-turn", type: "output.delta", payload: { channel: "assistant", itemId: "future", text: "正在执行下一轮修改。" } },
    { eventId: "future-command", seq: 30002, turnId: "next-turn", type: "output.delta", payload: { channel: "command", itemId: "future-command", text: "next turn output" } },
  ];
  f.requestCloud = async (path, options = {}) => {
    const response = await cloud(path, options);
    if (options.body?.name === "codex_get_run") {
      const cursor = options.body.arguments.afterSeq || 0;
      cursors.push(cursor);
      response.result = { ...response.result, events: cursor === 0 ? [] : incoming.filter(event => event.seq > cursor), nextAfterSeq: cursor === 0 ? 50 : 30002, hasMore: cursor === 0 };
    }
    return response;
  };
  await mount(f);
  f.patchRun({ terminal: false, stopConfirmed: false, status: "running", turnId: "next-turn", reportRevision: 2, output: undefined, resultReadComplete: undefined, resultSeq: undefined });
  await act(async () => new Promise(resolve => setTimeout(resolve, 800)));
  assert.equal(cursors[1], 30000);
  assert.match(document.querySelector(".agent-chat-execution").textContent, /正在执行下一轮修改/);
  assert.match(document.querySelector(".agent-execution-program-line").textContent, /next turn output/);
});
test("chat streaming text remains visible when the user cancels a reply", async () => {
  const f = fixture({
    running: false,
    chatJob: {
      id: "job-1",
      chatId: "chat",
      status: "running",
      partialText: "正在整理**项目需求**",
    },
  });
  await mount(f);
  assert.match(
    document.querySelector('[aria-label="聊天消息记录"]').textContent,
    /项目需求/,
  );
  assert.ok(button("停止"));
  await act(async () => button("停止").click());
  assert.equal(
    f.calls.filter((c) => c.path === "/api/agent/chat/cancel").length,
    1,
  );
  assert.match(document.body.textContent, /已停止/);
  assert.ok(button("开始"));
});

test("a legacy batch waiting between turns still offers Stop in project chat", async () => {
  const f = fixture();
  f.patchRun({
    executionMode: undefined,
    submission: undefined,
    terminal: true,
    stopConfirmed: true,
    status: "done",
    queue: {
      managed: true,
      phase: "waiting_human",
      revision: 2,
      turnId: "turn-1",
    },
    batch: { items: [{ taskId: "a", text: "原有待办", status: "done" }] },
  });
  await mount(f);
  assert.ok(
    button("停止"),
    "waiting for acceptance still holds the workspace and must be stoppable",
  );
  assert.ok(button("确认本项验收通过"));
  await act(async () => button("停止").click());
  assert.equal(
    f.calls.filter((call) => call.body?.name === "codex_cancel_run").length,
    1,
  );
});

test("a newly discovered run does not inherit the previous run's stopping state", async () => {
  const f = fixture();
  await mount(f);
  await act(async () => button("停止").click());
  f.patchRun({
    runId: "next-run",
    terminal: false,
    stopConfirmed: false,
    status: "running",
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 800)));
  const stop = button("停止");
  assert.ok(stop, "the newly running task must have an available stop control");
  assert.equal(stop.disabled, false);
  await act(async () => stop.click());
  assert.deepEqual(
    f.calls
      .filter((call) => call.body?.name === "codex_cancel_run")
      .map((call) => call.body.arguments.runId),
    ["project-run", "next-run"],
  );
});

test("a paused legacy checkpoint with an expired connection can recover in chat", async () => {
  const f = fixture();
  f.patchRun({
    executionMode: undefined,
    status: "reconciliation_required",
    terminal: false,
    stopConfirmed: false,
    queue: {
      managed: true,
      phase: "paused",
      revision: 3,
      canResume: false,
      turnId: "turn-1",
    },
  });
  await mount(f);
  assert.ok(button("核对并恢复连接"));
  await act(async () => button("核对并恢复连接").click());
  const request = f.calls.find(
    (call) => call.path === "/api/agent/execution/queue",
  );
  assert.equal(request.body.action, "recover");
  assert.equal(request.body.runId, "project-run");
  assert.equal(request.body.expectedRevision, 3);
});
