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
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/agent-ui-"));
await build({
  entryPoints: [resolve("src/agent/AgentExperience.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
});
const { RuleTrial, CodexTrial } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
const button = (name) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === name,
  );
const click = async (node) => {
  assert.ok(node);
  await act(async () => node.click());
};
const input = async (label, value) => {
  const el = document.querySelector(`[aria-label="${label}"]`);
  assert.ok(el, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      "value",
    ).set.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};
async function mount(Component, props = {}) {
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(Component, props)));
  return () => act(async () => root.unmount());
}

test("rules can be edited, sorted, and a dependency cycle is explained with task names", async () => {
  localStorage.clear();
  const unmount = await mount(RuleTrial, {
    storageKey: "rule-test",
    pages: [],
  });
  try {
    await click(button("载入示例"));
    await click(button("校验并排序"));
    assert.match(document.body.textContent, /校验通过/);
    assert.deepEqual(
      [...document.querySelectorAll(".agent-order li")].map(
        (el) => el.textContent,
      ),
      ["任务 A：准备数据", "任务 B：生成报告"],
    );
    await click(
      document.querySelector('[aria-label="任务 1 依赖 任务 B：生成报告"]'),
    );
    await click(button("校验并排序"));
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /互相等待.*任务 A.*任务 B/s,
    );
    assert.equal(document.querySelector(".agent-order"), null);
    await click(
      document.querySelector('[aria-label="任务 1 依赖 任务 B：生成报告"]'),
    );
    await input("完成条件 1", "");
    await click(button("校验并排序"));
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /任务 1.*完成条件/s,
    );
  } finally {
    await unmount();
  }
});

test("rule drafts persist in their own scope and import actual unfinished list text without inventing requirements", async () => {
  localStorage.clear();
  const pages = [
    {
      id: "page",
      title: "项目",
      tasks: [
        {
          key: "todo-1",
          note: { id: "note" },
          block: {
            done: false,
            runs: [{ type: "text", text: "真实清单任务" }],
          },
        },
        {
          key: "todo-2",
          note: { id: "note" },
          block: { done: true, runs: [{ type: "text", text: "已完成事项" }] },
        },
      ],
    },
  ];
  let unmount = await mount(RuleTrial, { storageKey: "scope-1", pages });
  await click(button("从清单复制未完成项"));
  assert.equal(
    document.querySelector('[aria-label="任务名称 1"]').value,
    "真实清单任务",
  );
  assert.equal(document.querySelector('[aria-label="执行要求 1"]').value, "");
  await input("执行要求 1", "我的执行要求");
  await unmount();
  unmount = await mount(RuleTrial, { storageKey: "scope-1", pages });
  assert.equal(
    document.querySelector('[aria-label="执行要求 1"]').value,
    "我的执行要求",
  );
  await unmount();
  unmount = await mount(RuleTrial, { storageKey: "scope-2", pages });
  assert.equal(document.querySelector('[aria-label="任务名称 1"]'), null);
  await unmount();
});

test("Codex UI reports missing local service and never shows invented connection success", async () => {
  const unmount = await mount(CodexTrial, {
    request: async () => {
      throw Error("尚未连接本机服务");
    },
  });
  try {
    await click(button("检查连接"));
    assert.match(document.body.textContent, /npm run dev:agent/);
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /尚未连接/,
    );
    assert.equal(button("运行三会话测试").disabled, true);
  } finally {
    await unmount();
  }
});

test("Codex UI starts once and displays verified outputs returned by the local service", async () => {
  let launches = 0;
  const verified = {
    id: "test",
    status: "passed",
    workspace: "D:/test",
    progress: [],
    report: {
      passed: true,
      runs: [
        {
          key: "summary",
          threadId: "summary-id",
          result: { overview: "项目真实总结" },
        },
        {
          key: "a",
          threadId: "a-id",
          result: { summary: "已生成 A" },
          artifactVerified: true,
        },
        {
          key: "b",
          threadId: "b-id",
          result: { summary: "已读取 A 并生成 B" },
          artifactVerified: true,
        },
      ],
    },
  };
  const request = async (route, options) => {
    if (route === "/connection")
      return {
        authenticated: true,
        version: "0.166.0-alpha.6",
        projects: [{ workspaceId: "project", root: "D:/project", threads: [] }],
      };
    if (route === "/tests" && options?.method === "POST") {
      launches++;
      return verified;
    }
    return { current: launches ? verified : null };
  };
  const unmount = await mount(CodexTrial, { request });
  try {
    await click(button("检查连接"));
    assert.match(document.body.textContent, /已登录/);
    await click(button("运行三会话测试"));
    assert.equal(launches, 1);
    assert.match(document.body.textContent, /3 个独立会话验证通过/);
    assert.match(document.body.textContent, /项目真实总结/);
    assert.match(document.body.textContent, /已读取 A 并生成 B/);
  } finally {
    await unmount();
  }
});

test("refreshing connection invalidates a pending history request and clears its loading indicator", async () => {
  let completeHistory;
  const request = async (route) => {
    if (route === "/connection")
      return {
        authenticated: true,
        projects: [
          {
            workspaceId: "project",
            root: "D:/project",
            threads: [{ threadId: "thread", title: "读取这条会话" }],
          },
        ],
      };
    if (route.startsWith("/thread?"))
      return new Promise((resolve) => {
        completeHistory = resolve;
      });
    return { current: null };
  };
  const unmount = await mount(CodexTrial, { request });
  try {
    await click(button("检查连接"));
    await click([...document.querySelectorAll(".agent-thread-list button")][0]);
    assert.match(document.body.textContent, /正在读取会话/);
    await click(button("检查连接"));
    assert.doesNotMatch(document.body.textContent, /正在读取会话/);
    await act(async () => completeHistory({ title: "旧响应", messages: [] }));
    assert.doesNotMatch(document.body.textContent, /旧响应/);
  } finally {
    await unmount();
  }
});

test("a delayed pre-launch status response cannot erase an accepted running test", async () => {
  let finishStatus;
  let calls = 0;
  const request = async (route) => {
    if (route === "/connection") return { authenticated: true, projects: [] };
    if (route === "/tests") {
      calls++;
      return {
        id: "accepted",
        status: "running",
        workspace: "D:/test",
        progress: [],
      };
    }
    return new Promise((resolve) => {
      finishStatus = resolve;
    });
  };
  const unmount = await mount(CodexTrial, { request });
  try {
    await click(button("检查连接"));
    await click(button("运行三会话测试"));
    assert.equal(calls, 1);
    await act(async () => finishStatus({ current: null }));
    assert.match(document.body.textContent, /测试运行中/);
    assert.equal(button("运行三会话测试").disabled, true);
  } finally {
    await unmount();
  }
});
