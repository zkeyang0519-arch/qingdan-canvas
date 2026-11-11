import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const dom = new JSDOM('<div id="root"></div>', {
  url: "http://127.0.0.1:8790",
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
const dir = mkdtempSync(resolve("node_modules/.cache/agent-execution-ui-"));
await build({
  entryPoints: [resolve("src/agent/ExecutionPanel.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile: resolve(dir, "ui.mjs"),
});
const { default: ExecutionPanel } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
const button = (text) =>
  [...document.querySelectorAll("button")].find(
    (b) =>
      b.textContent.trim() === text || b.getAttribute("aria-label") === text,
  );
const click = async (text) => {
  const b = button(text);
  assert.ok(b, text);
  assert.equal(b.disabled, false, text);
  await act(async () => b.click());
};
const edit = async (label, value) => {
  const el = document.querySelector(`[aria-label="${label}"]`);
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
};
function fixture() {
  const calls = [];
  let run = null,
    lost = false,
    intentRevision = 1,
    followConflict = false,
    followLost = false,
    cancelImmediately = false;
  const binding = {
    bindingId: "binding",
    runnerId: "runner",
    workspaceId: "workspace",
    revision: 1,
    enabled: true,
  };
  const local = {
    runnerId: "runner",
    paired: true,
    connectionStatus: "online",
  };
  const requestLocal = async (route, options) => {
    calls.push({ route, options });
    if (route === "/execution/trial")
      return {
        runnerId: "runner",
        workspace: { workspaceId: "trial", name: "MCP 派单测试项目" },
      };
    return local;
  };
  const requestCloud = async (route, options = {}) => {
    calls.push({ route, options });
    if (route === "/api/agent/devices")
      return {
        enabled: true,
        devices: [
          {
            runnerId: "runner",
            deviceName: "电脑",
            status: "online",
            workspaces: [
              {
                workspaceId: "workspace",
                name: "项目",
                displayPath: "D:/project",
              },
            ],
          },
        ],
      };
    if (route.startsWith("/api/agent/bindings"))
      return {
        binding: route.includes("sectionId=agent-execution-trial")
          ? null
          : binding,
      };
    if (route.startsWith("/api/agent/execution/runs"))
      return { runs: run ? [run] : [] };
    if (route.endsWith("/intents"))
      return {
        input: {
          requestId: options.body.requestId,
          runId: "run",
          bindingId: "binding",
          bindingRevision: intentRevision,
          snapshotId: "snapshot",
          payloadHash: "hash",
          kind: options.body.kind,
        },
      };
    if (route.endsWith("/tools")) {
      const { name, arguments: input } = options.body;
      if (name === "codex_list_projects") return { result: { projects: [] } };
      if (name === "codex_create_run") {
        run ||= {
          runId: "run",
          kind: "task",
          status: "running",
          threadId: "chat-1",
          turnId: "turn-1",
          terminal: false,
          stopConfirmed: false,
        };
        if (lost) {
          lost = false;
          throw Error("回执暂未收到，请重试");
        }
      }
      if (name === "codex_continue_run") {
        if (followConflict) {
          followConflict = false;
          run = {
            ...run,
            turnId: "turn-2",
            terminal: true,
            stopConfirmed: true,
            status: "verifying",
          };
          throw Object.assign(Error("轮次已更改。"), { status: 409 });
        }
        assert.equal(input.expectedTurnId, run.turnId);
        assert.equal(input.mode, run.terminal ? "reply" : "steer");
        if (followLost) {
          followLost = false;
          throw Error("补充回执未收到");
        }
      }
      if (name === "codex_cancel_run")
        run = {
          ...run,
          status: cancelImmediately ? "cancelled" : "cancel_requested",
          terminal: cancelImmediately,
          stopConfirmed: cancelImmediately,
        };
      if (name === "codex_get_run")
        return {
          result: {
            run,
            events: input.afterSeq
              ? []
              : [
                  {
                    eventId: "e1",
                    seq: 1,
                    type: "output.delta",
                    payload: { text: "收到执行要求" },
                  },
                ],
            nextAfterSeq: 1,
            hasMore: false,
            truncated: false,
          },
        };
      return {
        result: { runId: "run", commandId: "command", status: "accepted" },
        transport: "streamable-http",
      };
    }
    throw Error("Unexpected " + route);
  };
  return {
    calls,
    requestCloud,
    requestLocal,
    loseReceipt() {
      lost = true;
    },
    rebindBeforeIntent() {
      intentRevision = 2;
    },
    conflictFollow() {
      followConflict = true;
    },
    loseFollowReceipt() {
      followLost = true;
    },
    immediateCancel() {
      cancelImmediately = true;
    },
    complete() {
      run = {
        ...run,
        status: "verifying",
        terminal: true,
        stopConfirmed: true,
      };
    },
    setRun(value) {
      run = value;
    },
  };
}
async function mount(f) {
  const root = createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(
      React.createElement(ExecutionPanel, {
        roomId: "canvas",
        userId: "alice",
        pages: [{ id: "section", title: "当前清单" }],
        ...f,
      }),
    ),
  );
  const unmount = () => act(async () => root.unmount());
  unmount.pages = (pages) =>
    act(async () =>
      root.render(
        React.createElement(ExecutionPanel, {
          roomId: "canvas",
          userId: "alice",
          pages,
          ...f,
        }),
      ),
    );
  return unmount;
}
test("named project creation sends the name and retains distinct project bindings after reopening", async () => {
  const base = fixture(),
    projects = [],
    bindings = new Map();
  const requests = [];
  let unavailable = false;
  const local = {
    paired: true,
    runnerId: "runner",
    connectionStatus: "online",
  };
  const f = {
    ...base,
    requestLocal: async (route, options) => {
      requests.push({ route, options });
      if (unavailable && route === "/status") throw Error("本机暂时离线");
      if (route === "/execution/trial") {
        const name = options.body.projectName;
        let project = projects.find((p) => p.name === name);
        if (!project) {
          project = {
            name,
            workspaceId: `named-${projects.length + 1}`,
            displayPath: `D:/trials/${name}`,
          };
          project.sectionId = `agent-execution-project-${project.workspaceId}`;
          projects.push(project);
        }
        return {
          runnerId: "runner",
          workspace: project,
          sectionId: project.sectionId,
        };
      }
      return { ...local, executionProjects: projects.map((p) => ({ ...p })) };
    },
    requestCloud: async (route, options = {}) => {
      requests.push({ route, options });
      if (route === "/api/agent/bindings" && options.method === "POST") {
        const body = options.body;
        const binding = {
          ...body,
          bindingId: `binding-${body.workspaceId}`,
          revision: 1,
          enabled: true,
        };
        bindings.set(body.sectionId, binding);
        return { binding };
      }
      if (route.startsWith("/api/agent/bindings?")) {
        const section = new URL(route, "https://local.test").searchParams.get(
          "sectionId",
        );
        if (section.startsWith("agent-execution-project-"))
          return { binding: bindings.get(section) || null };
      }
      const response = await base.requestCloud(route, options);
      if (route === "/api/agent/devices")
        response.devices[0].workspaces.push(...projects);
      return response;
    },
  };
  let unmount = await mount(f);
  try {
    await edit("项目名称", "个人网站");
    await click("创建项目");
    assert.deepEqual(
      requests.find((r) => r.route === "/execution/trial").options.body,
      { projectName: "个人网站" },
    );
    assert.equal(
      document.querySelector('[aria-label="清单关联"]').value,
      "agent-execution-project-named-1",
    );
    await edit("项目名称", "个人笔记");
    await click("创建项目");
    assert.equal(bindings.size, 2);
    assert.equal(
      bindings.get("agent-execution-project-named-1").workspaceId,
      "named-1",
    );
    assert.equal(
      bindings.get("agent-execution-project-named-2").workspaceId,
      "named-2",
    );
    assert.ok(
      !requests
        .filter(
          (r) =>
            r.route === "/api/agent/bindings" && r.options.method === "POST",
        )
        .some((r) => r.options.body.sectionId === "agent-execution-trial"),
    );
    await unmount();
    unmount = await mount(f);
    const select = document.querySelector('[aria-label="清单关联"]');
    for (const name of ["个人网站", "个人笔记", "独立测试项目"])
      assert.ok(
        [...select.options].some((o) => o.textContent === name),
        name,
      );
    await act(async () => {
      select.value = "agent-execution-project-named-1";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.match(document.body.textContent, /个人网站/);
    assert.equal(select.value, "agent-execution-project-named-1");
    unavailable = true;
    await click("刷新状态");
    assert.equal(
      document.querySelector('[aria-label="清单关联"]').value,
      "agent-execution-project-named-1",
      "temporary local failure must not discard the selected cloud binding",
    );
    assert.ok(requests.every((r) => r.options.accountId === "alice"));
  } finally {
    await unmount();
  }
});

test("named project result cannot redirect creation to an existing checklist binding", async () => {
  const f = fixture();
  const requestLocal = f.requestLocal;
  f.requestLocal = (route, options) =>
    route === "/execution/trial"
      ? Promise.resolve({
          runnerId: "runner",
          workspace: { workspaceId: "different-workspace", name: "个人网站" },
          sectionId: "section",
        })
      : requestLocal(route, options);
  const unmount = await mount(f);
  try {
    await edit("项目名称", "个人网站");
    await click("创建项目");
    assert.ok(
      !f.calls.some(
        (c) => c.route === "/api/agent/bindings" && c.options.method === "POST",
      ),
    );
    assert.match(document.body.textContent, /项目创建结果/);
  } finally {
    await unmount();
  }
});

test("batch draft requires all fields and submits reordered items once through MCP", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    await edit("执行要求", "  写说明  ");
    await edit("完成标准", "包含使用步骤");
    await click("添加待办");
    await edit("第 2 项执行要求", "创建示例");
    assert.equal(button("提交批次").disabled, true);
    await edit("第 2 项完成标准", "示例可运行");
    await click("添加待办");
    await click("下移第 1 项");
    await click("上移第 3 项");
    await click("删除第 2 项");
    await click("提交批次");
    const intents = f.calls.filter((c) => c.route.endsWith("/intents"));
    assert.equal(intents.length, 1);
    const { requestId, ...body } = intents[0].options.body;
    assert.ok(requestId);
    assert.deepEqual(body, {
      bindingId: "binding",
      bindingRevision: 1,
      kind: "task",
      items: [
        { instruction: "创建示例", acceptance: "示例可运行" },
        { instruction: "写说明", acceptance: "包含使用步骤" },
      ],
    });
    assert.equal(
      f.calls.filter((c) => c.options.body?.name === "codex_create_run").length,
      1,
    );
  } finally {
    await unmount();
  }
});

test("batch progress displays its paused item and uses one conversation for continuation", async () => {
  const f = fixture();
  const batchRun = {
    runId: "run",
    kind: "task",
    status: "verifying",
    threadId: "chat-1",
    turnId: "turn-2",
    terminal: true,
    stopConfirmed: true,
    batch: {
      currentIndex: 1,
      items: [
        {
          taskId: "task-a",
          text: "创建示例",
          status: "done",
          summary: "示例已生成",
        },
        {
          taskId: "task-b",
          text: "写说明",
          status: "blocked",
          summary: "等待环境说明",
        },
        {
          taskId: "task-c",
          text: "核对输出",
          status: "pending",
          summary: "",
        },
      ],
    },
  };
  f.setRun(batchRun);
  const unmount = await mount(f);
  try {
    const progress = document.querySelector('[aria-label="批次进度"]');
    assert.ok(progress, "batch progress is visible");
    assert.match(progress.textContent, /第 2 项.*共 3 项/);
    const rows = [...progress.querySelectorAll("li")].map(
      (li) => li.textContent,
    );
    assert.match(rows[0], /创建示例.*执行完毕.*示例已生成/);
    assert.match(rows[1], /写说明.*暂停.*等待环境说明/);
    assert.match(rows[2], /核对输出.*待执行/);
    assert.equal(
      document.querySelectorAll('a[href="codex://threads/chat-1"]').length,
      1,
    );
    assert.match(document.body.textContent, /补充后重做当前项/);
    await edit("补充说明", "使用本地环境");
    await click("发送补充说明");
    const follow = f.calls.findLast(
      (c) => c.options.body?.name === "codex_continue_run",
    );
    assert.equal(follow.options.body.arguments.mode, "reply");
    assert.equal(follow.options.body.arguments.expectedTurnId, "turn-2");

    f.setRun({
      ...batchRun,
      status: "failed",
      batch: {
        ...batchRun.batch,
        items: batchRun.batch.items.map((item) =>
          item.taskId === "task-b" ? { ...item, status: "failed" } : item,
        ),
      },
    });
    await click("刷新状态");
    assert.match(document.body.textContent, /批次已暂停，等待补充说明/);
    assert.match(document.body.textContent, /补充后重做当前项/);

    f.setRun({
      ...batchRun,
      status: "succeeded",
      batch: {
        currentIndex: 2,
        items: batchRun.batch.items.map((item) => ({
          ...item,
          status: "done",
        })),
      },
    });
    await click("刷新状态");
    assert.match(document.body.textContent, /批次执行完毕，待你验收/);
    assert.equal(
      document.querySelector('[aria-label="补充说明"]').disabled,
      true,
    );
    assert.match(document.body.textContent, /新的工作可提交新批次/);
  } finally {
    await unmount();
  }
});

test("confirmed batch stop overrides older progress without discarding completed items", async () => {
  const f = fixture();
  const stoppedRun = {
    runId: "run",
    kind: "task",
    status: "cancelled",
    threadId: "chat-1",
    turnId: "turn-2",
    terminal: true,
    stopConfirmed: true,
  };
  const runWithProgress = (...statuses) => ({
    ...stoppedRun,
    batch: {
      currentIndex: statuses.length - 1,
      items: statuses.map((status, index) => ({
        taskId: `task-${index}`,
        text: `执行待办 ${index + 1}`,
        status,
        summary: status === "done" ? "完成记录" : "",
      })),
    },
  });
  f.setRun(runWithProgress("done", "done"));
  const unmount = await mount(f);
  try {
    assert.match(document.body.textContent, /批次已停止/);
    assert.doesNotMatch(document.body.textContent, /批次执行完毕，待你验收/);
    for (const statuses of [
      ["done", "blocked"],
      ["pending", "pending"],
    ]) {
      f.setRun(runWithProgress(...statuses));
      await click("刷新状态");
      const progress = document.querySelector('[aria-label="批次进度"]');
      assert.match(document.body.textContent, /批次已停止/);
      assert.doesNotMatch(document.body.textContent, /批次已暂停/);
      assert.doesNotMatch(progress.textContent, /当前第|待执行/);
      assert.equal(progress.querySelector('[aria-current="step"]'), null);
      const rows = [...progress.querySelectorAll("li")];
      if (statuses[0] === "done") {
        assert.match(rows[0].textContent, /执行完毕.*完成记录/);
      } else {
        assert.match(rows[0].textContent, /已停止/);
      }
      assert.match(rows[1].textContent, /已停止/);
    }
  } finally {
    await unmount();
  }
});

test("panel submits through MCP, follows up in the same turn and shows requested stop honestly", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    await edit("执行要求", "在项目里创建 hello.txt");
    await edit("完成标准", "文件包含 hello");
    await click("提交批次");
    assert.match(document.body.textContent, /收到执行要求/);
    assert.match(document.body.textContent, /chat-1/);
    await edit("补充说明", "补上一行 world");
    await click("发送补充说明");
    await click("请求停止");
    assert.match(document.body.textContent, /正在请求停止/);
    assert.doesNotMatch(document.body.textContent, /已确认停止/);
    const tools = f.calls.filter((c) => c.route.endsWith("/tools"));
    assert.ok(tools.some((c) => c.options.body.name === "codex_create_run"));
    assert.ok(tools.some((c) => c.options.body.name === "codex_continue_run"));
    assert.ok(tools.some((c) => c.options.body.name === "codex_cancel_run"));
    assert.ok(f.calls.every((c) => c.options.accountId === "alice"));
  } finally {
    await unmount();
  }
});
test("lost dispatch receipt retries the same authorized intent and request ID", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    await edit("执行要求", "创建 hello.txt");
    await edit("完成标准", "检查 hello.txt");
    f.loseReceipt();
    await click("提交批次");
    assert.match(document.body.textContent, /回执暂未收到/);
    await click("提交批次");
    const creates = f.calls.filter(
      (c) => c.options.body?.name === "codex_create_run",
    );
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[0].options.body, creates[1].options.body);
  } finally {
    await unmount();
  }
});
test("completed turn can be continued and stays attached to its original chat", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    await edit("执行要求", "创建 hello.txt");
    await edit("完成标准", "检查文件");
    await click("提交批次");
    f.complete();
    await click("刷新状态");
    assert.match(document.body.textContent, /本轮结束，待你验收/);
    await edit("补充说明", "增加一行 world");
    await click("发送补充说明");
    const follow = f.calls.findLast(
      (c) => c.options.body?.name === "codex_continue_run",
    );
    assert.equal(follow.options.body.arguments.mode, "reply");
    assert.equal(follow.options.body.arguments.runId, "run");
    assert.match(document.body.textContent, /chat-1/);
  } finally {
    await unmount();
  }
});

for (const recoveryOnly of [true, false])
  test(`terminal summary followup is ${recoveryOnly ? "blocked in recovery view" : "available in ordinary view"}`, async () => {
    const f = fixture();
    f.setRun({
      runId: "historical-summary",
      kind: "summary",
      status: "verifying",
      threadId: "summary-thread",
      turnId: "summary-turn",
      terminal: true,
      stopConfirmed: true,
    });
    const unmount = await mount({
      ...f,
      recoveryOnly,
      initialPageId: "section",
      initialRunId: "historical-summary",
    });
    try {
      await edit("补充说明", "继续原总结");
      // Click the actual rendered control: recovery mode must produce no command.
      await act(async () => button("发送补充说明").click());
      const followups = f.calls.filter(
        (call) => call.options?.body?.name === "codex_continue_run",
      );
      assert.equal(followups.length, recoveryOnly ? 0 : 1);
      assert.equal(
        document.querySelector('[aria-label="补充说明"]').disabled,
        recoveryOnly,
      );
      if (recoveryOnly) assert.equal(button("发送补充说明").disabled, true);
      else {
        assert.equal(followups[0].options.body.arguments.mode, "reply");
        assert.equal(
          followups[0].options.body.arguments.runId,
          "historical-summary",
        );
      }
    } finally {
      await unmount();
    }
  });
test("stale intent target is rejected before MCP create", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    f.rebindBeforeIntent();
    await edit("执行要求", "写入文件");
    await edit("完成标准", "文件存在");
    await click("提交批次");
    assert.match(document.body.textContent, /关联已变化/);
    assert.equal(
      f.calls.some((c) => c.options.body?.name === "codex_create_run"),
      false,
    );
    assert.equal(
      f.calls.find((c) => c.route.endsWith("/intents")).options.body
        .bindingRevision,
      1,
    );
  } finally {
    await unmount();
  }
});
test("summary retries ignore task-only drafts and task retries normalize whitespace", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    f.loseReceipt();
    await click("只总结项目");
    await edit("执行要求", "不相关的草稿");
    await click("只总结项目");
    const summary = f.calls.find((c) => c.route.endsWith("/intents"));
    const { requestId, ...summaryBody } = summary.options.body;
    assert.ok(requestId);
    assert.deepEqual(summaryBody, {
      bindingId: "binding",
      bindingRevision: 1,
      kind: "summary",
    });
    let creates = f.calls.filter(
      (c) => c.options.body?.name === "codex_create_run",
    );
    assert.deepEqual(creates[0].options.body, creates[1].options.body);
    await edit("执行要求", "  写入文件  ");
    await edit("完成标准", "文件存在");
    f.loseReceipt();
    await click("提交批次");
    await edit("执行要求", "写入文件");
    await click("提交批次");
    creates = f.calls.filter(
      (c) => c.options.body?.name === "codex_create_run",
    );
    assert.deepEqual(creates[2].options.body, creates[3].options.body);
  } finally {
    await unmount();
  }
});
test("a definitive turn conflict refreshes the turn while an uncertain reply reuses its ID", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    await edit("执行要求", "写入文件");
    await edit("完成标准", "文件存在");
    await click("提交批次");
    await edit("补充说明", "补上一行");
    f.conflictFollow();
    await click("发送补充说明");
    await click("发送补充说明");
    let follow = f.calls.filter(
      (c) => c.options.body?.name === "codex_continue_run",
    );
    assert.equal(follow[1].options.body.arguments.expectedTurnId, "turn-2");
    assert.notEqual(
      follow[0].options.body.arguments.requestId,
      follow[1].options.body.arguments.requestId,
    );
    await edit("补充说明", "再补一行");
    f.loseFollowReceipt();
    await click("发送补充说明");
    await click("发送补充说明");
    follow = f.calls.filter(
      (c) => c.options.body?.name === "codex_continue_run",
    );
    assert.deepEqual(follow[2].options.body, follow[3].options.body);
  } finally {
    await unmount();
  }
});
test("confirmed cancellation does not retain a waiting-for-confirmation banner", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    await edit("执行要求", "写入文件");
    await edit("完成标准", "文件存在");
    await click("提交批次");
    f.immediateCancel();
    await click("请求停止");
    assert.match(document.body.textContent, /已确认停止/);
    assert.doesNotMatch(document.body.textContent, /等待本机确认/);
  } finally {
    await unmount();
  }
});
test("removing the visible checklist invalidates its old binding before any new dispatch", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    await edit("执行要求", "写入文件");
    await edit("完成标准", "文件存在");
    await unmount.pages([]);
    assert.equal(button("提交批次").disabled, true);
    assert.equal(
      document.querySelector('[aria-label="清单关联"]').value,
      "agent-execution-trial",
    );
  } finally {
    await unmount();
  }
});
