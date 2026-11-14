import test from "node:test";
test.beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  navigator.locks = browserLocks();
});
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
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
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/agent-checklist-ui-"));
await build({
  entryPoints: [resolve("src/agent/ChecklistPanel.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
});
const { default: ChecklistPanel } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });

const field = (label) => document.querySelector(`[aria-label="${label}"]`);
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (b) =>
      b.textContent.trim() === label || b.getAttribute("aria-label") === label,
  );
async function click(element) {
  assert.ok(element);
  assert.equal(element.disabled, false);
  await act(async () => element.click());
}
async function edit(label, value) {
  if (label.startsWith("新待办") && !field(label) && button("添加待办"))
    await click(button("添加待办"));
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
async function select(label, value) {
  const element = field(label);
  assert.ok(element, label);
  if (element.tagName === "BUTTON") {
    if (element.getAttribute("aria-expanded") !== "true") await click(element);
    return click(
      [...document.querySelectorAll('button[role="option"]')].find(
        (option) => option.value === value,
      ),
    );
  }
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

const item = (id, text) => ({
  noteId: `note-${id}`,
  taskId: `task-${id}`,
  text,
  done: false,
  completedAt: null,
  noteRevision: 2,
  generation: 3,
  specRevision: 4,
  instruction: `执行${text}`,
  acceptance: `验收${text}`,
  specStatus: "ready",
  editableText: true,
});

function fixture() {
  const calls = [];
  const binding = {
    bindingId: "binding",
    revision: 1,
    runnerId: "runner",
    workspaceId: "workspace",
    enabled: true,
  };
  let tasks = [item("a", "写说明"), item("b", "创建示例")];
  let sequence = 10;
  let createFails = false;
  let run = null;
  const view = () => ({
    canvasId: "canvas",
    sectionId: "section",
    sequence,
    tasks: structuredClone(tasks),
  });
  const requestCloud = async (route, options) => {
    calls.push({ route, ...options });
    if (route.startsWith("/api/agent/bindings?"))
      return {
        binding: route.includes("sectionId=section") ? { ...binding } : null,
      };
    if (route === "/api/agent/devices")
      return {
        devices: [
          {
            runnerId: "runner",
            status: "online",
            workspaces: [{ workspaceId: "workspace", name: "本机项目" }],
          },
        ],
      };
    if (route.endsWith("/checklist")) {
      const { action } = options.body;
      if (action === "list") return view();
      if (action === "create") {
        if (createFails) {
          createFails = false;
          throw Error("保存回执未收到");
        }
        const { text, instruction, acceptance, acceptanceChecks } =
          options.body.tasks[0];
        tasks.push({
          ...item("c", text),
          instruction,
          acceptance,
          acceptanceChecks,
          specStatus: instruction && acceptance ? "ready" : "missing",
        });
      }
      if (action === "save") {
        const { text, instruction, acceptance, acceptanceChecks, taskId } =
          options.body;
        tasks = tasks.map((task) =>
          task.taskId === taskId
            ? {
                ...task,
                text: text ?? task.text,
                instruction,
                acceptance,
                ...(acceptanceChecks !== undefined ? { acceptanceChecks } : {}),
                specRevision: task.specRevision + 1,
                specStatus: instruction && acceptance ? "ready" : "missing",
              }
            : task,
        );
      }
      if (action === "reorder")
        tasks = options.body.order.map(({ taskId }) =>
          tasks.find((task) => task.taskId === taskId),
        );
      sequence++;
      return { ...view(), operationId: `op-${sequence}` };
    }
    if (route.includes("/runs?")) return { runs: run ? [run] : [] };
    if (route.endsWith("/intents"))
      return {
        input: {
          requestId: options.body.requestId,
          runId: "run",
          bindingId: "binding",
          bindingRevision: 1,
          kind: "task",
          snapshotId: "snapshot",
          payloadHash: "a".repeat(64),
        },
      };
    if (route.endsWith("/tools")) {
      if (options.body.name === "codex_create_run") {
        run = {
          runId: "run",
          threadId: "chat-1",
          turnId: "turn-1",
          status: "running",
          sourceBacked: true,
          batch: {
            currentIndex: 0,
            items: tasks.map(({ taskId, text }) => ({
              taskId,
              text,
              status: "pending",
              summary: "",
            })),
          },
        };
        return { result: { runId: "run", status: "accepted" } };
      }
      if (options.body.name === "codex_get_run")
        return { result: { run, events: [] } };
      if (options.body.name === "codex_cancel_run") {
        run = { ...run, status: "cancel_requested" };
        return { result: { runId: "run", status: "accepted" } };
      }
    }
    throw Error(`unexpected ${route}`);
  };
  return {
    calls,
    requestCloud,
    requestLocal: async (route, options) => {
      calls.push({ route, ...options });
      return { runnerId: "runner", connectionStatus: "online" };
    },
    loseCreateReceipt() {
      createFails = true;
    },
    removeFirstTask() {
      tasks = tasks.slice(1);
      sequence++;
    },
    addTask() {
      tasks.push(item("d", "聊天整理的新待办"));
      sequence++;
    },
    advanceFirst() {
      tasks[0] = {
        ...tasks[0],
        generation: tasks[0].generation + 1,
        text: "远端新正文",
      };
      sequence++;
    },
    lockSecondTask() {
      tasks[1] = { ...tasks[1], locked: true, editableText: false };
      sequence++;
    },
    finishSecondTask() {
      tasks[1] = {
        ...tasks[1],
        done: true,
        completedAt: "2026-11-12T08:00:00Z",
      };
      sequence++;
    },
    rebind() {
      binding.revision++;
    },
    setChecks(checks) {
      tasks[0].acceptanceChecks = checks;
    },
    setTask(index, patch) {
      tasks[index] = { ...tasks[index], ...patch };
    },
    waitForHuman() {
      run = {
        ...run,
        terminal: true,
        stopConfirmed: true,
        status: "verifying",
        queue: { managed: true, phase: "waiting_human", currentIndex: 0 },
        batch: {
          ...run.batch,
          items: run.batch.items.map((item, index) => ({
            ...item,
            status: index === 0 ? "done" : "pending",
          })),
        },
      };
    },
    confirmStop() {
      run = {
        ...run,
        status: "cancelled",
        terminal: true,
        stopConfirmed: true,
      };
    },
    complete() {
      tasks = tasks.map((task, index) =>
        index === 0
          ? { ...task, done: true, completedAt: "2026-11-05T11:00:00Z" }
          : task,
      );
      sequence++;
      run = {
        ...run,
        status: "verifying",
        terminal: true,
        batch: {
          currentIndex: 1,
          items: run.batch.items.map((task, index) => ({
            ...task,
            status: "done",
            summary: "Codex 已处理",
            writeback: { status: index === 0 ? "applied" : "conflict" },
          })),
        },
      };
    },
  };
}

async function mount(f) {
  assert.equal(
    typeof ChecklistPanel,
    "function",
    "step 5 renders its real-checklist panel",
  );
  const root = createRoot(document.getElementById("root"));
  const render = (props) =>
    act(async () =>
      root.render(
        React.createElement(ChecklistPanel, {
          roomId: "canvas",
          userId: "alice",
          pages: [
            { id: "section", title: "我的清单" },
            { id: "unbound", title: "未绑定的清单" },
          ],
          ...f,
          ...props,
        }),
      ),
    );
  await render();
  const unmount = () => act(async () => root.unmount());
  unmount.render = render;
  return unmount;
}

test("execution defaults expose every model, cancel drafts, persist by account and freeze into retried intents", async () => {
  const f = fixture();
  const catalog = Array.from({ length: 37 }, (_, i) => ({
    id: `model-${i}`,
    name: `Model ${i}`,
    supportsFast: i % 2 === 0,
    isDefault: i === 0,
  }));
  const intents = [],
    starts = [];
  let loseAck = true;
  const props = {
    ...f,
    embedded: true,
    requestLocal: async (route, options) =>
      route.startsWith("/codex/models?")
        ? { models: catalog }
        : f.requestLocal(route, options),
    requestCloud: async (route, options) => {
      if (route.endsWith("/intents"))
        intents.push(structuredClone(options.body));
      if (options?.body?.name === "codex_create_run") {
        starts.push(structuredClone(options.body));
        if (loseAck) {
          loseAck = false;
          throw Error("响应丢失");
        }
      }
      return f.requestCloud(route, options);
    },
  };
  let close = await mount(props);
  try {
    await click(button("执行默认设置"));
    await click(field("新会话默认模型"));
    assert.equal(
      document.querySelectorAll('button[role="option"]').length,
      38,
      "all models must be rendered as page controls, not an invisible native popup",
    );
    await edit("搜索模型", "model-36");
    assert.equal(document.querySelectorAll('button[role="option"]').length, 1);
    assert.match(
      document.querySelector('[role="listbox"]').textContent,
      /Model 36/,
    );
    await edit("搜索模型", "unknown-model");
    assert.match(
      document.querySelector('[role="listbox"]').textContent,
      /没有匹配/,
    );
    await edit("搜索模型", "");
    await act(async () =>
      field("搜索模型").dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      ),
    );
    assert.equal(document.activeElement.value, "");
    await act(async () =>
      document.activeElement.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    assert.equal(document.activeElement.value, "model-36");
    await click(document.activeElement);
    assert.equal(
      field("新会话默认模型").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(document.activeElement, field("新会话默认模型"));
    await click(button("快速模式"));
    await click(button("取消"));
    assert.doesNotMatch(button("执行默认设置").textContent, /Model 36/);
    await click(button("执行默认设置"));
    await select("新会话默认模型", "model-36");
    await click(button("快速模式"));
    await click(button("保存执行设置"));
    assert.match(button("执行默认设置").textContent, /Model 36/);
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    assert.deepEqual(intents[0].executionSettings, {
      model: "model-36",
      fastMode: true,
    });
    await click(button("执行默认设置"));
    await select("新会话默认模型", "model-1");
    assert.equal(button("快速模式").disabled, true);
    await click(button("保存执行设置"));
    await click(button("重试原操作"));
    assert.equal(intents.length, 1);
    assert.deepEqual(starts[0], starts[1]);
    await close();
    close = await mount(props);
    assert.match(button("执行默认设置").textContent, /Model 1/);
    await close.render({ ...props, userId: "bob" });
    assert.match(button("执行默认设置").textContent, /Codex 默认/);
  } finally {
    await close();
  }
});

test("model catalog failure preserves a saved model and blocks new dispatch until retried", async () => {
  const f = fixture();
  let fail = false;
  const props = {
    ...f,
    embedded: true,
    requestLocal: async (route, options) => {
      if (!route.startsWith("/codex/models?")) return f.requestLocal(route, options);
      if (fail) throw Error("模型目录读取失败");
      return {
        models: [{ id: "available", name: "Available", supportsFast: true }],
      };
    },
  };
  let close = await mount(props);
  try {
    await click(button("执行默认设置"));
    await select("新会话默认模型", "available");
    await click(button("保存执行设置"));
    await close();
    fail = true;
    close = await mount(props);
    await click(field("选中待办：写说明"));
    assert.equal(button("提交所选待办").disabled, true);
    await click(button("执行默认设置"));
    assert.match(field("新会话默认模型").textContent, /available/);
    assert.equal(button("保存执行设置").disabled, true);
    fail = false;
    await click(button("刷新模型列表"));
    await click(button("保存执行设置"));
    assert.equal(button("提交所选待办").disabled, false);
  } finally {
    await close();
  }
});

test("an existing project follows Codex settings until an explicit execution preference is saved", async () => {
  const f = fixture();
  const model = { id: "project-model", name: "Project Model", supportsFast: true };
  let current = {
    model: model.id,
    fastMode: true,
    reasoningEffort: "high",
    source: "project",
    status: "notLoaded",
  };
  const intents = [];
  const close = await mount({
    ...f,
    embedded: true,
    requestLocal: (route, options) => route.startsWith("/codex/models?")
      ? Promise.resolve({ models: [model], current })
      : f.requestLocal(route, options),
    requestCloud: (route, options) => {
      if (route.endsWith("/intents")) intents.push(structuredClone(options.body));
      return f.requestCloud(route, options);
    },
  });
  try {
    assert.match(button("执行默认设置").textContent, /Project Model.*快速/);
    assert.doesNotMatch(button("执行默认设置").textContent, /会话进行中/);
    await click(button("执行默认设置"));
    assert.equal(button("快速模式").getAttribute("aria-checked"), "true");
    await click(button("快速模式"));
    await click(button("保存执行设置"));
    current = { ...current, status: "active" };
    await click(button("执行默认设置"));
    await click(button("刷新模型列表"));
    assert.equal(button("快速模式").getAttribute("aria-checked"), "false");
    await select("新会话默认模型", "");
    await click(button("保存执行设置"));
    assert.match(button("执行默认设置").textContent, /Project Model.*快速/);
    assert.doesNotMatch(button("执行默认设置").textContent, /会话进行中/);
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    assert.deepEqual(intents[0].executionSettings, {
      model: model.id,
      fastMode: true,
      reasoningEffort: "high",
    });
  } finally {
    await close();
  }
});

test("completed text reopens a bound todo and failed or locked restores preserve completion", async () => {
  const f = fixture();
  f.finishSecondTask();
  const restores = [];
  let succeed = false;
  const close = await mount({
    ...f,
    embedded: true,
    onReopenTodo: async (pageId, task) => {
      restores.push({ pageId, task });
      if (!succeed) return false;
      f.setTask(1, { done: false, completedAt: null });
      return true;
    },
  });
  try {
    const target = () => button("移回待办：创建示例");
    assert.equal(target().textContent.trim(), "创建示例");
    assert.equal(button("移回待办：写说明"), undefined);
    await click(target());
    assert.ok(target());
    assert.match(document.body.textContent, /未移回/);
    f.setTask(1, { locked: true });
    await click(button("刷新清单"));
    assert.equal(target().disabled, true);
    f.setTask(1, { locked: false });
    await click(button("刷新清单"));
    succeed = true;
    await click(target());
    assert.ok(field("选中待办：创建示例"));
    assert.equal(field("选中待办：创建示例").checked, false);
    assert.equal(restores.length, 2);
    assert.deepEqual(restores[1], {
      pageId: "section",
      task: { noteId: "note-b", taskId: "task-b" },
    });
  } finally {
    await close();
  }
});

test("bound completion follows the shared canvas in both directions during stale checklist polling", async () => {
  const f = fixture();
  f.finishSecondTask();
  const page = {
    id: "section",
    tasks: [
      {
        key: "task-b",
        note: { id: "note-b" },
        block: { done: false, runs: [{ type: "text", text: "创建示例" }] },
      },
    ],
  };
  const counts = [];
  const close = await mount({
    ...f,
    embedded: true,
    pages: [page],
    onCountsChange: (_, next) => counts.push(next),
  });
  try {
    assert.ok(field("选中待办：创建示例"));
    assert.deepEqual(counts.at(-1), { total: 1, pending: 1, review: 0 });
    f.setTask(1, { done: false, completedAt: null });
    const completedPage = {
      ...page,
      tasks: page.tasks.map((task) => ({
        ...task,
        block: {
          ...task.block,
          done: true,
          completedAt: "2026-11-13T08:00:00Z",
        },
      })),
    };
    await close.render({ pages: [completedPage] });
    assert.ok(button("移回待办：创建示例"));
    assert.deepEqual(counts.at(-1), { total: 1, pending: 0, review: 0 });
    await click(button("刷新清单"));
    assert.ok(button("移回待办：创建示例"));
    await close.render({ pages: [page] });
    assert.ok(field("选中待办：创建示例"));
    assert.deepEqual(counts.at(-1), { total: 1, pending: 1, review: 0 });
  } finally {
    await close();
  }
});

test("bound manual creation uses the canvas writer once and waits for current execution source data", async () => {
  const f = fixture();
  const page = { id: "section", tasks: [] };
  const writes = [];
  let accepted = false;
  const close = await mount({
    ...f,
    embedded: true,
    pages: [page],
    onAddTodo: async (pageId, text) => {
      if (!accepted) return false;
      writes.push({ pageId, text });
      page.tasks.push({
        note: { id: "note-a" },
        key: "task-a",
        block: { done: false, runs: [{ type: "text", text }] },
      });
      return true;
    },
  });
  try {
    await edit("新待办", "  新的本地待办  ");
    await click(button("保存新待办"));
    assert.equal(field("新待办").value, "  新的本地待办  ");
    assert.match(document.body.textContent, /未添加待办/);
    accepted = true;
    await click(button("保存新待办"));
    assert.deepEqual(writes, [{ pageId: "section", text: "新的本地待办" }]);
    assert.equal(field("新待办").value, "");
    assert.ok(field("选中待办：新的本地待办"));
    assert.equal(field("选中待办：新的本地待办").disabled, true);
    assert.equal(button("编辑待办：新的本地待办").disabled, true);
    assert.equal(button("提交所选待办").disabled, true);
    assert.equal(
      f.calls.some((call) => ["create", "save"].includes(call.body?.action)),
      false,
    );
    f.setTask(0, { text: "新的本地待办", generation: 4 });
    await click(button("刷新清单"));
    assert.equal(field("选中待办：新的本地待办").disabled, false);
    assert.equal(
      f.calls.some((call) => call.route.endsWith("/intents")),
      false,
    );
  } finally {
    await close();
  }
});

for (const bound of [true, false]) {
  test(`${bound ? "bound" : "unbound"} completion control updates the canvas separately from execution selection and respects locks`, async () => {
    const f = fixture();
    let page = {
      id: bound ? "section" : "unbound",
      tasks: [
        {
          note: { id: "note-a" },
          key: "task-a",
          block: {
            done: false,
            runs: [{ type: "text", text: "写说明" }],
          },
        },
      ],
    };
    let accepted = false;
    const updates = [];
    const close = await mount({
      ...f,
      embedded: true,
      pages: [page],
      onSetTodoDone: async (pageId, task, done) => {
        updates.push({ pageId, task, done });
        if (!accepted) return false;
        page = {
          ...page,
          tasks: page.tasks.map((source) => ({
            ...source,
            block: { ...source.block, done },
          })),
        };
        return true;
      },
    });
    try {
      if (bound) {
        await click(field("选中待办：写说明"));
        assert.equal(updates.length, 0);
        assert.equal(field("选中待办：写说明").checked, true);
      }
      await click(button("标记完成待办：写说明"));
      assert.ok(button("标记完成待办：写说明"));
      assert.match(document.body.textContent, /未标记完成/);
      accepted = true;
      await click(button("标记完成待办：写说明"));
      await close.render({ pages: [page] });
      assert.ok(button("移回待办：写说明"));
      assert.equal(field("真实待办").textContent.includes("写说明"), false);
      await click(button("移回待办：写说明"));
      await close.render({ pages: [page] });
      assert.ok(button("标记完成待办：写说明"));
      assert.deepEqual(
        updates.map(({ done }) => done),
        [true, true, false],
      );
      assert.deepEqual(updates.at(-1), {
        pageId: page.id,
        task: { noteId: "note-a", taskId: "task-a" },
        done: false,
      });
      page = {
        ...page,
        tasks: page.tasks.map((task) => ({ ...task, locked: true })),
      };
      await close.render({ pages: [page] });
      assert.equal(button("标记完成待办：写说明").disabled, true);
      assert.equal(
        f.calls.some((call) => call.route.endsWith("/intents")),
        false,
      );
    } finally {
      await close();
    }
  });
}

test("embedded canvas without a creation callback cannot bypass read-only mode through cloud creation", async () => {
  const f = fixture();
  const close = await mount({
    ...f,
    embedded: true,
    pages: [{ id: "section", tasks: [] }],
  });
  try {
    assert.equal(!!button("添加待办"), false);
    assert.equal(field("新待办"), null);
    assert.equal(
      f.calls.some((call) => call.body?.action === "create"),
      false,
    );
  } finally {
    await close();
  }
});

test("unbound completed text restores through the canvas callback without dispatch", async () => {
  const f = fixture();
  const restored = [];
  const close = await mount({
    ...f,
    embedded: true,
    pages: [
      {
        id: "unbound",
        tasks: [
          {
            key: "done",
            note: { id: "n" },
            block: { done: true, runs: [{ type: "text", text: "完成任务" }] },
          },
        ],
      },
    ],
    onReopenTodo: async (...args) => {
      restored.push(args);
      return true;
    },
  });
  try {
    await click(button("移回待办：完成任务"));
    assert.deepEqual(restored, [["unbound", { noteId: "n", taskId: "done" }]]);
    assert.equal(
      f.calls.some((call) => call.route.endsWith("/intents")),
      false,
    );
  } finally {
    await close();
  }
});

test("workbench editing changes only the todo text and preserves existing execution conditions", async () => {
  const f = fixture();
  const checks = [
    {
      id: "report",
      kind: "artifact",
      required: true,
      description: "报告存在",
      relativePath: "report.txt",
      predicate: { type: "exists" },
    },
  ];
  f.setChecks(checks);
  const close = await mount({ ...f, embedded: true });
  try {
    await click(button("编辑待办：写说明"));
    const editor = document.querySelector(".agent-checklist-editor");
    assert.equal(editor.querySelectorAll("textarea").length, 1);
    assert.equal(field("编辑执行要求"), null);
    assert.equal(field("编辑验收方式"), null);
    await edit("编辑待办内容", "补充安装说明");
    await click(button("保存待办"));
    const saved = f.calls.find((call) => call.body?.action === "save").body;
    assert.equal(saved.text, "补充安装说明");
    assert.equal(saved.instruction, "执行写说明");
    assert.equal(saved.acceptance, "验收写说明");
    assert.deepEqual(saved.acceptanceChecks, checks);
  } finally {
    await close();
  }
});

test("bound checklist can delete pending and completed todos without changing the execution batch", async () => {
  const f = fixture();
  f.finishSecondTask();
  const deleted = [];
  const close = await mount({
    ...f,
    embedded: true,
    onDeleteTodo: async (sectionId, task) => {
      deleted.push({ sectionId, ...task });
      return true;
    },
  });
  try {
    await click(field("选中待办：写说明"));
    await click(button("删除待办：写说明"));
    assert.equal(field("选中待办：写说明"), null);
    await click(button("删除待办：创建示例"));
    assert.equal(field("已完成待办：创建示例"), null);
    assert.deepEqual(deleted, [
      { sectionId: "section", noteId: "note-a", taskId: "task-a" },
      { sectionId: "section", noteId: "note-b", taskId: "task-b" },
    ]);
    assert.equal(
      f.calls.some(
        (call) => call.body?.name || call.route.endsWith("/intents"),
      ),
      false,
    );
  } finally {
    await close();
  }
});

test("deletion failures preserve bound todos and locked todos cannot be deleted", async () => {
  const f = fixture();
  f.lockSecondTask();
  const close = await mount({
    ...f,
    embedded: true,
    onDeleteTodo: async () => false,
  });
  try {
    assert.equal(button("删除待办：创建示例").disabled, true);
    await click(button("删除待办：写说明"));
    assert.ok(field("选中待办：写说明"));
    assert.match(document.body.textContent, /未删除|无法删除/);
    await close.render({ onDeleteTodo: undefined });
    assert.equal(button("删除待办：写说明"), undefined);
  } finally {
    await close();
  }
});

test("deleted canvas todos stay absent during stale server polling and return when restored", async () => {
  const f = fixture();
  const tasks = ["a", "b"].map((id) => ({
    key: `task-${id}`,
    note: { id: `note-${id}` },
    block: {
      done: false,
      runs: [{ type: "text", text: id === "a" ? "写说明" : "创建示例" }],
    },
  }));
  const pages = (items) => [{ id: "section", title: "我的清单", tasks: items }];
  const close = await mount({
    ...f,
    embedded: true,
    pages: pages(tasks),
    onDeleteTodo: async () => true,
  });
  try {
    await click(button("删除待办：写说明"));
    await close.render({ pages: pages(tasks.slice(1)) });
    await click(button("刷新清单"));
    assert.equal(field("选中待办：写说明"), null);
    assert.ok(field("选中待办：创建示例"));
    await close.render({ pages: pages(tasks) });
    assert.ok(field("选中待办：写说明"));
  } finally {
    await close();
  }
});

test("unbound projects expose deletion for pending and completed todos and retain failed deletions", async () => {
  const f = fixture();
  const deleted = [];
  const close = await mount({
    ...f,
    embedded: true,
    pages: [
      {
        id: "unbound",
        title: "未绑定项目",
        tasks: [
          {
            key: "a",
            note: { id: "note-a" },
            block: { runs: [{ type: "text", text: "未完成" }], done: false },
          },
          {
            key: "b",
            note: { id: "note-b" },
            block: { runs: [{ type: "text", text: "已完成" }], done: true },
          },
          {
            key: "c",
            note: { id: "note-c" },
            block: { runs: [{ type: "text", text: "已锁定" }] },
            locked: true,
          },
        ],
      },
    ],
    onDeleteTodo: async (sectionId, task) => {
      deleted.push({ sectionId, ...task });
      return false;
    },
  });
  try {
    assert.equal(button("删除待办：已锁定").disabled, true);
    await click(button("删除待办：未完成"));
    await click(button("删除待办：已完成"));
    assert.deepEqual(deleted, [
      { sectionId: "unbound", noteId: "note-a", taskId: "a" },
      { sectionId: "unbound", noteId: "note-b", taskId: "b" },
    ]);
    assert.ok(button("删除待办：未完成"));
    assert.match(document.body.textContent, /未删除|无法删除/);
  } finally {
    await close();
  }
});

test("title-only todos can be selected and are prepared with human acceptance only when submitted", async () => {
  const f = fixture();
  f.setTask(0, {
    instruction: "",
    acceptance: "",
    specStatus: "missing",
    specRevision: 0,
  });
  const close = await mount({ ...f, embedded: true });
  try {
    assert.equal(button("提交所选待办").disabled, true);
    assert.match(document.body.textContent, /已选 0 项/);
    await click(field("选中待办：写说明"));
    assert.equal(button("提交所选待办").disabled, false);
    assert.equal(
      f.calls.some((call) => call.body?.action === "save"),
      false,
    );
    await click(button("提交所选待办"));
    const save = f.calls.find((call) => call.body?.action === "save");
    assert.equal(save.body.instruction, "写说明");
    assert.equal(
      save.body.acceptance,
      "根据待办内容核对执行结果，确认是否完成。",
    );
    assert.equal(save.body.expectedGeneration, 3);
    assert.equal(save.body.expectedSpecRevision, 0);
    const intent = f.calls.find((call) => call.route.endsWith("/intents"));
    assert.deepEqual(intent.body.sourceTasks, [
      { noteId: "note-a", taskId: "task-a", generation: 3, specRevision: 1 },
    ]);
    assert.ok(f.calls.indexOf(save) < f.calls.indexOf(intent));
    assert.equal(
      f.calls.filter((call) => call.body?.name === "codex_create_run").length,
      1,
    );
  } finally {
    await close();
  }
});

test("default preparation preserves custom requirements and stops before dispatch when a save receipt is lost", async () => {
  const f = fixture();
  f.setTask(0, { acceptance: "", specStatus: "missing" });
  f.setTask(1, { instruction: "", specStatus: "missing" });
  const checks = [
    {
      id: "review",
      kind: "human",
      required: true,
      description: "保留我的验收要求",
    },
  ];
  f.setChecks(checks);
  let loseReceipt = true;
  const close = await mount({
    ...f,
    embedded: true,
    requestCloud: async (route, options) => {
      const result = await f.requestCloud(route, options);
      if (
        options?.body?.action === "save" &&
        options.body.taskId === "task-b" &&
        loseReceipt
      ) {
        loseReceipt = false;
        throw Error("准备回执未收到");
      }
      return result;
    },
  });
  try {
    await click(field("选中待办：写说明"));
    await click(field("选中待办：创建示例"));
    await click(button("提交所选待办"));
    const saves = f.calls.filter((call) => call.body?.action === "save");
    assert.equal(saves.length, 2);
    assert.equal(saves[0].body.instruction, "执行写说明");
    assert.deepEqual(saves[0].body.acceptanceChecks, checks);
    assert.equal(saves[1].body.instruction, "创建示例");
    assert.equal(saves[1].body.acceptance, "验收创建示例");
    assert.equal(
      f.calls.some((call) => call.route.endsWith("/intents")),
      false,
    );
    assert.match(document.body.textContent, /准备回执未收到/);
    assert.equal(field("选中待办：写说明").checked, true);
    await click(button("重试原操作"));
    assert.equal(
      f.calls.some((call) => call.route.endsWith("/intents")),
      false,
      "recovering a preparation receipt must not start execution",
    );
  } finally {
    await close();
  }
});

test("default preparation preserves an existing file check exactly when acceptance text is omitted", async () => {
  const f = fixture();
  f.setTask(0, { acceptance: "", specStatus: "missing" });
  const checks = [
    {
      id: "exact-report",
      kind: "artifact",
      required: true,
      description: "报告必须包含发布结论",
      relativePath: "reports/release.txt",
      predicate: { type: "textContains", text: "可以发布" },
    },
  ];
  f.setChecks(checks);
  const close = await mount({ ...f, embedded: true });
  try {
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    const save = f.calls.find((call) => call.body?.action === "save");
    assert.ok(save, "existing file checks remain valid for saving");
    assert.deepEqual(save.body.acceptanceChecks, checks);
    assert.equal(save.body.instruction, "执行写说明");
    assert.equal(
      f.calls.filter((call) => call.body?.name === "codex_create_run").length,
      1,
    );
  } finally {
    await close();
  }
});

test("retrying preparation cannot dispatch another tab's newer requirements from a replayed receipt", async () => {
  const f = fixture();
  f.setTask(0, { instruction: "", acceptance: "", specStatus: "missing" });
  let committed;
  const close = await mount({
    ...f,
    embedded: true,
    requestCloud: async (route, options) => {
      if (options?.body?.action === "save") {
        if (committed) {
          const current = await f.requestCloud(route, {
            ...options,
            body: { ...options.body, action: "list" },
          });
          return { ...current, operationId: committed.operationId };
        }
        committed = await f.requestCloud(route, options);
        throw Error("准备回执丢失");
      }
      return f.requestCloud(route, options);
    },
  });
  try {
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    f.setTask(0, {
      instruction: "其他窗口改为发布生产版本",
      specStatus: "ready",
      specRevision: 6,
    });
    await click(button("提交所选待办"));
    assert.equal(
      f.calls.some((call) => call.route.endsWith("/intents")),
      false,
    );
    assert.match(document.body.textContent, /待办已变化，请重新核对后提交/);
  } finally {
    await close();
  }
});

test("dispatch explains selection and editing blockers while stale and locked tasks remain unavailable", async () => {
  const f = fixture();
  f.setTask(0, { specStatus: "stale" });
  f.lockSecondTask();
  const close = await mount({ ...f, embedded: true });
  try {
    assert.equal(field("选中待办：写说明").disabled, true);
    assert.equal(field("选中待办：创建示例").disabled, true);
    assert.match(button("提交所选待办").title, /确认.*执行要求/);
    await click(button("编辑待办：写说明"));
    assert.match(document.body.textContent, /请先保存或取消正在编辑的待办/);
    await click(button("保存待办"));
    await click(field("选中待办：写说明"));
    assert.equal(button("提交所选待办").disabled, false);
  } finally {
    await close();
  }
});

test("embedded checklist keeps compact entry below todos and saves text-only tasks with Enter without executing them", async () => {
  const f = fixture();
  const close = await mount({ ...f, embedded: true });
  try {
    assert.equal(field("新待办"), null);
    assert.ok(
      field("真实待办").compareDocumentPosition(button("添加待办")) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    await click(button("添加待办"));
    const input = field("新待办");
    assert.ok(input);
    assert.equal(input.rows, 1);
    assert.equal(document.activeElement, input);
    assert.equal(
      !!input.closest("details:not([open])"),
      false,
      "quick entry must be visible without expanding a section",
    );
    assert.ok(
      field("真实待办").compareDocumentPosition(input) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.equal(field("新待办执行要求"), null);
    assert.equal(field("新待办验收方式"), null);
    assert.equal(field("新待办完成标准"), null);
    await edit("新待办", "补充移动端空状态");
    await act(async () =>
      input.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(field("新待办"), null);
    assert.equal(document.activeElement, button("添加待办"));
    await click(button("添加待办"));
    assert.equal(field("新待办").value, "补充移动端空状态");
    const enter = async (options = {}) =>
      act(async () => {
        field("新待办").dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        );
      });
    await enter({ isComposing: true });
    await enter({ shiftKey: true });
    assert.equal(
      f.calls.filter((call) => call.body?.action === "create").length,
      0,
    );
    await enter();
    const creates = f.calls.filter((call) => call.body?.action === "create");
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].body.tasks, [
      { text: "补充移动端空状态", instruction: "", acceptance: "" },
    ]);
    assert.match(field("真实待办").textContent, /补充移动端空状态/);
    assert.equal(field("新待办").value, "");
    assert.equal(document.activeElement, field("新待办"));
    await click(field("选中待办：补充移动端空状态"));
    assert.equal(button("提交所选待办").disabled, false);
    assert.equal(
      f.calls.some(
        (call) =>
          call.route.endsWith("/intents") ||
          call.body?.name === "codex_create_run",
      ),
      false,
    );
  } finally {
    await close();
  }
});

test("unbound Agent projects accept repeated manual todos and display their existing tasks", async () => {
  const f = fixture();
  const added = [];
  const page = {
    id: "unbound",
    title: "尚未关联代码的项目",
    tasks: [
      {
        key: "existing",
        note: { id: "note" },
        block: { runs: [{ type: "text", text: "已有待办" }], done: false },
      },
    ],
  };
  const close = await mount({
    ...f,
    embedded: true,
    pages: [page],
    onAddTodo: (sectionId, text) => {
      added.push({ sectionId, text });
      return true;
    },
  });
  try {
    assert.ok(field("真实待办"), "unbound projects still display their todos");
    assert.match(field("真实待办").textContent, /已有待办/);
    assert.equal(field("新待办"), null);
    assert.ok(
      field("真实待办").compareDocumentPosition(button("添加待办")) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    await click(button("添加待办"));
    assert.equal(field("新待办").closest("details:not([open])"), null);
    await edit("新待办", "  第一项  ");
    await click(button("保存新待办"));
    assert.equal(field("新待办").value, "");
    await edit("新待办", "第二项\n保留换行");
    await click(button("保存新待办"));
    assert.deepEqual(added, [
      { sectionId: "unbound", text: "第一项" },
      { sectionId: "unbound", text: "第二项\n保留换行" },
    ]);
    assert.equal(button("保存新待办").disabled, true);
    assert.equal(
      f.calls.some((call) => call.method === "POST"),
      false,
    );
  } finally {
    await close();
  }
});

test("manual todos remain available when the execution binding service is unavailable", async () => {
  const f = fixture();
  const original = f.requestCloud;
  f.requestCloud = async (route, options) => {
    if (route.startsWith("/api/agent/bindings?"))
      throw Error("设备关联暂不可用");
    return original(route, options);
  };
  const added = [];
  const close = await mount({
    ...f,
    embedded: true,
    onAddTodo: (sectionId, text) => {
      added.push({ sectionId, text });
      return true;
    },
  });
  try {
    await edit("新待办", "离线先记下需求");
    await click(button("保存新待办"));
    assert.deepEqual(added, [{ sectionId: "section", text: "离线先记下需求" }]);
    assert.equal(field("新待办").value, "");
    assert.match(document.body.textContent, /设备关联暂不可用/);
  } finally {
    await close();
  }
});

test("unbound quick entry preserves refused drafts and isolates them across projects and accounts", async () => {
  const f = fixture();
  const pages = [{ id: "unbound", title: "项目甲" }];
  const close = await mount({
    ...f,
    embedded: true,
    pages,
    onAddTodo: () => false,
  });
  try {
    await edit("新待办", "不能丢失的草稿");
    await click(button("保存新待办"));
    assert.equal(field("新待办").value, "不能丢失的草稿");
    assert.match(document.body.textContent, /未添加|无法添加/);
    await close.render({ pages: [{ id: "other", title: "项目乙" }] });
    assert.equal(field("新待办"), null);
    await click(button("添加待办"));
    assert.equal(field("新待办").value, "");
    await close.render({ pages });
    assert.equal(field("新待办").value, "不能丢失的草稿");
    await close.render({ pages, userId: "bob" });
    assert.equal(field("新待办"), null);
    await click(button("添加待办"));
    assert.equal(field("新待办").value, "");
    await close.render({ pages, onAddTodo: undefined });
    assert.equal(field("新待办"), null);
  } finally {
    await close();
  }
});

test("saving a todo does not insert a recovery panel above the list while the request is in flight", async () => {
  const f = fixture();
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const close = await mount({
    ...f,
    embedded: true,
    requestCloud: async (route, options) => {
      if (options?.body?.action === "create") await waiting;
      return f.requestCloud(route, options);
    },
  });
  try {
    await edit("新待办", "连续录入");
    await click(button("保存新待办"));
    assert.equal(field("新待办").readOnly, true);
    assert.equal(
      !!field("待核对清单操作"),
      false,
      "normal in-flight writes must not push the task list down",
    );
    await act(async () => release());
    assert.match(field("真实待办").textContent, /连续录入/);
  } finally {
    await act(async () => release());
    await close();
  }
});

test("an editor remains accessible when its task completes in another client", async () => {
  const f = fixture();
  const close = await mount({ ...f, embedded: true });
  try {
    await click(button("编辑待办：创建示例"));
    await edit("编辑待办内容", "未保存的编辑");
    f.finishSecondTask();
    await click(button("刷新清单"));
    assert.equal(!!field("编辑待办内容").closest("details:not([open])"), false);
    assert.equal(field("编辑待办内容").value, "未保存的编辑");
    assert.equal(button("保存待办").disabled, true);
    await click(button("取消编辑"));
    assert.equal(field("编辑待办内容"), null);
  } finally {
    await close();
  }
});

test("finished project sources fold into a separate review collection without marking completion or executing again", async () => {
  const f = fixture();
  let run = {
    runId: "project-review",
    executionMode: "project",
    status: "verifying",
    terminal: true,
    stopConfirmed: true,
    createdAt: "2026-11-13T01:00:00Z",
    submission: {
      tasks: [
        {
          taskId: "task-a",
          source: {
            taskRef: { noteId: "note-a", taskId: "task-a" },
            generation: 3,
            specRevision: 4,
          },
        },
      ],
    },
  };
  const cloud = async (route, options) => {
    if (route.startsWith("/api/agent/execution/runs?"))
      return { runs: run ? [run] : [] };
    if (options?.body?.name === "codex_get_run") return { result: { run } };
    return f.requestCloud(route, options);
  };
  const counts = [];
  const props = {
    ...f,
    embedded: true,
    requestCloud: cloud,
    onCountsChange: (page, count) => counts.push(count),
  };
  let close = await mount(props);
  try {
    assert.ok(field("待核对待办：写说明"));
    assert.equal(field("待核对待办：写说明").disabled, true);
    assert.equal(field("已完成待办").open, false);
    assert.equal(field("已完成待办列表"), null);
    assert.doesNotMatch(field("真实待办").textContent, /写说明/);
    assert.equal(field("已执行待核对").open, false);
    assert.match(field("已执行待核对列表").textContent, /执行已结束，待核对/);
    assert.equal(
      (
        await f.requestCloud("/api/agent/execution/checklist", {
          body: { action: "list" },
        })
      ).tasks[0].done,
      false,
      "folding a finished source does not mark the shared task complete",
    );
    assert.equal(counts.at(-1).pending, 2);
    assert.equal(counts.at(-1).review, 1);
    const original = run;
    await close();
    run = null;
    close = await mount(props);
    assert.equal(
      !!field("待核对待办：写说明"),
      true,
      "review survives leaving the recent run history window",
    );
    run = original;
    await click(button("重新准备待办：写说明"));
    assert.ok(field("选中待办：写说明"));
    assert.equal(field("选中待办：写说明").checked, false);
    assert.match(field("真实待办").textContent, /写说明/);
    assert.equal(field("已执行待核对"), null);
    await close();
    close = await mount(props);
    assert.ok(
      field("选中待办：写说明"),
      "returning to todos persists for this account and binding",
    );
    assert.equal(
      f.calls.some(
        (call) =>
          call.body?.action === "finalize" || call.route.endsWith("/intents"),
      ),
      false,
    );
    run = {
      ...run,
      runId: "new-project-review",
      createdAt: "2026-11-13T02:00:00Z",
    };
    await close.render({ refreshToken: 1 });
    assert.ok(field("待核对待办：写说明"));
    run = {
      ...run,
      runId: "newer-active-project",
      createdAt: "2026-11-13T03:00:00Z",
      status: "running",
      terminal: false,
      stopConfirmed: false,
    };
    await close.render({ refreshToken: 2 });
    assert.equal(
      !!field("选中待办：写说明"),
      true,
      "a newer attempt must leave the collection without manual refresh",
    );
    assert.equal(field("选中待办：写说明").disabled, true);
    run = { ...run, status: "failed", terminal: true, stopConfirmed: true };
    await close.render({ refreshToken: 3 });
    assert.equal(field("选中待办：写说明").disabled, false);
    f.advanceFirst();
    await click(button("刷新清单"));
    assert.ok(
      field("选中待办：远端新正文"),
      "changed sources must not be folded by an older result",
    );
  } finally {
    await close();
  }
});

test("review collection preserves shared completion, includes hidden sources in reorder and unfolds edited content", async () => {
  const f = fixture();
  f.addTask();
  const snapshot = await f.requestCloud("/api/agent/execution/checklist", {
    body: { action: "list" },
  });
  const page = {
    id: "section",
    tasks: snapshot.tasks.map((task) => ({
      note: { id: task.noteId, noteKind: "checklist" },
      key: task.taskId,
      block: {
        done: false,
        completedAt: null,
        runs: [{ type: "text", text: task.text }],
      },
    })),
  };
  const source = (task) => ({
    taskId: task.taskId,
    source: {
      taskRef: { noteId: task.noteId, taskId: task.taskId },
      generation: task.generation,
      specRevision: task.specRevision,
    },
  });
  let run = {
    runId: "review-shared",
    executionMode: "project",
    status: "verifying",
    terminal: true,
    stopConfirmed: true,
    createdAt: "2026-11-13T01:00:00Z",
    submission: { tasks: [source(snapshot.tasks[0])] },
  };
  const counts = [],
    writes = [];
  const close = await mount({
    ...f,
    embedded: true,
    pages: [page],
    requestCloud: async (route, options) => {
      if (route.startsWith("/api/agent/execution/runs?"))
        return { runs: [run] };
      if (options?.body?.name === "codex_get_run") return { result: { run } };
      return f.requestCloud(route, options);
    },
    onCountsChange: (_, count) => counts.push(count),
    onSetTodoDone: (pageId, ref, done) => {
      writes.push({ pageId, ref, done });
      const task = page.tasks.find((task) => task.key === ref.taskId);
      task.block = {
        ...task.block,
        done,
        completedAt: done ? "2026-11-13T02:00:00Z" : null,
      };
      return true;
    },
  });
  try {
    assert.doesNotMatch(field("真实待办").textContent, /写说明/);
    assert.deepEqual(counts.at(-1), { total: 3, pending: 3, review: 1 });
    assert.equal(
      page.tasks.every((task) => !task.block.done),
      true,
    );
    assert.deepEqual(writes, []);
    await click(button("下移待办：创建示例"));
    assert.deepEqual(
      f.calls.findLast((call) => call.body?.action === "reorder").body.order,
      ["a", "d", "b"].map((id) => ({
        noteId: `note-${id}`,
        taskId: `task-${id}`,
      })),
      "reordering visible rows retains the hidden pending source",
    );
    await act(async () =>
      field("已执行待核对").querySelector("summary").click(),
    );
    assert.equal(field("已执行待核对").open, true);
    run = {
      ...run,
      runId: "review-more",
      createdAt: "2026-11-13T02:00:00Z",
      submission: {
        tasks: [source(snapshot.tasks[0]), source(snapshot.tasks[2])],
      },
    };
    await close.render({ refreshToken: 1 });
    assert.equal(
      field("已执行待核对").open,
      false,
      "newly arrived results fold the review collection",
    );
    assert.deepEqual(counts.at(-1), { total: 3, pending: 3, review: 2 });
    page.tasks[2].block.runs = [{ type: "text", text: "本地尚未执行的新正文" }];
    await close.render({ refreshToken: 2 });
    assert.match(field("真实待办").textContent, /本地尚未执行的新正文/);
    assert.doesNotMatch(
      field("已执行待核对列表").textContent,
      /本地尚未执行的新正文/,
    );
    assert.deepEqual(counts.at(-1), { total: 3, pending: 3, review: 1 });
    await click(button("标记完成待办：写说明"));
    assert.deepEqual(writes, [
      {
        pageId: "section",
        ref: { noteId: "note-a", taskId: "task-a" },
        done: true,
      },
    ]);
    assert.equal(page.tasks[0].block.done, true);
    assert.equal(field("已执行待核对"), null);
    assert.match(field("已完成待办列表").textContent, /写说明/);
    assert.deepEqual(counts.at(-1), { total: 3, pending: 2, review: 0 });
  } finally {
    await close();
  }
});

test("truncated checklist views keep the full canvas task count", async () => {
  const f = fixture();
  const tasks = Array.from({ length: 201 }, (_, i) =>
    item(String(i), `任务 ${i + 1}`),
  );
  const counts = [];
  const close = await mount({
    ...f,
    embedded: true,
    pages: [
      {
        id: "section",
        tasks: tasks.map((task) => ({
          note: { id: task.noteId, noteKind: "checklist" },
          key: task.taskId,
          block: { runs: [{ type: "text", text: task.text }], done: false },
        })),
      },
    ],
    onCountsChange: (page, next) => counts.push(next),
    requestCloud: async (route, options) => {
      const result = await f.requestCloud(route, options);
      return options?.body?.action === "list"
        ? { ...result, truncated: true, tasks: tasks.slice(0, 200) }
        : result;
    },
  });
  try {
    assert.equal(counts.at(-1).total, 201);
    assert.equal(counts.at(-1).pending, 201);
  } finally {
    await close();
  }
});

test("select all skips unavailable and blank todos and supports mixed selection without dispatch", async () => {
  const f = fixture();
  const extra = [
    { ...item("blank", " \n ") },
    { ...item("done", "已完成的工作"), done: true },
    { ...item("locked", "锁定的工作"), locked: true },
    { ...item("stale", "需要重新确认"), specStatus: "stale" },
  ];
  const close = await mount({
    ...f,
    embedded: true,
    requestCloud: async (route, options) => {
      const result = await f.requestCloud(route, options);
      return options?.body?.action === "list"
        ? { ...result, tasks: [...result.tasks, ...extra] }
        : result;
    },
  });
  try {
    const all = field("全选待办");
    assert.ok(all);
    assert.equal(field("真实待办").children.length, 4);
    await click(field("选中待办：写说明"));
    assert.equal(all.indeterminate, true);
    await click(all);
    assert.equal(all.checked, true);
    assert.equal(all.indeterminate, false);
    assert.equal(field("选中待办：创建示例").checked, true);
    assert.equal(field("选中待办：锁定的工作").checked, false);
    assert.equal(field("选中待办：需要重新确认").checked, false);
    await click(all);
    assert.equal(field("选中待办：写说明").checked, false);
    assert.equal(field("选中待办：创建示例").checked, false);
    assert.equal(
      f.calls.some(
        (call) => call.body?.name || call.route.endsWith("/intents"),
      ),
      false,
    );
  } finally {
    await close();
  }
});

test("bulk selection respects the 50 task execution limit and can be cleared", async () => {
  const f = fixture();
  const tasks = Array.from({ length: 52 }, (_, index) =>
    item(String(index), `待办 ${index + 1}`),
  );
  const close = await mount({
    ...f,
    embedded: true,
    requestCloud: async (route, options) => {
      const result = await f.requestCloud(route, options);
      return options?.body?.action === "list" ? { ...result, tasks } : result;
    },
  });
  try {
    await click(field("全选待办"));
    assert.equal(
      field("真实待办").querySelectorAll("input:checked").length,
      50,
    );
    assert.equal(field("选中待办：待办 51").checked, false);
    assert.match(document.body.textContent, /50/);
    await click(field("全选待办"));
    assert.equal(field("真实待办").querySelectorAll("input:checked").length, 0);
  } finally {
    await close();
  }
});

test("confirmed completion leaves the active list and selection for a collapsed collection", async () => {
  const f = fixture();
  const close = await mount({ ...f, embedded: true });
  try {
    await click(field("全选待办"));
    f.finishSecondTask();
    await click(button("刷新清单"));
    assert.doesNotMatch(field("真实待办").textContent, /创建示例/);
    assert.equal(field("选中待办：创建示例"), null);
    assert.equal(field("已完成待办").open, false);
    assert.match(field("已完成待办").querySelector("summary").textContent, /1/);
    await act(async () => field("已完成待办").querySelector("summary").click());
    assert.match(field("已完成待办列表").textContent, /创建示例/);
    assert.match(document.body.textContent, /已选 1 项/);
    assert.equal(field("全选待办").checked, true);
    f.setTask(1, { done: false });
    await click(button("刷新清单"));
    assert.ok(field("选中待办：创建示例"));
    assert.equal(field("选中待办：创建示例").checked, false);
  } finally {
    await close();
  }
});

test("unbound checklist separates completed work and omits empty editing rows", async () => {
  const f = fixture();
  const counts = [];
  const close = await mount({
    ...f,
    embedded: true,
    onCountsChange: (page, value) => counts.push(value),
    pages: [
      {
        id: "unbound",
        tasks: [
          {
            key: "empty",
            note: { id: "n" },
            block: { runs: [{ type: "text", text: "  " }] },
          },
          {
            key: "live",
            note: { id: "n" },
            block: { runs: [{ type: "text", text: "待处理" }] },
          },
          {
            key: "done",
            note: { id: "n" },
            block: { runs: [{ type: "text", text: "已处理" }], done: true },
          },
        ],
      },
    ],
  });
  try {
    assert.equal(field("真实待办").children.length, 1);
    assert.match(field("真实待办").textContent, /待处理/);
    assert.equal(field("已完成待办").open, false);
    assert.match(field("已完成待办列表").textContent, /已处理/);
    assert.deepEqual(counts.at(-1), { total: 2, pending: 1, review: 0 });
  } finally {
    await close();
  }
});

test("permission selection is explicit, scoped to the account and binding, and frozen into the submitted intent", async () => {
  localStorage.clear();
  localStorage.setItem(
    `qingdan.execution-permissions:${JSON.stringify(["alice", "binding", 1])}`,
    "workspace_manual",
  );
  const f = fixture();
  const close = await mount(f);
  try {
    assert.match(button("设置执行权限").textContent, /完全访问/);
    await click(button("设置执行权限"));
    await click(field("项目内编辑 · 自动安全审查"));
    await click(button("完成权限设置"));
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    const intent = f.calls.find((c) => c.route.endsWith("/intents"));
    assert.deepEqual(intent.body.executionPermissions, {
      profile: "workspace_auto",
    });
  } finally {
    await close();
  }
  const reopened = await mount(fixture());
  try {
    assert.match(button("设置执行权限").textContent, /自动安全审查/);
    await reopened.render({ userId: "bob" });
    assert.match(button("设置执行权限").textContent, /完全访问/);
  } finally {
    await reopened();
    localStorage.clear();
  }
});

test("step 5 persists real checklist edits and order with the committed identities", async () => {
  const f = fixture();
  const unmount = await mount(f);
  try {
    assert.match(document.body.textContent, /本机项目/);
    await click(button("添加测试待办草稿"));
    assert.equal(
      f.calls.some((call) => call.body?.action === "create"),
      false,
    );
    await edit("新待办", "核对结果");
    await edit("新待办执行要求", "打开生成的报告");
    await edit("新待办完成标准", "确认文件存在");
    f.loseCreateReceipt();
    await click(button("保存新待办"));
    assert.equal(field("新待办").value, "核对结果");
    await click(button("保存新待办"));
    const creates = f.calls.filter((call) => call.body?.action === "create");
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[0].body, creates[1].body);
    assert.deepEqual(creates[1].body.tasks, [
      {
        text: "核对结果",
        instruction: "打开生成的报告",
        acceptance: "确认文件存在",
      },
    ]);

    await click(button("编辑待办：写说明"));
    await edit("编辑执行要求", "写安装说明");
    await click(button("保存待办"));
    const { requestId, ...save } = f.calls.find(
      (call) => call.body?.action === "save",
    ).body;
    assert.ok(requestId);
    assert.deepEqual(save, {
      bindingId: "binding",
      action: "save",
      noteId: "note-a",
      taskId: "task-a",
      expectedGeneration: 3,
      expectedSpecRevision: 4,
      instruction: "写安装说明",
      acceptance: "验收写说明",
    });

    await click(button("下移待办：写说明"));
    const move = f.calls.find((call) => call.body?.action === "reorder").body;
    assert.equal(move.expectedSequence, 12);
    assert.deepEqual(move.order, [
      { noteId: "note-b", taskId: "task-b" },
      { noteId: "note-a", taskId: "task-a" },
      { noteId: "note-c", taskId: "task-c" },
    ]);
  } finally {
    await unmount();
  }
});

test("step 5 dispatches one batch in checklist order and displays confirmed writeback", async () => {
  const f = fixture();
  const unmount = await mount(f);
  try {
    assert.equal(field("自动勾选完成").checked, true);
    await click(field("选中待办：创建示例"));
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    const { requestId, ...intent } = f.calls.find((call) =>
      call.route.endsWith("/intents"),
    ).body;
    assert.ok(requestId);
    assert.deepEqual(intent, {
      bindingId: "binding",
      bindingRevision: 1,
      kind: "task",
      autoComplete: true,
      executionPermissions: { profile: "full_access" },
      sourceTasks: [
        { noteId: "note-a", taskId: "task-a", generation: 3, specRevision: 4 },
        { noteId: "note-b", taskId: "task-b", generation: 3, specRevision: 4 },
      ],
    });
    assert.equal(
      f.calls.filter((call) => call.body?.name === "codex_create_run").length,
      1,
    );
    assert.deepEqual(
      f.calls.find((call) => call.route === "/execution/context").body,
      { workspaceId: "workspace" },
    );
    f.complete();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 2600)));
    assert.ok(document.querySelector('a[href="codex://threads/chat-1"]'));
    assert.match(document.body.textContent, /已更新清单/);
    assert.match(document.body.textContent, /需核对/);
    assert.equal(field("已完成待办：写说明").disabled, true);
    assert.equal(field("已完成待办：写说明").checked, true);
    assert.match(document.body.textContent, /已完成/);
  } finally {
    await unmount();
  }
});

test("workspace submits all selected sources once as a project run and exposes its exact chat target", async () => {
  const f = fixture();
  const opened = [];
  const close = await mount({
    ...f,
    embedded: true,
    onOpenBatch: (target) => opened.push(target),
  });
  try {
    await click(field("选中待办：创建示例"));
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    const intents = f.calls.filter((call) => call.route.endsWith("/intents"));
    assert.equal(intents.length, 1);
    assert.equal(intents[0].body.executionMode, "project");
    assert.deepEqual(
      intents[0].body.sourceTasks.map((task) => task.taskId),
      ["task-a", "task-b"],
    );
    assert.equal(intents[0].body.autoComplete, false);
    assert.equal(
      f.calls.filter((call) => call.body?.name === "codex_create_run").length,
      1,
    );
    assert.deepEqual(opened, [
      {
        sectionId: "section",
        bindingId: "binding",
        bindingRevision: 1,
        runId: "run",
      },
    ]);
  } finally {
    await close();
  }
});

test("active project submissions protect their source todos and block a second start", async () => {
  const f = fixture();
  const completionUpdates = [];
  const run = {
    runId: "active-project",
    executionMode: "project",
    kind: "task",
    sourceBacked: true,
    status: "running",
    terminal: false,
    stopConfirmed: false,
    submission: {
      tasks: [{ taskId: "task-a", source: { taskRef: { noteId: "note-a" } } }],
    },
  };
  const close = await mount({
    ...f,
    embedded: true,
    onSetTodoDone: (...args) => {
      completionUpdates.push(args);
      return true;
    },
    requestCloud: async (route, options) => {
      if (route.includes("/runs?")) return { runs: [run] };
      if (options?.body?.name === "codex_get_run")
        return { result: { run, events: [] } };
      return f.requestCloud(route, options);
    },
  });
  try {
    assert.equal(field("选中待办：写说明").disabled, true);
    assert.equal(button("编辑待办：写说明").disabled, true);
    assert.equal(button("标记完成待办：写说明").disabled, true);
    await act(async () => button("标记完成待办：写说明").click());
    assert.deepEqual(completionUpdates, []);
    await click(field("选中待办：创建示例"));
    assert.equal(button("提交所选待办").disabled, true);
    assert.match(document.body.textContent, /项目正在执行/);
    assert.equal(
      f.calls.some((call) => call.route.endsWith("/intents")),
      false,
    );
  } finally {
    await close();
  }
});

test("a removed task keeps its unsaved editor accessible and locked tasks cannot be dispatched", async () => {
  const f = fixture();
  f.lockSecondTask();
  const unmount = await mount(f);
  try {
    assert.equal(field("选中待办：创建示例").disabled, true);
    assert.equal(button("编辑待办：创建示例").disabled, true);
    assert.equal(button("下移待办：写说明").disabled, true);
    await click(button("编辑待办：写说明"));
    await edit("编辑执行要求", "尚未保存的更改");
    f.removeFirstTask();
    await click(button("刷新清单"));
    assert.equal(field("编辑执行要求").value, "尚未保存的更改");
    assert.equal(button("保存待办").disabled, true);
    await click(button("取消编辑"));
    assert.equal(field("编辑执行要求"), null);
  } finally {
    await unmount();
  }
});

test("a binding revision change clears the prior scope before any checklist mutation", async () => {
  const f = fixture();
  const unmount = await mount(f);
  try {
    await edit("新待办", "旧项目的草稿");
    f.rebind();
    await click(button("保存新待办"));
    assert.equal(
      f.calls.some((call) => call.body?.action === "create"),
      false,
    );
    assert.equal(field("新待办").value, "");
  } finally {
    await unmount();
  }
});

test("an earlier account's delayed checklist cannot populate a later account's tab", async () => {
  const f = fixture();
  const request = f.requestCloud;
  let release;
  f.requestCloud = (route, options) => {
    if (options.accountId === "bob" && route.startsWith("/api/agent/bindings?"))
      return Promise.resolve({ binding: null });
    if (options.accountId === "alice" && route.endsWith("/checklist"))
      return new Promise((resolve) => {
        release = () => resolve(request(route, options));
      });
    return request(route, options);
  };
  const unmount = await mount(f);
  try {
    assert.equal(typeof release, "function");
    await unmount.render({ userId: "bob" });
    await act(async () => release());
    assert.match(document.body.textContent, /此清单尚未关联执行项目/);
    assert.doesNotMatch(document.body.textContent, /创建示例|写说明/);
    assert.equal(
      f.calls.some(
        (call) => call.accountId === "bob" && call.route.endsWith("/checklist"),
      ),
      false,
    );
  } finally {
    await unmount();
  }
});

test("step 5 can dispatch without automatic completion and waits for confirmed stop", async () => {
  const f = fixture();
  const unmount = await mount(f);
  try {
    await click(field("自动勾选完成"));
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    assert.equal(
      f.calls.find((call) => call.route.endsWith("/intents")).body.autoComplete,
      false,
    );
    await click(button("请求停止"));
    assert.match(document.body.textContent, /正在等待本机确认停止/);
    assert.doesNotMatch(document.body.textContent, /批次已停止/);
    f.confirmStop();
    await click(button("刷新清单"));
    assert.match(document.body.textContent, /批次已停止/);
    assert.doesNotMatch(document.body.textContent, /正在等待本机确认停止/);
    assert.equal(field("选中待办：写说明").disabled, false);
  } finally {
    await unmount();
  }
});

test("reopening a checklist without any source tasks still exposes its active batch and stop control", async () => {
  const f = fixture();
  const closeFirst = await mount(f);
  try {
    await click(field("选中待办：写说明"));
    await click(field("选中待办：创建示例"));
    await click(button("提交所选待办"));
    assert.ok(document.querySelector('a[href="codex://threads/chat-1"]'));
  } finally {
    await closeFirst();
  }
  f.removeFirstTask();
  f.removeFirstTask();
  const closeReopened = await mount(f);
  try {
    assert.match(document.body.textContent, /清单里还没有待办/);
    assert.ok(document.querySelector('a[href="codex://threads/chat-1"]'));
    await click(button("刷新清单"));
    await click(button("请求停止"));
    const stop = f.calls.find((call) => call.body?.name === "codex_cancel_run");
    assert.equal(stop.body.arguments.runId, "run");
  } finally {
    await closeReopened();
  }
});

test("file acceptance is explicit, saved, read back and can be changed to human confirmation", async () => {
  const f = fixture();
  const unmount = await mount(f);
  try {
    assert.equal(field("新待办验收方式").value, "human");
    await edit("新待办", "生成报告");
    await edit("新待办执行要求", "创建 report.txt");
    await edit("新待办完成标准", "报告包含完成");
    await select("新待办验收方式", "file");
    await edit("新待办检查文件", "report.txt");
    await select("新待办文件检查", "textContains");
    await edit("新待办包含文字", "完成");
    await click(button("保存新待办"));
    assert.deepEqual(
      f.calls.find((call) => call.body?.action === "create").body.tasks[0]
        .acceptanceChecks,
      [
        {
          id: "checklist-file",
          kind: "artifact",
          required: true,
          description: "报告包含完成",
          relativePath: "report.txt",
          predicate: { type: "textContains", text: "完成" },
        },
      ],
    );
    await click(button("编辑待办：生成报告"));
    assert.equal(field("编辑检查文件").value, "report.txt");
    assert.equal(field("编辑包含文字").value, "完成");
    await select("编辑验收方式", "human");
    await click(button("保存待办"));
    assert.deepEqual(
      f.calls.find((call) => call.body?.action === "save").body
        .acceptanceChecks,
      [],
    );
  } finally {
    await unmount();
  }
});

test("editing text preserves existing acceptance checks that the simple form cannot edit", async () => {
  const f = fixture();
  const checks = [
    {
      id: "test-suite",
      kind: "command",
      required: true,
      description: "测试通过",
      checkId: "unit",
    },
  ];
  f.setChecks(checks);
  const unmount = await mount(f);
  try {
    await click(button("编辑待办：写说明"));
    assert.equal(field("编辑验收方式").value, "custom");
    await edit("编辑执行要求", "补充说明");
    await click(button("保存待办"));
    assert.deepEqual(
      f.calls.find((call) => call.body?.action === "save").body
        .acceptanceChecks,
      checks,
    );
  } finally {
    await unmount();
  }
});

test("a submitted or historical batch opens step 8 with its exact run identity", async () => {
  const f = fixture();
  const opened = [];
  const unmount = await mount({
    ...f,
    onOpenBatch: (target) => opened.push(target),
  });
  try {
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    assert.deepEqual(opened, [
      {
        sectionId: "section",
        bindingId: "binding",
        bindingRevision: 1,
        runId: "run",
      },
    ]);
    await click(button("查看批次"));
    assert.deepEqual(opened[1], opened[0]);
    assert.equal(
      f.calls.filter((call) => call.body?.name === "codex_create_run").length,
      1,
    );
  } finally {
    await unmount();
  }
});

test("checklist history does not label unverified native completion as acceptance success", async () => {
  const f = fixture();
  const unmount = await mount(f);
  try {
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    f.waitForHuman();
    await click(button("刷新清单"));
    assert.match(document.body.textContent, /本项等待你确认验收/);
    assert.match(document.body.textContent, /待人工验收/);
    assert.doesNotMatch(
      document.querySelector('[aria-label="真实批次进度"]').textContent,
      /执行成功/,
    );
  } finally {
    await unmount();
  }
});

test("embedded checklist refreshes saved chat tasks without losing selection or either draft", async () => {
  window.sessionStorage.clear();
  const f = fixture(),
    close = await mount({ ...f, embedded: true, refreshToken: 0 });
  try {
    assert.equal(field("选择真实清单"), null);
    assert.equal(button("添加测试待办草稿"), undefined);
    await edit("新待办", "新建草稿");
    await click(field("选中待办：创建示例"));
    await click(button("编辑待办：写说明"));
    await edit("编辑待办内容", "还没保存的修改");
    f.addTask();
    await close.render({ embedded: true, refreshToken: 1 });
    assert.ok(field("选中待办：聊天整理的新待办"));
    assert.equal(field("选中待办：创建示例").checked, true);
    assert.equal(field("新待办").value, "新建草稿");
    assert.equal(field("编辑待办内容").value, "还没保存的修改");
    assert.equal(
      f.calls.some((c) => c.route.endsWith("/intents")),
      false,
    );
  } finally {
    await close();
    window.sessionStorage.clear();
  }
});

test("embedded drafts survive project switching and remounts without leaking to another account", async () => {
  window.sessionStorage.clear();
  const f = fixture(),
    opened = [];
  const close = await mount({
    ...f,
    embedded: true,
    onOpenSettings: () => opened.push(true),
  });
  try {
    await edit("新待办", "只属于这个项目的草稿");
    await click(button("编辑待办：写说明"));
    await edit("编辑待办内容", "尚未保存的标准");
    await close.render({
      embedded: true,
      pages: [{ id: "unbound", title: "另一项目" }],
    });
    assert.equal(field("新待办"), null);
    await click(button("选择项目"));
    assert.equal(opened.length, 1);
    assert.doesNotMatch(document.body.textContent, /第 3 步/);
    await close.render({
      embedded: true,
      pages: [{ id: "section", title: "我的清单" }],
    });
    assert.equal(field("新待办").value, "只属于这个项目的草稿");
    assert.equal(field("编辑待办内容").value, "尚未保存的标准");
    await close.render({
      embedded: true,
      userId: "bob",
      pages: [{ id: "section", title: "我的清单" }],
    });
    assert.equal(field("新待办"), null);
    await click(button("添加待办"));
    assert.equal(field("新待办").value, "");
    assert.equal(field("编辑待办内容"), null);
  } finally {
    await close();
    window.sessionStorage.clear();
  }
});

for (const outcome of ["lost response", "project switch before response"]) {
  test(`embedded create remains idempotent after ${outcome} and remount`, async () => {
    window.sessionStorage.clear();
    const f = fixture(),
      request = f.requestCloud,
      receipts = new Map(),
      attempts = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.requestCloud = async (route, options) => {
      if (!route.endsWith("/checklist") || options.body.action !== "create")
        return request(route, options);
      attempts.push(options.body.requestId);
      if (receipts.has(options.body.requestId))
        return receipts.get(options.body.requestId);
      const result = await request(route, options);
      receipts.set(options.body.requestId, result);
      if (attempts.length === 1) {
        if (outcome === "lost response") throw Error("回执未收到");
        await gate;
      }
      return result;
    };
    const close = await mount({ ...f, embedded: true });
    try {
      await edit("新待办", "跨项目重试只创建一次");
      await click(button("保存新待办"));
      await close.render({
        embedded: true,
        pages: [{ id: "unbound", title: "另一项目" }],
      });
      await act(async () => {
        release();
        await gate;
      });
      await close.render({
        embedded: true,
        pages: [{ id: "section", title: "我的清单" }],
      });
      assert.equal(field("新待办").value, "跨项目重试只创建一次");
      await click(button("保存新待办"));
      assert.equal(attempts.length, 2);
      assert.equal(attempts[1], attempts[0]);
      assert.equal(receipts.size, 1);
      assert.equal(field("新待办").value, "");
    } finally {
      release();
      await close();
      window.sessionStorage.clear();
    }
  });
}

const oldScope = JSON.stringify([
  "alice",
  "canvas",
  "section",
  JSON.stringify(["binding", 1, "runner", "workspace"]),
]);
const oldPendingKey = `qingdan.agent-checklist-requests:${oldScope}`;
const requestRecords = () =>
  Object.keys(localStorage)
    .filter((key) => key.startsWith("qingdan.agent-requests:v1:"))
    .flatMap((key) => JSON.parse(localStorage.getItem(key)).records);

for (const embedded of [false, true])
  test(`recovery: full reopen retains draft and exact create identity in display mode ${embedded}`, async () => {
    const f = fixture();
    let close = await mount({ ...f, embedded });
    try {
      await edit("新待办", "重开后保留");
      f.loseCreateReceipt();
      await click(button("保存新待办"));
      const original = f.calls.find((c) => c.body?.action === "create").body;
      await close();
      window.sessionStorage.clear();
      close = await mount({ ...f, embedded });
      assert.equal(field("新待办").value, "重开后保留");
      assert.equal(
        f.calls.filter((c) => c.body?.action === "create").length,
        1,
        "restore is read only",
      );
      await click(button("重试原操作"));
      assert.deepEqual(
        f.calls.filter((c) => c.body?.action === "create").at(-1).body,
        original,
      );
      assert.equal(field("新待办").value, "");
      assert.equal(requestRecords().length, 0);
    } finally {
      await close();
    }
  });

test("recovery: legacy JSON Map keys carry the original payload, not the currently edited draft", async () => {
  const payload = {
    tasks: [
      { text: "旧请求正文", instruction: "旧要求", acceptance: "旧验收" },
    ],
  };
  window.sessionStorage.setItem(
    oldPendingKey,
    JSON.stringify([
      [
        JSON.stringify(["create", payload]),
        { requestId: "old-create", input: null },
      ],
    ]),
  );
  const f = fixture(),
    close = await mount(f);
  try {
    assert.equal(window.sessionStorage.getItem(oldPendingKey), null);
    assert.equal(requestRecords()[0].requestId, "old-create");
    await edit("新待办", "后来编辑的新草稿");
    await click(button("重试原操作"));
    assert.deepEqual(f.calls.find((c) => c.body?.action === "create").body, {
      bindingId: "binding",
      action: "create",
      requestId: "old-create",
      ...payload,
    });
    assert.equal(
      field("新待办").value,
      "后来编辑的新草稿",
      "old ACK cannot clear new draft",
    );
  } finally {
    await close();
  }
});

test("recovery: malformed legacy requests stay read-only rather than being rebuilt", async () => {
  window.sessionStorage.setItem(
    oldPendingKey,
    JSON.stringify([
      [
        JSON.stringify(["create", {}]),
        { requestId: "incomplete", input: null },
      ],
    ]),
  );
  const f = fixture(),
    close = await mount(f);
  try {
    assert.match(document.body.textContent, /旧操作.*只读|旧操作.*不完整/);
    assert.equal(button("重试原操作"), undefined);
    assert.equal(requestRecords().length, 0);
    assert.ok(window.sessionStorage.getItem(oldPendingKey));
    assert.equal(
      f.calls.some((c) => c.body?.action === "create"),
      false,
    );
  } finally {
    await close();
  }
});

test("recovery: version conflict requires explicit reload and leaves the old draft copyable", async () => {
  const f = fixture(),
    close = await mount(f);
  try {
    await click(button("编辑待办：写说明"));
    await edit("编辑执行要求", "本地未保存要求");
    f.advanceFirst();
    await click(button("刷新清单"));
    assert.equal(field("编辑执行要求").value, "本地未保存要求");
    assert.ok(button("保存待办").disabled);
    await click(button("载入最新后重新编辑"));
    assert.equal(field("编辑待办内容").value, "远端新正文");
    assert.match(field("保留的编辑草稿").value, /本地未保存要求/);
    await edit("编辑执行要求", "明确重新编辑");
    await click(button("保存待办"));
    assert.equal(
      f.calls.find((c) => c.body?.action === "save").body.expectedGeneration,
      4,
    );
  } finally {
    await close();
  }
});

test("recovery: intent result is checkpointed and only final create receipt resolves dispatch", async () => {
  const f = fixture(),
    original = f.requestCloud;
  let fail = true,
    close;
  f.requestCloud = async (route, options) => {
    if (options?.body?.name === "codex_create_run" && fail) {
      fail = false;
      throw Error("create ACK lost");
    }
    return original(route, options);
  };
  close = await mount(f);
  try {
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    const [record] = requestRecords();
    assert.ok(record);
    assert.equal(record.request.path, "/api/agent/execution/intents");
    assert.equal(
      record.checkpoint.nextRequest.body.arguments.requestId,
      record.requestId,
    );
    assert.deepEqual(
      record.checkpoint.nextRequest.body.arguments,
      record.checkpoint.result.input,
    );
    await close();
    window.sessionStorage.clear();
    close = await mount(f);
    assert.equal(f.calls.filter((c) => c.route.endsWith("/intents")).length, 1);
    await click(button("重试原操作"));
    assert.equal(f.calls.filter((c) => c.route.endsWith("/intents")).length, 1);
    assert.equal(requestRecords().length, 0);
  } finally {
    await close();
  }
});

test("recovery: absent is retained and explicit atomic sealing releases a full legacy journal", async () => {
  const entries = Array.from({ length: 100 }, (_, i) => [
    JSON.stringify([
      "create",
      { tasks: [{ text: `old ${i}`, instruction: "", acceptance: "" }] },
    ]),
    { requestId: `old-${i}`, input: null },
  ]);
  window.sessionStorage.setItem(oldPendingKey, JSON.stringify(entries));
  const f = fixture(),
    original = f.requestCloud;
  f.requestCloud = async (route, options) =>
    options?.body?.action === "receipt"
      ? { status: "absent" }
      : options?.body?.action === "abandon_request"
        ? { status: "sealed" }
        : original(route, options);
  const close = await mount(f);
  try {
    assert.equal(requestRecords().length, 100);
    await click(button("核对原操作"));
    assert.equal(requestRecords().length, 100);
    await click(button("放弃原操作"));
    assert.equal(requestRecords().length, 99);
    await edit("新待办", "解除积压后新建");
    await click(button("保存新待办"));
    assert.ok(f.calls.some((c) => c.body?.action === "create"));
  } finally {
    await close();
  }
});

test("recovery: a lost abandon ACK reopens with the exact seal request and never replays the original mutation", async () => {
  const f = fixture(),
    original = f.requestCloud,
    sent = [];
  let loseSeal = true,
    close;
  f.requestCloud = async (route, options) => {
    if (options?.body?.action === "abandon_request") {
      sent.push(structuredClone(options.body));
      if (loseSeal) {
        loseSeal = false;
        throw Error("sealed ACK lost");
      }
      return { status: "sealed" };
    }
    return original(route, options);
  };
  close = await mount(f);
  try {
    await edit("新待办", "待封存原稿");
    f.loseCreateReceipt();
    await click(button("保存新待办"));
    const originalBody = requestRecords()[0].request.body;
    await click(button("放弃原操作"));
    assert.deepEqual(requestRecords()[0].request.body, originalBody);
    assert.deepEqual(
      requestRecords()[0].checkpoint.abandonRequest.body,
      sent[0],
    );
    await close();
    window.sessionStorage.clear();
    close = await mount(f);
    assert.equal(sent.length, 1, "restore must not send a seal or a mutation");
    await click(button("重试封存"));
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(requestRecords().length, 0);
    assert.equal(field("新待办").value, "待封存原稿");
    assert.equal(f.calls.filter((c) => c.body?.action === "create").length, 1);
  } finally {
    await close();
  }
});

test("recovery: failing to persist an intent checkpoint prevents the second execution POST", async () => {
  const f = fixture(),
    originalSet = window.Storage.prototype.setItem;
  let deny = true;
  const close = await mount(f);
  try {
    window.Storage.prototype.setItem = function (key, value) {
      if (
        deny &&
        key.startsWith("qingdan.agent-requests:") &&
        value.includes('"nextRequest"')
      )
        throw Error("checkpoint disk full");
      return originalSet.call(this, key, value);
    };
    await click(field("选中待办：写说明"));
    await click(button("提交所选待办"));
    assert.equal(
      f.calls.filter((c) => c.body?.name === "codex_create_run").length,
      0,
    );
    assert.equal(requestRecords().length, 1);
    assert.equal(requestRecords()[0].checkpoint, null);
    const originalBody = requestRecords()[0].request.body;
    deny = false;
    await click(button("重试原操作"));
    assert.deepEqual(
      f.calls.filter((c) => c.route.endsWith("/intents")).map((c) => c.body),
      [originalBody, originalBody],
    );
    assert.equal(
      f.calls.filter((c) => c.body?.name === "codex_create_run").length,
      1,
    );
    assert.equal(requestRecords().length, 0);
  } finally {
    window.Storage.prototype.setItem = originalSet;
    await close();
  }
});

for (const kind of ["new", "edit"])
  test(`recovery: late ACK cannot clear a later persisted ${kind} draft`, async () => {
    const f = fixture(),
      request = f.requestCloud;
    let release;
    const gate = new Promise((done) => {
      release = done;
    });
    f.requestCloud = async (route, options) => {
      const result = await request(route, options);
      if (options?.body?.action === (kind === "new" ? "create" : "save"))
        await gate;
      return result;
    };
    const close = await mount(f);
    try {
      if (kind === "new") {
        await edit("新待办", "原稿");
        await click(button("保存新待办"));
      } else {
        await click(button("编辑待办：写说明"));
        await edit("编辑执行要求", "原要求");
        await click(button("保存待办"));
      }
      const key = `qingdan.agent-draft:${oldScope}:${kind === "new" ? "new-task" : "edit-task"}`;
      const stored = JSON.parse(localStorage.getItem(key));
      if (kind === "new") stored.value.text = "后来写的新草稿";
      else stored.value.value.instruction = "后来写的新要求";
      await act(async () => {
        localStorage.setItem(key, JSON.stringify(stored));
        window.dispatchEvent(new window.StorageEvent("storage", { key }));
      });
      await act(async () => {
        release();
        await gate;
      });
      assert.equal(
        field(kind === "new" ? "新待办" : "编辑执行要求").value,
        kind === "new" ? "后来写的新草稿" : "后来写的新要求",
      );
      assert.deepEqual(JSON.parse(localStorage.getItem(key)), stored);
    } finally {
      release();
      await close();
    }
  });

test("recovery: generic HTTP rejection and source reads never discard the original request", async () => {
  const f = fixture(),
    original = f.requestCloud;
  f.requestCloud = async (route, options) => {
    if (options?.body?.action === "create")
      throw Object.assign(Error("generic 409"), { status: 409 });
    if (options?.body?.action === "receipt") return { status: "absent" };
    return original(route, options);
  };
  const close = await mount(f);
  try {
    await edit("新待办", "冲突仍未知");
    await click(button("保存新待办"));
    const before = requestRecords();
    await click(button("刷新清单"));
    await click(button("核对原操作"));
    assert.deepEqual(requestRecords(), before);
  } finally {
    await close();
  }
});

test("recovery: a volatile legacy stop retires its old session entry after durable promotion and ACK", async () => {
  navigator.locks = undefined;
  window.sessionStorage.setItem(
    oldPendingKey,
    JSON.stringify([
      [
        JSON.stringify(["stop", "run"]),
        { requestId: "original-stop", input: null },
      ],
    ]),
  );
  const f = fixture();
  let close = await mount(f);
  try {
    assert.ok(window.sessionStorage.getItem(oldPendingKey));
    navigator.locks = browserLocks();
    await click(button("重试原操作"));
    assert.equal(
      f.calls.find((c) => c.body?.name === "codex_cancel_run").body.arguments
        .requestId,
      "original-stop",
    );
    assert.equal(window.sessionStorage.getItem(oldPendingKey), null);
    await close();
    close = await mount(f);
    assert.equal(requestRecords().length, 0);
    assert.equal(button("重试原操作"), undefined);
  } finally {
    await close();
  }
});
