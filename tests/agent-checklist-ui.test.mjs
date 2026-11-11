import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  entryPoints: [resolve("src/agent/AgentExperience.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
});
const { default: AgentExperience, ChecklistPanel } = await import(
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
          payloadHash: "hash",
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
    lockSecondTask() {
      tasks[1] = { ...tasks[1], locked: true, editableText: false };
      sequence++;
    },
    rebind() {
      binding.revision++;
    },
    setChecks(checks) {
      tasks[0].acceptanceChecks = checks;
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

test("permission selection is explicit, scoped to the account and binding, and frozen into the submitted intent", async () => {
  localStorage.clear();
  const f = fixture();
  const close = await mount(f);
  try {
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
    assert.match(button("设置执行权限").textContent, /人工批准/);
  } finally {
    await reopened();
    localStorage.clear();
  }
});

test("agent verification opens the real checklist in its fifth tab", async () => {
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () =>
      root.render(
        React.createElement(AgentExperience, {
          roomId: "canvas",
          userId: "alice",
          pages: [],
          onClose() {},
        }),
      ),
    );
    assert.ok(document.querySelectorAll('[role="tab"]').length >= 5);
    await click(button("5 · 真实清单"));
    assert.match(
      document.querySelector('[role="tabpanel"]').textContent,
      /此画布还没有清单/,
    );
  } finally {
    await act(async () => root.unmount());
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
      executionPermissions: { profile: "workspace_manual" },
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
    await edit("编辑执行要求", "还没保存的修改");
    f.addTask();
    await close.render({ embedded: true, refreshToken: 1 });
    assert.ok(field("选中待办：聊天整理的新待办"));
    assert.equal(field("选中待办：创建示例").checked, true);
    assert.equal(field("新待办").value, "新建草稿");
    assert.equal(field("编辑执行要求").value, "还没保存的修改");
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
    await edit("编辑完成标准", "尚未保存的标准");
    await close.render({
      embedded: true,
      pages: [{ id: "unbound", title: "另一项目" }],
    });
    assert.equal(field("新待办"), null);
    await click(button("选择 Codex 会话"));
    assert.equal(opened.length, 1);
    assert.doesNotMatch(document.body.textContent, /第 3 步/);
    await close.render({
      embedded: true,
      pages: [{ id: "section", title: "我的清单" }],
    });
    assert.equal(field("新待办").value, "只属于这个项目的草稿");
    assert.equal(field("编辑完成标准").value, "尚未保存的标准");
    await close.render({
      embedded: true,
      userId: "bob",
      pages: [{ id: "section", title: "我的清单" }],
    });
    assert.equal(field("新待办").value, "");
    assert.equal(field("编辑完成标准"), null);
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
