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
  const canvasAdds = [],
    listeners = new Set(),
    taskLists = Object.fromEntries(pages.map((page) => [page.id, []]));
  let canvasPages = structuredClone(pages),
    saved = false,
    run = null,
    submittedIntent = null;
  // The real workspace receives these task changes through the shared canvas.
  // Keep that input distinct from the checklist endpoint's execution metadata.
  const publishTasks = (pageId) => {
    canvasPages = canvasPages.map((page) =>
      page.id === pageId
        ? {
            ...page,
            tasks: taskLists[pageId].map((task) => ({
              note: { id: task.noteId, noteKind: "checklist" },
              key: task.taskId,
              block: {
                id: task.taskId,
                runs: [{ type: "text", text: task.text }],
                done: task.done,
                completedAt: task.completedAt ?? null,
              },
              locked: false,
            })),
          }
        : page,
    );
    for (const listener of listeners) listener();
  };
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
      taskLists.a = [structuredClone(baseTask)];
      publishTasks("a");
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
        tasks: structuredClone(taskLists[id]),
        truncated: false,
      };
    if (route.includes("/execution/runs?"))
      return { runs: id === "a" && run ? [structuredClone(run)] : [] };
    if (route.endsWith("/execution/intents")) {
      submittedIntent = structuredClone(body);
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
    }
    if (route.endsWith("/execution/tools")) {
      if (body.name === "codex_create_run") {
        run = {
          runId: "run-a",
          bindingId: "binding-a",
          kind: "task",
          executionMode: "project",
          status: "running",
          terminal: false,
          threadId: "codex-a",
          turnId: "turn-a",
          sourceBacked: true,
          executionPermissions: submittedIntent.executionPermissions,
          submission: {
            text: `请结合项目信息完成以下待办：\n\n1. ${baseTask.text}`,
            tasks: submittedIntent.sourceTasks,
            projectSummary: { overview: "正式界面文档项目" },
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
    canvasAdds,
    getPages: () => canvasPages,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onAddTodo(pageId, text) {
      canvasAdds.push({ pageId, text });
      const suffix = `${pageId}-${canvasAdds.length}`;
      taskLists[pageId].push({
        ...structuredClone(baseTask),
        noteId: `manual-note-${suffix}`,
        taskId: `manual-task-${suffix}`,
        text,
      });
      publishTasks(pageId);
      return true;
    },
    requestLocal: async () => ({
      runnerId: "runner",
      connectionStatus: "online",
    }),
    complete() {
      run = {
        ...run,
        status: "verifying",
        terminal: true,
        stopConfirmed: true,
        output: "已整理正式界面说明，请检查文档内容。",
      };
    },
  };
}
async function mount(f, userId = "owner") {
  sessionStorage.clear();
  localStorage.clear();
  const root = createRoot(document.getElementById("root"));
  function SharedWorkspace() {
    const sharedPages = React.useSyncExternalStore(f.subscribe, f.getPages);
    return React.createElement(AgentWorkspace, {
      roomId: "canvas",
      userId,
      pages: sharedPages,
      onAddTodo: f.onAddTodo,
      requestCloud: f.requestCloud,
      requestLocal: f.requestLocal,
    });
  }
  await act(async () => root.render(React.createElement(SharedWorkspace)));
  return root;
}
test("formal workspace submits saved todos together and shows the execution result in project chat", async () => {
  const f = fixture(),
    root = await mount(f);
  try {
    await click(button("添加待办"));
    await edit("新待办", "尚未保存的本地草稿");
    await click(button("保存到真实清单"));
    assert.match(
      document.querySelector('[aria-label="真实待办"]').textContent,
      /整理正式界面说明/,
    );
    assert.equal(field("新待办").value, "尚未保存的本地草稿");
    assert.deepEqual(f.canvasAdds, []);
    assert.equal(f.calls.filter((c) => c.route.endsWith("/intents")).length, 0);
    await click(field("选中待办：整理正式界面说明"));
    await click(button("提交所选待办"));
    assert.equal(
      f.calls.filter((c) => c.body?.name === "codex_create_run").length,
      1,
    );
    const intent = f.calls.find((c) => c.route.endsWith("/intents")).body;
    assert.equal(intent.executionMode, "project");
    assert.equal(intent.autoComplete, false);
    assert.equal(intent.executionPermissions.profile, "full_access");
    assert.deepEqual(
      intent.sourceTasks.map((t) => t.taskId),
      ["task-a"],
    );
    assert.match(
      document.querySelector(".agent-chat-submission").textContent,
      /整理正式界面说明.*已附带项目信息/s,
    );
    assert.ok(button("停止"));
    f.complete();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 800)));
    const output = document.querySelector(".agent-chat-execution").textContent;
    assert.match(output, /已整理正式界面说明，请检查文档内容/);
    assert.doesNotMatch(output, /本次执行已结束/);
    assert.equal(
      document.querySelector(".agent-chat-execution .agent-execution-steps"),
      null,
    );
    assert.ok(button("开始"));
    assert.ok(field("选中待办：整理正式界面说明"));
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
    await click(button("添加待办"));
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
    assert.equal(field("新待办"), null);
    await click(button("添加待办"));
    assert.equal(field("新待办").value, "");
    await edit("聊天消息", "演示项目未发送草稿");
    await selectProject("文档项目");
    assert.equal(field("聊天消息").value, "文档项目未发送草稿");
    assert.equal(field("新待办").value, "文档项目待办草稿");
    assert.equal(
      f.calls.filter(
        (c) =>
          c.route.endsWith("/send") ||
          c.route.endsWith("/intents") ||
          c.body?.action === "create",
      ).length,
      0,
    );
    assert.deepEqual(f.canvasAdds, []);
  } finally {
    await act(async () => root.unmount());
  }
});
