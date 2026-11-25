import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("任务问题不默认提交，回答携带原问题标识，刷新保留草稿且停止独立可用", async (t) => {
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
  let stops = 0;
  const render = () =>
    root.render(
      React.createElement(TaskProgress, {
        task,
        onReply: async (...args) => {
          calls.push(args);
          return true;
        },
        onStop: () => stops++,
      }),
    );
  await act(render);
  const button = (text) =>
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    );
  assert.equal(button("回答并继续").disabled, true);
  assert.equal(calls.length, 0);
  await act(() => button("温暖").click());
  assert.equal(calls.length, 0);
  await act(() => root.unmount());
  root = createRoot(container);
  await act(render);
  assert.equal(container.querySelector("textarea").value, "温暖");
  await act(async () => button("回答并继续").click());
  assert.deepEqual(calls, [
    ["温暖", { taskId: "task-a", questionId: "question-a" }],
  ]);
  await act(() => button("停止任务推进").click());
  assert.equal(stops, 1);
});
