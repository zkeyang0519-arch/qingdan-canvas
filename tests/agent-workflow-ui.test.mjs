import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserLocks } from "./fixtures/browser-locks.mjs";
const dom = new JSDOM('<div id="root"></div>', {
  url: "http://127.0.0.1:8790",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
test.beforeEach(() => {
  navigator.locks = browserLocks();
});
const { createRoot } = await import("react-dom/client");
const temp = mkdtempSync(resolve("node_modules/.cache/agent-workflow-"));
await build({
  entryPoints: [resolve("src/agent/AgentWorkspace.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(temp, "ui.mjs"),
});
const { default: AgentWorkspace } = await import(
  pathToFileURL(resolve(temp, "ui.mjs"))
);
rmSync(temp, { recursive: true, force: true });
const pages = [
  { id: "a", title: "文档项目", tasks: [] },
  { id: "b", title: "演示项目", tasks: [] },
];
const field = (label) => document.querySelector(`[aria-label="${label}"]`);
const button = (text) =>
  [...document.querySelectorAll("button")].find(
    (b) =>
      b.textContent.trim() === text || b.getAttribute("aria-label") === text,
  );
async function click(el) {
  assert.ok(el);
  assert.equal(el.disabled, false);
  await act(async () => el.click());
}
async function edit(label, value) {
  const el = field(label);
  assert.ok(el, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      el.tagName === "INPUT"
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const baseTask = {
  noteId: "note-a",
  taskId: "task-a",
  text: "整理正式界面说明",
  instruction: "补充使用说明",
  acceptance: "说明准确",
  done: false,
  generation: 1,
  specRevision: 1,
  noteRevision: 1,
  specStatus: "ready",
  editableText: true,
  acceptanceChecks: [],
};
function fixture() {
  const calls = [];
  let tasks = [],
    saved = false,
    run = null;
  const binding = (id) => ({
    bindingId: "binding-" + id,
    revision: 1,
    enabled: true,
    runnerId: "runner",
    workspaceId: "workspace-" + id,
  });
  const requestCloud = async (route, options = {}) => {
    calls.push({ route, ...options });
    const body = options.body || {},
      url = new URL(route, "http://localhost");
    const id = (
      body.bindingId ||
      url.searchParams.get("bindingId") ||
      "binding-a"
    ).slice(-1);
    if (route.startsWith("/api/agent/bindings?"))
      return { binding: binding(url.searchParams.get("sectionId")) };
    if (route === "/api/agent/devices")
      return {
        devices: [
          {
            runnerId: "runner",
            status: "online",
            workspaces: pages.map((p) => ({
              workspaceId: "workspace-" + p.id,
              name: p.title,
            })),
          },
        ],
      };
    if (route.startsWith("/api/agent/chat/state")) {
      const thread = {
        id: "chat-" + id,
        bindingId: "binding-" + id,
        title: pages.find((p) => p.id === id).title,
        createdAt: "2026-11-05T00:00:00Z",
      };
      return {
        provider: { configured: true, model: "test-model" },
        thread,
        threads: [thread],
        messages:
          id === "a"
            ? [
                {
                  id: "proposal-a",
                  bindingId: "binding-a",
                  chatId: "chat-a",
                  sequence: 1,
                  role: "assistant",
                  text: "已整理一项待办，请确认。",
                  tasks: [
                    {
                      text: baseTask.text,
                      instruction: baseTask.instruction,
                      acceptance: baseTask.acceptance,
                    },
                  ],
                  memories: [],
                  taskProposal: { status: saved ? "saved" : "draft" },
                },
              ]
            : [],
        memories: [],
        memoryEpoch: 1,
        job: null,
        hasMore: false,
      };
    }
    if (route.endsWith("/chat/save-tasks")) {
      assert.equal(body.bindingId, "binding-a");
      saved = true;
      tasks = [structuredClone(baseTask)];
      return {
        saved: true,
        messageId: "proposal-a",
        operationId: "saved-a",
        taskIds: ["task-a"],
      };
    }
    if (route.endsWith("/execution/checklist"))
      return {
        canvasId: "canvas",
        sectionId: id,
        sequence: 1,
        tasks: id === "a" ? structuredClone(tasks) : [],
        truncated: false,
      };
    if (route.includes("/execution/runs?"))
      return { runs: id === "a" && run ? [structuredClone(run)] : [] };
    if (route.endsWith("/execution/intents"))
      return {
        input: {
          requestId: body.requestId,
          runId: "run-a",
          bindingId: "binding-a",
          bindingRevision: 1,
          kind: "task",
          snapshotId: "snapshot-a",
          payloadHash: "a".repeat(64),
        },
      };
    if (route.endsWith("/execution/tools")) {
      if (body.name === "codex_create_run") {
        run = {
          runId: "run-a",
          bindingId: "binding-a",
          kind: "task",
          status: "running",
          terminal: false,
          threadId: "codex-a",
          turnId: "turn-a",
          sourceBacked: true,
          executionPermissions: { profile: "workspace_manual", network: false },
          queue: {
            managed: true,
            revision: 1,
            phase: "running",
            currentIndex: 0,
            turnId: "turn-a",
            pauseRequested: false,
          },
          batch: {
            currentIndex: 0,
            items: [
              { taskId: "task-a", text: baseTask.text, status: "running" },
            ],
          },
          pendingRequests: [],
        };
        return { result: { runId: "run-a", status: "accepted" } };
      }
      if (body.name === "codex_get_run")
        return {
          result: { run: structuredClone(run), events: [], hasMore: false },
        };
    }
    throw Error("Unexpected route: " + route);
  };
  return {
    requestCloud,
    calls,
    requestLocal: async () => ({
      runnerId: "runner",
      connectionStatus: "online",
    }),
    complete() {
      tasks = tasks.map((t) => ({
        ...t,
        done: true,
        completedAt: "2026-11-05T01:00:00Z",
      }));
      run = {
        ...run,
        status: "verifying",
        terminal: true,
        stopConfirmed: true,
        queue: { ...run.queue, phase: "completed", revision: 2 },
        batch: {
          currentIndex: 0,
          items: [
            {
              ...run.batch.items[0],
              status: "done",
              writeback: { status: "applied" },
            },
          ],
        },
      };
    },
  };
}
async function mount(f, userId = "owner") {
  sessionStorage.clear();
  localStorage.clear();
  const root = createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(
      React.createElement(AgentWorkspace, {
        roomId: "canvas",
        userId,
        pages,
        requestCloud: f.requestCloud,
        requestLocal: f.requestLocal,
      }),
    ),
  );
  return root;
}
test("formal workspace saves chat proposal into adjacent checklist, submits once, then reflects verified writeback", async () => {
  const f = fixture(),
    root = await mount(f);
  try {
    await edit("新待办", "尚未保存的本地草稿");
    await click(button("保存到真实清单"));
    assert.match(
      document.querySelector('[aria-label="真实待办"]').textContent,
      /整理正式界面说明/,
    );
    assert.equal(field("新待办").value, "尚未保存的本地草稿");
    assert.equal(f.calls.filter((c) => c.route.endsWith("/intents")).length, 0);
    await click(field("选中待办：整理正式界面说明"));
    await click(button("提交所选待办"));
    assert.equal(
      f.calls.filter((c) => c.body?.name === "codex_create_run").length,
      1,
    );
    const intent = f.calls.find((c) => c.route.endsWith("/intents")).body;
    assert.equal(intent.executionPermissions.profile, "workspace_manual");
    assert.deepEqual(
      intent.sourceTasks.map((t) => t.taskId),
      ["task-a"],
    );
    assert.match(document.body.textContent, /按顺序执行|执行中/);
    f.complete();
    await click(button("刷新批次"));
    assert.match(document.body.textContent, /本批次已全部完成/);
    assert.equal(field("选中待办：整理正式界面说明"), null);
    assert.equal(field("新待办").value, "尚未保存的本地草稿");
  } finally {
    await act(async () => root.unmount());
  }
});
test("switching project restores its own unsent chat and task drafts without submitting", async () => {
  const f = fixture(),
    root = await mount(f);
  try {
    await edit("聊天消息", "文档项目未发送草稿");
    await edit("新待办", "文档项目待办草稿");
    const selectProject = async (title) => {
      const candidates = [...document.querySelectorAll("button")];
      await click(
        candidates.find(
          (b) =>
            b.getAttribute("aria-label") === `选择项目：${title}` ||
            b.textContent.includes(title),
        ),
      );
    };
    await selectProject("演示项目");
    assert.equal(field("聊天消息").value, "");
    assert.equal(field("新待办").value, "");
    await edit("聊天消息", "演示项目未发送草稿");
    await selectProject("文档项目");
    assert.equal(field("聊天消息").value, "文档项目未发送草稿");
    assert.equal(field("新待办").value, "文档项目待办草稿");
    assert.equal(
      f.calls.filter(
        (c) => c.route.endsWith("/send") || c.route.endsWith("/intents"),
      ).length,
      0,
    );
  } finally {
    await act(async () => root.unmount());
  }
});
