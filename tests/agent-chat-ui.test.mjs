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
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const temp = mkdtempSync(resolve("node_modules/.cache/agent-chat-ui-"));
await build({
  entryPoints: [resolve("src/agent/AgentExperience.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(temp, "ui.mjs"),
});
const { ChatPanel } = await import(pathToFileURL(resolve(temp, "ui.mjs")));
rmSync(temp, { recursive: true, force: true });

const field = (label) => document.querySelector(`[aria-label="${label}"]`);
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (element) =>
      element.textContent.trim() === label ||
      element.getAttribute("aria-label") === label,
  );
async function click(label) {
  const element = button(label);
  assert.ok(element, label);
  assert.equal(element.disabled, false, label);
  await act(async () => element.click());
}
async function edit(label, value) {
  const element = field(label);
  assert.ok(element, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element.tagName === "INPUT"
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const thread = {
  id: "chat",
  bindingId: "bound",
  title: "检查文档",
  createdAt: "2026-11-05T00:00:00Z",
  updatedAt: "2026-11-05T00:00:00Z",
};
const assistant = {
  id: "assistant-1",
  bindingId: "bound",
  chatId: "chat",
  sequence: 2,
  role: "assistant",
  createdAt: thread.createdAt,
  text: "先整理项目的安装说明。",
  tasks: [
    {
      text: "整理安装说明",
      instruction: "检查 README",
      acceptance: "有安装步骤",
    },
  ],
  memories: [{ scope: "project", key: "文档语言", value: "简体中文" }],
  taskProposal: { status: "draft" },
  memoryStates: ["available"],
};

function fixture({ configured = true, bound = true, existing = false } = {}) {
  const calls = [];
  let selected = existing ? thread : null;
  let messages = existing ? [structuredClone(assistant)] : [];
  let job = null;
  let memories = [];
  let memoryEpoch = 0;
  let loseSave = false;
  let noSaveReceipt = false;
  let loseState = false;
  let submissions = 0;
  let bindingRevision = 2;
  let newChat = null;
  let sendStatus = "queued";
  let project;
  let failNew = false;
  const requestCloud = async (route, options = {}) => {
    calls.push({ route, ...options });
    if (route.startsWith("/api/agent/bindings?"))
      return {
        binding: bound
          ? { bindingId: "bound", revision: bindingRevision, enabled: true }
          : null,
      };
    if (route.startsWith("/api/agent/chat/state")) {
      if (loseState) {
        loseState = false;
        throw Error("无法刷新聊天状态");
      }
      const requested = new URL(route, "https://local.test").searchParams.get(
        "chatId",
      );
      const viewingNew = newChat && requested === newChat.id;
      return structuredClone({
        provider: {
          configured,
          model: "deepseek-flash",
          format: "deepseek",
          host: "api.deepseek.com",
        },
        threads: [newChat, selected].filter(Boolean),
        thread: viewingNew ? newChat : selected,
        messages: viewingNew ? [] : messages,
        job: viewingNew ? null : job,
        memories,
        memoryEpoch,
        hasMore: false,
        ...(project ? { project } : {}),
      });
    }
    if (route.endsWith("/new")) {
      newChat = { ...thread, id: "new-chat", title: "新聊天" };
      if (failNew) {
        failNew = false;
        throw Object.assign(Error("项目总结尚未连接"), { status: 409 });
      }
      if (project) project = { ...project, status: "queued", ready: false };
      return { thread: newChat };
    }
    if (route.startsWith("/api/agent/project/state"))
      return structuredClone(project);
    if (route.endsWith("/send")) {
      selected = thread;
      const message = {
        id: "user-1",
        bindingId: "bound",
        chatId: "chat",
        sequence: 1,
        role: "user",
        createdAt: thread.createdAt,
        text: options.body.text,
        tasks: [],
        memories: [],
      };
      messages = [message];
      job = { id: `job-${++submissions}`, status: sendStatus };
      if (sendStatus === "succeeded") messages.push(structuredClone(assistant));
      return { thread, message, job };
    }
    if (route.endsWith("/save-tasks")) {
      if (noSaveReceipt) {
        noSaveReceipt = false;
        throw Object.assign(
          Error(
            "来源已变化，尚未查到保存回执。可再次核对，旧提案不会重新写入。",
          ),
          { status: 409 },
        );
      }
      if (loseSave) {
        loseSave = false;
        throw Error("保存回执未收到");
      }
      messages = messages.map((m) =>
        m.id === assistant.id
          ? { ...m, taskProposal: { status: "saved", operationId: "op" } }
          : m,
      );
      return {
        saved: true,
        messageId: assistant.id,
        operationId: "op",
        taskIds: ["task-1"],
      };
    }
    if (route.endsWith("/remember")) {
      const memory = {
        id: "m1",
        bindingId: "bound",
        scope: "project",
        key: "文档语言",
        value: "简体中文",
        sourceMessageId: assistant.id,
        revision: 2,
        status: "active",
        updatedAt: thread.createdAt,
      };
      memories = [memory];
      memoryEpoch++;
      messages = messages.map((m) =>
        m.id === assistant.id ? { ...m, memoryStates: ["saved"] } : m,
      );
      return memory;
    }
    if (route.endsWith("/memory")) {
      const body = options.body;
      memoryEpoch++;
      if (body.action === "delete") {
        memories = memories.filter((memory) => memory.id !== body.id);
        messages = messages.map((m) =>
          m.id === assistant.id
            ? { ...m, invalidated: true, memoryStates: ["deleted"] }
            : m,
        );
        return { memories, memoryEpoch };
      }
      const memory = {
        id: body.id || "m1",
        bindingId: body.bindingId ?? null,
        scope: body.scope,
        key: body.key,
        value: body.value,
        sourceMessageId: null,
        revision: (body.expectedRevision || 0) + 1,
        status: "active",
        updatedAt: thread.createdAt,
      };
      memories = [memory];
      return { memory, memories, memoryEpoch };
    }
    throw Error(`unexpected ${route}`);
  };
  return {
    calls,
    requestCloud,
    setProject(value) {
      project = structuredClone(value);
    },
    failNewInitialization() {
      failNew = true;
    },
    complete() {
      job = { ...job, status: "succeeded" };
      messages.push(structuredClone(assistant));
    },
    loseSave() {
      loseSave = true;
    },
    waitForSaveReceipt() {
      noSaveReceipt = true;
    },
    loseState() {
      loseState = true;
    },
    makeJobStale() {
      job = { ...job, status: "stale" };
    },
    rebind() {
      bindingRevision++;
    },
    terminalSend(status) {
      sendStatus = status;
    },
    recoverProposal(tasks) {
      messages = messages.map((message) => ({
        ...message,
        invalidated: true,
        taskProposal: { status: "saving", tasks },
      }));
    },
    existingProjectMemory() {
      memories = [
        {
          id: "m1",
          bindingId: "bound",
          scope: "project",
          key: "文档语言",
          value: "中文",
          sourceMessageId: null,
          revision: 1,
          status: "active",
          updatedAt: thread.createdAt,
        },
      ];
    },
  };
}

async function mount(f, extra = {}) {
  assert.equal(
    typeof ChatPanel,
    "function",
    "step 6 has a dedicated chat panel",
  );
  const root = createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(
      React.createElement(ChatPanel, {
        roomId: "canvas",
        userId: "alice",
        pages: [{ id: "project", title: "我的项目" }],
        requestCloud: f.requestCloud,
        ...extra,
      }),
    ),
  );
  const close = () => act(async () => root.unmount());
  close.render = (next = {}) =>
    act(async () =>
      root.render(
        React.createElement(ChatPanel, {
          roomId: "canvas",
          userId: "alice",
          pages: [{ id: "project", title: "我的项目" }],
          requestCloud: f.requestCloud,
          ...extra,
          ...next,
        }),
      ),
    );
  return close;
}

test("embedded chat keeps its composer while memory drawer opens and removes trial navigation", async () => {
  window.sessionStorage.clear();
  const f = fixture({ existing: true });
  let closed = 0;
  const close = await mount(f, {
    embedded: true,
    onMemoryClose: () => closed++,
  });
  try {
    assert.equal(field("聊天项目"), null);
    assert.equal(document.querySelector('[aria-label="管理记忆"]'), null);
    await edit("聊天消息", "尚未发送的讨论");
    await close.render({ memoryOpen: true });
    assert.ok(document.querySelector('[role="dialog"][aria-label="记忆"]'));
    assert.equal(field("聊天消息").value, "尚未发送的讨论");
    await click("关闭记忆");
    assert.equal(closed, 1);
    await close.render({ memoryOpen: false });
    assert.equal(field("聊天消息").value, "尚未发送的讨论");
    assert.equal(f.calls.filter((c) => c.route.endsWith("/send")).length, 0);
    assert.doesNotMatch(document.body.textContent, /第 5 步|第 3 步/);
  } finally {
    await close();
  }
});

test("embedded proposal notifies adjacent checklist only after a confirmed save", async () => {
  window.sessionStorage.clear();
  const f = fixture({ existing: true }),
    saved = [];
  const close = await mount(f, {
    embedded: true,
    onTasksSaved: (receipt) => saved.push(receipt),
  });
  try {
    f.loseSave();
    await click("保存到真实清单");
    assert.equal(saved.length, 0);
    await click("保存到真实清单");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].messageId, assistant.id);
    assert.match(document.body.textContent, /已保存到真实清单/);
    assert.doesNotMatch(document.body.textContent, /第 5 步/);
  } finally {
    await close();
  }
});

test("embedded drafts are isolated by account, project and chat and never automatically sent", async () => {
  window.sessionStorage.clear();
  const f = fixture({ existing: true });
  const close = await mount(f, { embedded: true });
  try {
    await edit("聊天消息", "项目甲草稿");
    await close.render({ pages: [{ id: "second", title: "另一个项目" }] });
    assert.equal(field("聊天消息").value, "");
    await edit("聊天消息", "项目乙草稿");
    await close.render();
    assert.equal(field("聊天消息").value, "项目甲草稿");
    await close.render({ userId: "bob" });
    assert.equal(field("聊天消息").value, "");
    await close.render();
    assert.equal(field("聊天消息").value, "项目甲草稿");
    await click("新聊天");
    assert.equal(field("聊天消息").value, "");
    await edit("聊天消息", "新聊天草稿");
    await act(async () => {
      field("聊天历史").value = "chat";
      field("聊天历史").dispatchEvent(
        new window.Event("change", { bubbles: true }),
      );
    });
    assert.equal(field("聊天消息").value, "项目甲草稿");
    assert.equal(f.calls.filter((c) => c.route.endsWith("/send")).length, 0);
  } finally {
    await close();
  }
});

test("embedded project summary opens on demand without starting a native summary job", async () => {
  window.sessionStorage.clear();
  const f = fixture({ existing: true });
  f.setProject({
    status: "uninitialized",
    ready: false,
    summaryRevision: 0,
    summary: null,
  });
  const close = await mount(f, { embedded: true });
  try {
    assert.equal(document.querySelector('[aria-label="项目摘要"]'), null);
    await edit("聊天消息", "摘要准备前的草稿");
    await close.render({ summaryOpen: true });
    assert.ok(document.querySelector('[role="dialog"][aria-label="项目摘要"]'));
    assert.equal(field("聊天消息").value, "摘要准备前的草稿");
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
  } finally {
    await close();
  }
});

test("step 6 polls a queued chat and saves an edited proposal once using the same request ID on retry", async () => {
  const f = fixture(),
    close = await mount(f);
  try {
    await edit("聊天消息", "帮我检查文档");
    await click("发送");
    assert.match(document.body.textContent, /等待模型回复/);
    assert.equal(button("发送").disabled, true);
    f.complete();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 2150)));
    assert.match(document.body.textContent, /先整理项目的安装说明/);
    await edit("提案第 1 项执行要求", "检查 README 和 docs");
    f.loseSave();
    await click("保存到真实清单");
    assert.equal(field("提案第 1 项执行要求").value, "检查 README 和 docs");
    await click("保存到真实清单");
    assert.match(document.body.textContent, /已保存到真实清单/);
    const writes = f.calls.filter((call) => call.route.endsWith("/save-tasks"));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].body, writes[1].body);
    assert.deepEqual(writes[0].body.tasks, [
      {
        text: "整理安装说明",
        instruction: "检查 README 和 docs",
        acceptance: "有安装步骤",
      },
    ]);
    assert.equal(
      f.calls.filter((call) => call.route.endsWith("/send")).length,
      1,
    );
    assert.ok(f.calls.every((call) => call.accountId === "alice"));
  } finally {
    await close();
  }
});

test("a terminal send receipt immediately reads the assistant reply from state", async () => {
  const f = fixture();
  f.terminalSend("succeeded");
  const close = await mount(f);
  try {
    await edit("聊天消息", "读取已经完成的回复");
    await click("发送");
    assert.match(document.body.textContent, /先整理项目的安装说明/);
    const send = f.calls.findIndex((call) => call.route.endsWith("/send"));
    assert.equal(f.calls[send].body.bindingRevision, 2);
    assert.ok(
      f.calls
        .slice(send + 1)
        .some(
          (call) =>
            call.route.includes("/state") &&
            call.route.includes("bindingRevision=2"),
        ),
    );
  } finally {
    await close();
  }
});

test("an invalidated saving proposal checks for its original receipt without offering another write", async () => {
  const f = fixture({ existing: true });
  const tasks = [
    {
      text: "确认过的待办",
      instruction: "上次提交的编辑内容",
      acceptance: "按确认过的标准验收",
    },
  ];
  f.recoverProposal(tasks);
  const close = await mount(f);
  try {
    const requirement = field("提案第 1 项执行要求");
    assert.ok(requirement);
    assert.equal(requirement.value, tasks[0].instruction);
    assert.equal(requirement.readOnly, true);
    assert.match(
      document.body.textContent,
      /来源已变化，仅核对原保存结果，不会重新写入/,
    );
    assert.equal(button("核对并重试保存"), undefined);
    f.waitForSaveReceipt();
    await click("核对保存结果");
    assert.match(document.body.textContent, /尚未查到保存回执/);
    assert.equal(field("提案第 1 项执行要求").value, tasks[0].instruction);
    await click("核对保存结果");
    const writes = f.calls.filter((call) => call.route.endsWith("/save-tasks"));
    assert.equal(writes.length, 2);
    for (const write of writes) {
      assert.equal(write.body.bindingRevision, 2);
      assert.deepEqual(write.body.tasks, tasks);
    }
    assert.match(document.body.textContent, /已保存到真实清单/);
  } finally {
    await close();
  }
});

test("personal memory remains usable without a binding or a configured model", async () => {
  const f = fixture({ configured: false, bound: false }),
    close = await mount(f);
  try {
    assert.match(document.body.textContent, /服务端配置/);
    assert.equal(button("发送").disabled, true);
    await click("新增记忆");
    await edit("记忆名称", "回复语言");
    await edit("记忆内容", "中文");
    await click("保存记忆");
    assert.match(document.body.textContent, /手动添加/);
    await click("编辑记忆：回复语言");
    await edit("记忆内容", "简体中文");
    await click("保存记忆");
    const saves = f.calls.filter((call) => call.body?.action === "save");
    assert.equal(saves[0].body.scope, "personal");
    assert.equal("bindingId" in saves[0].body, false);
    assert.equal("bindingRevision" in saves[0].body, false);
    assert.equal(saves[1].body.expectedRevision, 1);
    assert.equal(saves[1].body.value, "简体中文");
    await click("删除记忆：回复语言");
    assert.equal(
      f.calls.find((call) => call.body?.action === "delete").body
        .expectedRevision,
      2,
    );
    assert.doesNotMatch(document.body.textContent, /回复语言/);
  } finally {
    await close();
  }
});

test("explicitly remembering uses the project revision and forgetting prevents using the old chat candidate", async () => {
  const f = fixture({ existing: true });
  f.existingProjectMemory();
  const close = await mount(f);
  try {
    assert.equal(
      f.calls.some((call) => call.route.endsWith("/remember")),
      false,
    );
    await click("记住：文档语言");
    const remember = f.calls.find((call) => call.route.endsWith("/remember"));
    assert.equal(remember.body.bindingId, "bound");
    assert.equal(remember.body.bindingRevision, 2);
    assert.equal(remember.body.expectedMemoryId, "m1");
    assert.equal(remember.body.expectedRevision, 1);
    await click("当前项目记忆");
    assert.match(document.body.textContent, /来自聊天建议/);
    await click("删除记忆：文档语言");
    assert.equal(
      f.calls.find((call) => call.body?.action === "delete").body
        .bindingRevision,
      2,
    );
    assert.match(document.body.textContent, /先整理项目的安装说明/);
    assert.match(document.body.textContent, /记忆已删除/);
    assert.equal(button("记住：文档语言").disabled, true);
    assert.equal(button("保存到真实清单").disabled, true);
  } finally {
    await close();
  }
});

test("forgetting disables cached candidates even if the refresh fails", async () => {
  const f = fixture({ existing: true });
  f.existingProjectMemory();
  const close = await mount(f);
  try {
    await click("当前项目记忆");
    f.loseState();
    await click("删除记忆：文档语言");
    assert.match(document.body.textContent, /无法刷新聊天状态/);
    assert.equal(button("记住：文档语言").disabled, true);
    assert.equal(button("保存到真实清单").disabled, true);
    await click("刷新聊天与记忆");
    assert.match(document.body.textContent, /记忆已删除/);
  } finally {
    await close();
  }
});

test("a stale model job restores the input and only an explicit resend submits a new job", async () => {
  const f = fixture(),
    close = await mount(f);
  try {
    await edit("聊天消息", "讨论项目要求");
    await click("发送");
    f.makeJobStale();
    await click("刷新聊天与记忆");
    assert.match(document.body.textContent, /记忆已更改，请重新发送/);
    assert.equal(field("聊天消息").value, "讨论项目要求");
    assert.equal(
      f.calls.filter((call) => call.route.endsWith("/send")).length,
      1,
    );
    await click("发送");
    const sends = f.calls.filter((call) => call.route.endsWith("/send"));
    assert.equal(sends.length, 2);
    assert.notEqual(sends[0].body.requestId, sends[1].body.requestId);
    assert.equal(sends[1].body.chatId, "chat");
  } finally {
    await close();
  }
});

test("a new chat keeps the prior project conversation selectable", async () => {
  const f = fixture({ existing: true }),
    close = await mount(f);
  try {
    await click("新聊天");
    assert.equal(
      f.calls.find((call) => call.route.endsWith("/new")).body.bindingRevision,
      2,
    );
    assert.equal(field("聊天历史").value, "new-chat");
    assert.doesNotMatch(document.body.textContent, /先整理项目的安装说明/);
    const picker = field("聊天历史");
    await act(async () => {
      picker.value = "chat";
      picker.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.match(document.body.textContent, /先整理项目的安装说明/);
    assert.ok(f.calls.some((call) => call.route.includes("chatId=chat")));
  } finally {
    await close();
  }
});

test("a changed binding revision clears the old draft before it can be sent", async () => {
  const f = fixture(),
    close = await mount(f);
  try {
    await edit("聊天消息", "旧项目要求");
    f.rebind();
    await click("发送");
    assert.equal(
      f.calls.some((call) => call.route.endsWith("/send")),
      false,
    );
    assert.equal(field("聊天消息").value, "");
  } finally {
    await close();
  }
});

test("project summary gates sending, preserves a composed draft, and new chat waits for its own summary", async () => {
  const f = fixture({ existing: true });
  const project = {
    bindingId: "bound",
    bindingRevision: 2,
    status: "queued",
    ready: false,
    stale: false,
    summaryRevision: 0,
    summary: null,
    activeRunId: "summary-run",
  };
  f.setProject(project);
  const close = await mount(f);
  try {
    assert.match(document.body.textContent, /等待项目空闲/);
    await edit("聊天消息", "保留这条准备发送的消息");
    assert.equal(button("发送").disabled, true);
    f.setProject({
      ...project,
      status: "ready",
      ready: true,
      summaryRevision: 1,
      summary: {
        overview: "已检查当前项目",
        completed: [],
        inProgress: [],
        pending: [],
        blockers: [],
        verification: [],
        uncertainties: [],
      },
    });
    await click("刷新总结状态");
    assert.equal(field("聊天消息").value, "保留这条准备发送的消息");
    assert.equal(button("发送").disabled, false);
    f.loseState();
    f.setProject({
      ...project,
      status: "ready",
      ready: true,
      summaryRevision: 2,
      sourceRunId: "refreshed-summary",
      summary: {
        overview: "新的项目摘要",
        completed: [],
        inProgress: [],
        pending: [],
        blockers: [],
        verification: [],
        uncertainties: [],
      },
    });
    await click("刷新总结状态");
    assert.equal(
      button("保存到真实清单").disabled,
      true,
      "changed summary must recheck prior proposals before adoption",
    );
    assert.match(document.body.textContent, /无法刷新聊天状态/);
    await click("刷新聊天与记忆");
    await click("新聊天");
    await edit("聊天消息", "新聊天的草稿");
    assert.equal(button("发送").disabled, true);
    assert.equal(f.calls.filter((c) => c.route.endsWith("/new")).length, 1);
    assert.equal(f.calls.filter((c) => c.route.endsWith("/send")).length, 0);
  } finally {
    await close();
  }
});

test("retrying a newly persisted chat with failed initialization reuses its request", async () => {
  const f = fixture({ existing: true });
  f.failNewInitialization();
  const close = await mount(f);
  try {
    await click("新聊天");
    assert.match(document.body.textContent, /项目总结尚未连接/);
    await click("新聊天");
    const writes = f.calls.filter((c) => c.route.endsWith("/new"));
    assert.equal(writes.length, 2);
    assert.equal(writes[0].body.requestId, writes[1].body.requestId);
  } finally {
    await close();
  }
});
test("opening chat with an uninitialized summary waits for the start button", async () => {
  const f = fixture();
  f.setProject({
    status: "uninitialized",
    ready: false,
    bindingId: "bound",
    bindingRevision: 2,
    summaryRevision: 0,
    summary: null,
  });
  const close = await mount(f);
  try {
    assert.ok(button("开始总结"));
    assert.equal(
      f.calls.some((c) => c.route.endsWith("/initialize")),
      false,
    );
    assert.equal(button("发送").disabled, true);
  } finally {
    await close();
  }
});
