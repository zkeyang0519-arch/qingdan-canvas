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
    (b) => b.textContent.trim() === text,
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
      window.HTMLTextAreaElement.prototype,
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
test("panel submits through MCP, follows up in the same turn and shows requested stop honestly", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    await edit("执行要求", "在项目里创建 hello.txt");
    await edit("完成标准", "文件包含 hello");
    await click("提交任务");
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
    await click("提交任务");
    assert.match(document.body.textContent, /回执暂未收到/);
    await click("提交任务");
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
    await click("提交任务");
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
test("stale intent target is rejected before MCP create", async () => {
  const f = fixture(),
    unmount = await mount(f);
  try {
    f.rebindBeforeIntent();
    await edit("执行要求", "写入文件");
    await edit("完成标准", "文件存在");
    await click("提交任务");
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
    let creates = f.calls.filter(
      (c) => c.options.body?.name === "codex_create_run",
    );
    assert.deepEqual(creates[0].options.body, creates[1].options.body);
    await edit("执行要求", "  写入文件  ");
    await edit("完成标准", "文件存在");
    f.loseReceipt();
    await click("提交任务");
    await edit("执行要求", "写入文件");
    await click("提交任务");
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
    await click("提交任务");
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
    await click("提交任务");
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
    assert.equal(button("提交任务").disabled, true);
    assert.equal(
      document.querySelector('[aria-label="清单关联"]').value,
      "agent-execution-trial",
    );
  } finally {
    await unmount();
  }
});
