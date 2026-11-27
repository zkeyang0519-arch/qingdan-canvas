import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("聊天忙碌时问题仍可填写和选择，发送等收尾后进行，重开保留草稿和原问题标识", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
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
  const rootPath = path.resolve(".tmp");
  await mkdir(rootPath, { recursive: true });
  const dir = await mkdtemp(path.join(rootPath, "task-ui-"));
  const file = path.join(dir, "ui.mjs");
  await build({
    entryPoints: ["src/agent/TaskProgress.jsx"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    loader: { ".css": "empty" },
    outfile: file,
    logLevel: "silent",
  });
  const { default: TaskProgress } = await import(pathToFileURL(file));
  const container = document.getElementById("root");
  let root = createRoot(container);
  t.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    assert.equal(path.dirname(dir), rootPath);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const task = {
    id: "task-a",
    goal: "写旁白",
    status: "waiting_user",
    progress: "等待语气选择",
    steps: [],
    questions: [
      {
        id: "question-a",
        question: "用哪种语气？",
        reason: "影响措辞",
        kind: "information",
        options: ["温暖", "克制"],
      },
    ],
  };
  const calls = [];
  let busy = true;
  let allowQueueReply = false;
  const render = () =>
    root.render(
      React.createElement(TaskProgress, {
        task,
        busy,
        allowQueueReply,
        onReply: async (...args) => {
          calls.push(args);
          return true;
        },
      }),
    );
  await act(render);
  const button = (text) =>
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    );
  assert.equal(button("回答并继续").disabled, true);
  assert.equal(calls.length, 0);
  assert.equal(container.querySelector("textarea").disabled, false);
  assert.equal(button("温暖").disabled, false);
  assert.match(container.textContent, /可以先选择或填写回答/);
  await act(() => button("温暖").click());
  assert.equal(calls.length, 0);
  assert.equal(button("回答并继续").disabled, true);
  await act(() => root.unmount());
  root = createRoot(container);
  await act(render);
  assert.equal(container.querySelector("textarea").value, "温暖");
  busy = false;
  await act(render);
  assert.equal(button("回答并继续").disabled, false);
  await act(async () => button("回答并继续").click());
  assert.deepEqual(calls, [
    ["温暖", { taskId: "task-a", questionId: "question-a" }],
  ]);
  assert.equal(button("停止任务推进"), undefined);
  busy = true;
  allowQueueReply = true;
  await act(render);
  await act(() => button("克制").click());
  assert.equal(button("回答并继续").disabled, false);
  await act(async () => button("回答并继续").click());
  assert.equal(calls.length, 2, "独立回答通道不等待全局聊天忙碌结束");
  task.questions[0].pendingAnswer = { text: "克制" };
  await act(render);
  assert.equal(button("已收到，正在接续").disabled, true);
  assert.equal(container.querySelector("textarea").value, "克制");
});

test("任务卡按子任务列出，运行操作实时更新，完成、等待和失败后保留", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
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
  const base = path.resolve(".tmp");
  const dir = await mkdtemp(path.join(base, "task-stream-ui-"));
  const file = path.join(dir, "ui.mjs");
  await build({
    entryPoints: ["src/agent/TaskProgress.jsx"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    loader: { ".css": "empty" },
    outfile: file,
    logLevel: "silent",
  });
  const { default: TaskProgress } = await import(pathToFileURL(file));
  const container = document.getElementById("root");
  const root = createRoot(container);
  t.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    assert.equal(path.dirname(dir), base);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const task = {
    id: "t",
    status: "running",
    goal: "生成一张雨天图片",
    questions: [],
    steps: [],
    activities: [
      {
        id: "draft",
        kind: "tool",
        title: "生成雨天提示词",
        status: "done",
        text: "已收到采用稿",
      },
      {
        id: "canvas",
        kind: "tool",
        title: "创建图片节点",
        status: "done",
        text: "新节点已保存",
      },
      {
        id: "generation",
        kind: "tool",
        title: "生成图片",
        status: "running",
        text: "图片正在生成",
        command: "WAAO · node_generate",
      },
    ],
  };
  const render = () =>
    root.render(React.createElement(TaskProgress, { task, onStop() {} }));
  await act(render);
  assert.equal(container.querySelectorAll(".agent-task-activity").length, 3);
  assert.match(container.textContent, /生成雨天提示词/);
  assert.match(container.textContent, /创建图片节点/);
  assert.match(container.textContent, /生成图片/);
  assert.equal(
    container.querySelector(".agent-task-live-line").textContent,
    "WAAO · node_generate",
  );
  task.activities[2].command = "WAAO · task_get";
  await act(render);
  assert.equal(
    container.querySelector(".agent-task-live-line").textContent,
    "WAAO · task_get",
  );
  task.status = "waiting_external";
  await act(render);
  assert.equal(container.querySelectorAll(".agent-task-activity").length, 3);
  task.status = "interrupted";
  await act(render);
  assert.equal(
    container.querySelector(".agent-task-live-line"),
    null,
    "保存中断状态后不能继续显示命令正在运行",
  );
  task.activities[2].status = "failed";
  task.activities[2].text = "此应用没有生成权限。";
  task.activities[2].action = {
    label: "在 WAAO 查看权限与资源范围",
    url: "https://www.waao.studio/projects",
  };
  await act(render);
  assert.ok(container.querySelector(".is-failed"));
  assert.match(container.textContent, /此应用没有生成权限/);
  assert.equal(
    container.querySelector(".agent-task-activity-action").href,
    "https://www.waao.studio/projects",
  );
  task.status = "completed";
  task.activities[2].status = "done";
  task.activities[2].text = "图片已生成。";
  task.activities[2].action = null;
  task.result = "已完成图片，最终总结由聊天正文展示。";
  await act(render);
  assert.equal(container.querySelectorAll(".agent-task-activity").length, 3);
  assert.equal(container.querySelectorAll(".is-done").length, 3);
  assert.match(container.textContent, /3\/3/);
  assert.equal(container.querySelector(".agent-task-live-line"), null);
});
