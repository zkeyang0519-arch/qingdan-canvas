import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dom = new JSDOM('<div id="root"></div>', {
  url: "http://127.0.0.1:8788",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/execution-stream-"));
await build({
  entryPoints: [resolve("src/agent/ProjectConversation.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
});
const { ConversationMessages } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
let root, timers, timerId, reduced;
test.beforeEach((t) => {
  timers = new Map();
  timerId = 0;
  reduced = false;
  t.mock.method(window, "setTimeout", (fn) => {
    const id = ++timerId;
    timers.set(id, fn);
    return id;
  });
  t.mock.method(window, "clearTimeout", (id) => timers.delete(id));
  window.matchMedia = () => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  });
  root = createRoot(document.getElementById("root"));
});
test.afterEach(async () => {
  await act(async () => root.unmount());
});
async function tick(count = 1) {
  for (let i = 0; i < count; i++) {
    const queued = [...timers.entries()];
    await act(async () => {
      for (const [id, fn] of queued) if (timers.delete(id)) fn();
    });
  }
}
const button = (name) =>
  [...document.querySelectorAll("button")].find(
    (el) =>
      el.getAttribute("aria-label") === name || el.textContent.trim() === name,
  );
async function click(name) {
  const el = button(name);
  assert.ok(el, name);
  await act(async () => el.click());
}
const run = {
  runId: "run",
  turnId: "turn",
  terminal: false,
  status: "running",
  createdAt: "2026-11-12T01:00:00Z",
  submission: { text: "检查并修复项目", tasks: [{}] },
};
const events = (items) =>
  items.map((payload, index) => ({
    type: "output.delta",
    eventId: `e${index}`,
    turnId: "turn",
    seq: index + 1,
    payload,
  }));
const message = (itemId, text) => ({
  channel: "assistant",
  itemId,
  text,
  phase: "completed",
});
const command = (itemId, title, text, phase = "completed") => ({
  channel: "command",
  itemId,
  title,
  text,
  phase,
});
async function render({ output, state = run, job, stopping = false } = {}) {
  await act(async () =>
    root.render(
      React.createElement(ConversationMessages, {
        messages: [],
        renderMessage: () => null,
        job,
        runs: output ? [state] : [],
        detail: output ? { run: state, events: output } : null,
        stopping,
        binding: { bindingId: "binding" },
        call: async () => ({}),
      }),
    ),
  );
}

test("received text is revealed progressively by whole characters, appends without rewinding, and cancellation flushes it", async () => {
  const text = "你好👩‍💻，正在检查项目。";
  let job = { id: "job", status: "running", partialText: text };
  await render({ job });
  const body = () =>
    document.querySelector('[aria-label="助手流式回复"] .agent-chat-markdown')
      ?.textContent || "";
  assert.equal(body(), "");
  await tick();
  assert.equal(body(), "你");
  await tick();
  assert.equal(body(), "你好");
  await tick();
  assert.equal(body(), "你好👩‍💻");
  job = { ...job, partialText: text + "已找到入口。" };
  await render({ job });
  assert.equal(body(), "你好👩‍💻");
  await tick();
  assert.ok(body().startsWith("你好👩‍💻"));
  await render({ job: { ...job, status: "cancelled" } });
  assert.equal(body(), job.partialText);
  assert.equal(timers.size, 0);
});

test("reduced motion presents the received text immediately without a typing timer", async () => {
  reduced = true;
  await render({
    job: { id: "job", status: "running", partialText: "完整回复" },
  });
  assert.match(document.body.textContent, /完整回复/);
  assert.equal(timers.size, 0);
});

test("execution time advances while active, freezes on completion, and survives a remount", async (t) => {
  let now = Date.parse("2026-11-12T01:00:05Z");
  t.mock.method(Date, "now", () => now);
  const intervals = new Map();
  let sequence = 0;
  t.mock.method(window, "setInterval", (fn) => {
    intervals.set(++sequence, fn);
    return sequence;
  });
  t.mock.method(window, "clearInterval", (id) => intervals.delete(id));
  const output = events([message("m1", "正在检查")]);
  await render({ output });
  assert.match(
    document.querySelector(".agent-elapsed-time")?.textContent || "",
    /已用时 5秒/,
  );
  now += 2000;
  await act(async () => {
    for (const fn of intervals.values()) fn();
  });
  assert.match(
    document.querySelector(".agent-elapsed-time").textContent,
    /已用时 7秒/,
  );
  const done = {
    ...run,
    terminal: true,
    stopConfirmed: true,
    status: "succeeded",
    updatedAt: "2026-11-12T01:00:08Z",
  };
  await render({ output, state: done });
  assert.equal(document.querySelector(".agent-elapsed-time"), null);
  assert.equal(intervals.size, 0);
  now += 60000;
  await render({});
  await render({ output, state: done });
  assert.equal(document.querySelector(".agent-elapsed-time"), null);
});

test("a large received chunk catches up promptly instead of replaying thousands of characters", async () => {
  const text = "文字".repeat(2000);
  await render({ job: { id: "job", status: "running", partialText: text } });
  const body = () =>
    document.querySelector('[aria-label="助手流式回复"] .agent-chat-markdown')
      ?.textContent || "";
  assert.ok(body().length > 3000 && body().length < text.length);
  await tick(160);
  assert.equal(body(), text);
  assert.equal(timers.size, 0);
});

test("typing follows the bottom but never pulls a reader away from earlier messages", async () => {
  await render({
    job: { id: "job", status: "running", partialText: "正在逐字显示这段回复" },
  });
  const list = document.querySelector('[aria-label="聊天消息记录"]');
  Object.defineProperties(list, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
  });
  list.scrollTop = 0;
  await act(async () =>
    list.dispatchEvent(new window.Event("scroll", { bubbles: true })),
  );
  await tick(2);
  assert.equal(list.scrollTop, 0);
  list.scrollTop = 800;
  await act(async () =>
    list.dispatchEvent(new window.Event("scroll", { bubbles: true })),
  );
  await tick();
  assert.equal(list.scrollTop, 1000);
});

test("each subtask has its explanation followed by exactly one current program line", async () => {
  reduced = true;
  await render({
    output: events([
      message("m1", "先检查入口文件。"),
      command("c1", "读取入口", "旧检查记录"),
      message("m2", "正在验证修改。"),
      command("c2", "npm run check", "类型检查详细记录"),
      command(
        "c3",
        "npm test",
        "第一条程序输出\n第二条程序输出\n最新一条程序输出",
        "delta",
      ),
    ]),
  });
  const steps = [...document.querySelectorAll(".agent-execution-step")];
  assert.equal(steps.length, 2);
  assert.match(steps[0].textContent, /先检查入口文件/);
  assert.match(steps[1].textContent, /正在验证修改/);
  for (const step of steps)
    assert.equal(
      step.querySelectorAll(".agent-execution-program-line").length,
      1,
    );
  assert.match(
    steps[1].querySelector(".agent-execution-program-line").textContent,
    /最新一条程序输出/,
  );
  assert.doesNotMatch(
    steps[1].textContent,
    /第一条程序输出|第二条程序输出|类型检查详细记录|条记录|条命令/,
  );
  assert.equal(document.querySelector(".agent-execution-history-toggle"), null);
  assert.equal(document.querySelector(".agent-execution-step-heading"), null);
});

test("process changes replace the same program line immediately without replaying earlier commands", async () => {
  const first = [
    message("m1", "正在检查项目。"),
    command("c1", "npm run check", "旧输出", "delta"),
  ];
  await render({ output: events(first) });
  const line = document.querySelector(".agent-execution-program-line");
  await render({
    output: events([...first, command("c2", "npm test", "", "started")]),
  });
  assert.equal(document.querySelector(".agent-execution-program-line"), line);
  assert.match(line.textContent, /npm test/);
  assert.doesNotMatch(line.textContent, /旧输出|npm run check/);
  await render({
    output: events([
      ...first,
      command("c2", "npm test", "test one\ntest two", "delta"),
    ]),
  });
  assert.match(line.textContent, /test two/);
  assert.doesNotMatch(line.textContent, /test one/);
});

test("the task explanation never becomes the raw shell executable path", async () => {
  reduced = true;
  await render({
    output: events([
      message("m1", "正在检查入口。随后会验证修改。"),
      command(
        "c1",
        '"C:\\Program Files\\WindowsApps\\OpenAI.CodexPrimaryRuntime\\dependencies\\native\\powershell\\pwsh.exe" -Command "npm test"',
        "",
        "started",
      ),
    ]),
  });
  assert.equal(
    document.querySelector(".agent-execution-task-description").textContent,
    "正在检查入口。",
  );
  assert.match(
    document.querySelector(".agent-execution-program-line").textContent,
    /npm test/,
  );
  assert.doesNotMatch(
    document.body.textContent,
    /WindowsApps|CodexPrimaryRuntime|随后会验证/,
  );
});

test("completed runs remove every progress node and render the full authoritative answer once", async () => {
  reduced = true;
  const output = events([
    message("m1", "当前分支有未提交修改，正在检查。"),
    command("c1", "powershell.exe", "详细检查日志"),
  ]);
  await render({ output });
  assert.ok(document.querySelector(".agent-execution-step"));
  const final = "**完成结果**\n\n导航已修复，并验证了手机布局。";
  await render({
    output,
    state: {
      ...run,
      terminal: true,
      stopConfirmed: true,
      status: "verifying",
      output: final,
    },
  });
  assert.equal(document.body.textContent.match(/导航已修复/g)?.length, 1);
  assert.doesNotMatch(
    document.body.textContent,
    /当前分支|详细检查日志|powershell|本次执行已结束|条命令|条记录/,
  );
  assert.equal(document.querySelector(".agent-execution-steps"), null);
  assert.equal(document.querySelector(".agent-chat-run-status"), null);
  assert.ok(document.querySelector(".agent-execution-result strong"));
  assert.equal(timers.size, 0);
});

test("terminal delivery reads the final answer without presenting completed work as running", async () => {
  reduced = true;
  const output = events([
    { ...message("m1", "现在开始检查项目"), messagePhase: "commentary" },
  ]);
  const done = {
    ...run,
    terminal: true,
    stopConfirmed: true,
    status: "verifying",
  };
  await render({ output, state: done });
  assert.doesNotMatch(document.body.textContent, /现在开始检查项目/);
  assert.match(document.body.textContent, /读取执行结果/);
  await render({
    output: [
      ...output,
      {
        type: "turn.completed",
        turnId: "turn",
        payload: {
          output: "最终结果已送达",
          outcome: { outcome: "done", summary: "短回执" },
        },
      },
    ],
    state: done,
  });
  assert.match(document.body.textContent, /最终结果已送达/);
  assert.doesNotMatch(
    document.body.textContent,
    /现在开始检查项目|短回执|等待最终结果/,
  );
});

test("completion receipts and legacy explicit final messages remain useful without retaining progress", async () => {
  const output = [
    ...events([
      { ...message("m1", "检查说明"), messagePhase: "commentary" },
      command("c1", "check", "检查日志"),
      {
        ...message("m2", "详细最终回答：导航已修复。"),
        messagePhase: "final_answer",
      },
    ]),
    {
      type: "turn.completed",
      turnId: "turn",
      payload: { outcome: { outcome: "done", summary: "简短验收回执" } },
    },
  ];
  await render({
    output,
    state: { ...run, terminal: true, stopConfirmed: true, status: "verifying" },
  });
  assert.match(document.body.textContent, /详细最终回答：导航已修复/);
  assert.doesNotMatch(
    document.body.textContent,
    /检查说明|检查日志|简短验收回执/,
  );
  assert.equal(document.querySelector(".agent-execution-program-line"), null);
  assert.equal(timers.size, 0);
});

test("stopping a live execution retains the received explanation and only its latest program line", async () => {
  const output = events([
    message("m1", "正在检查这个项目的入口文件"),
    command("c1", "check", "隐藏的旧日志\n当前日志", "delta"),
  ]);
  await render({ output });
  await tick();
  await render({ output, stopping: true });
  assert.match(document.body.textContent, /正在检查这个项目的入口文件/);
  assert.match(document.body.textContent, /当前日志/);
  assert.doesNotMatch(document.body.textContent, /隐藏的旧日志/);
  assert.equal(timers.size, 0);
  await render({
    output,
    state: { ...run, terminal: true, stopConfirmed: true, status: "cancelled" },
  });
  assert.equal(document.querySelector(".agent-execution-program-line"), null);
  assert.doesNotMatch(document.body.textContent, /当前日志|正在检查这个项目/);
  assert.match(document.body.textContent, /已停止/);
});

test("carriage-return progress and file updates replace the single preview line", async () => {
  reduced = true;
  await render({
    output: events([
      message("m1", "更新项目文件"),
      command("c1", "build", "10%\r40%\r\u001b[32m100%\u001b[0m\n", "delta"),
    ]),
  });
  assert.match(
    document.querySelector(".agent-execution-program-line").textContent,
    /100%/,
  );
  assert.doesNotMatch(document.body.textContent, /10%|40%|\u001b/);
  await render({
    output: events([
      message("m1", "更新项目文件"),
      {
        channel: "file_change",
        itemId: "f1",
        text: "src/one.js\nsrc/two.js",
        title: "文件修改",
        phase: "completed",
      },
    ]),
  });
  assert.equal(
    document.querySelectorAll(".agent-execution-program-line").length,
    1,
  );
  assert.match(document.body.textContent, /src\/two.js/);
  assert.doesNotMatch(document.body.textContent, /src\/one.js/);
});

test("interleaved commands show only the latest received output in their subtask", async () => {
  reduced = true;
  await render({
    output: events([
      message("m1", "检查两个任务"),
      command("c1", "first", "第一项旧输出\n", "delta"),
      command("c2", "second", "第二项输出", "delta"),
      command("c1", "first", "第一项新输出", "delta"),
    ]),
  });
  assert.equal(
    document.querySelectorAll(".agent-execution-program-line").length,
    1,
  );
  assert.match(document.body.textContent, /第一项新输出/);
  assert.doesNotMatch(document.body.textContent, /第一项旧输出|第二项输出/);
});

test("continued turns never display a previous turn's final result as the current answer", async () => {
  reduced = true;
  const output = [
    ...events([message("m1", "上一轮的详细回答")]),
    {
      type: "turn.completed",
      turnId: "turn",
      payload: {
        output: "上一轮最终结果",
        outcome: { outcome: "done", summary: "上一轮的简短总结" },
      },
    },
    ...events([
      message("m2", "正在继续修改"),
      command("c2", "verify", "当前这一轮的程序行", "delta"),
    ]).map((event, index) => ({
      ...event,
      eventId: `next-${index}`,
      turnId: "next",
    })),
  ];
  await render({ state: { ...run, turnId: "next" }, output });
  assert.match(document.body.textContent, /正在继续修改/);
  assert.match(document.body.textContent, /当前这一轮的程序行/);
  assert.doesNotMatch(document.body.textContent, /上一轮/);
  await render({
    state: {
      ...run,
      turnId: "next",
      terminal: true,
      stopConfirmed: true,
      status: "verifying",
    },
    output,
  });
  assert.doesNotMatch(
    document.body.textContent,
    /上一轮|当前这一轮的程序行|正在继续修改/,
  );
  assert.match(document.body.textContent, /读取执行结果/);
});

test("an explicitly empty final output never falls back to unphased progress", async () => {
  await render({
    state: {
      ...run,
      terminal: true,
      stopConfirmed: true,
      status: "verifying",
      output: "",
    },
    output: [
      ...events([message("m1", "先检查当前分支")]),
      {
        type: "turn.completed",
        turnId: "turn",
        payload: {
          output: "",
          outcome: { outcome: "done", summary: "已完成检查" },
        },
      },
    ],
  });
  assert.match(document.body.textContent, /已完成检查/);
  assert.doesNotMatch(document.body.textContent, /先检查当前分支/);
});

test("historical runs display persisted final answers without offering raw execution logs", async () => {
  await act(async () =>
    root.render(
      React.createElement(ConversationMessages, {
        messages: [],
        renderMessage: () => null,
        runs: [
          {
            ...run,
            terminal: true,
            stopConfirmed: true,
            status: "verifying",
            output: "历史最终回答",
          },
        ],
        detail: null,
        binding: { bindingId: "binding" },
        call: async () => {
          throw Error("unneeded historical read");
        },
      }),
    ),
  );
  assert.match(document.body.textContent, /历史最终回答/);
  assert.doesNotMatch(document.body.textContent, /查看完整输出|本次执行已结束/);
});

test("a late persisted answer replaces an already loaded historical detail", async () => {
  const done = {
    ...run,
    terminal: true,
    stopConfirmed: true,
    status: "verifying",
    reportRevision: 1,
  };
  const call = async () => ({
    result: { run: done, events: [], nextAfterSeq: 0, hasMore: false },
  });
  const props = {
    messages: [],
    renderMessage: () => null,
    binding: { bindingId: "binding" },
    call,
  };
  await act(async () =>
    root.render(
      React.createElement(ConversationMessages, { ...props, runs: [done] }),
    ),
  );
  await act(async () =>
    root.render(
      React.createElement(ConversationMessages, {
        ...props,
        runs: [{ ...done, output: "延迟收到的最终结果", reportRevision: 2 }],
      }),
    ),
  );
  assert.match(document.body.textContent, /延迟收到的最终结果/);
  assert.doesNotMatch(document.body.textContent, /未返回最终结果|等待最终结果/);
});

test("historical output reloads delayed completion events when the event cursor advances", async () => {
  const done = {
    ...run,
    terminal: true,
    stopConfirmed: true,
    status: "verifying",
    lastSeq: 1,
  };
  let output = events([
    { ...message("m1", "中途检查说明"), messagePhase: "commentary" },
  ]);
  const call = async () => ({
    result: {
      run: done,
      events: output,
      nextAfterSeq: output.length,
      hasMore: false,
    },
  });
  const props = {
    messages: [],
    renderMessage: () => null,
    binding: { bindingId: "binding" },
    call,
  };
  await act(async () =>
    root.render(
      React.createElement(ConversationMessages, { ...props, runs: [done] }),
    ),
  );
  assert.doesNotMatch(document.body.textContent, /中途检查说明/);
  output = [
    ...output,
    {
      type: "turn.completed",
      turnId: "turn",
      payload: { output: "迟到的历史最终答复" },
    },
  ];
  await act(async () =>
    root.render(
      React.createElement(ConversationMessages, {
        ...props,
        runs: [{ ...done, lastSeq: 2 }],
      }),
    ),
  );
  assert.match(document.body.textContent, /迟到的历史最终答复/);
});

test("a delivered final answer recovers from an earlier historical read error", async () => {
  const done = {
    ...run,
    terminal: true,
    stopConfirmed: true,
    status: "verifying",
  };
  const call = async () => {
    throw Error("历史读取临时失败");
  };
  const props = {
    messages: [],
    renderMessage: () => null,
    binding: { bindingId: "binding" },
    call,
  };
  await act(async () =>
    root.render(
      React.createElement(ConversationMessages, { ...props, runs: [done] }),
    ),
  );
  assert.match(document.body.textContent, /历史读取临时失败/);
  await act(async () =>
    root.render(
      React.createElement(ConversationMessages, {
        ...props,
        runs: [{ ...done, output: "网络恢复后的最终答复" }],
      }),
    ),
  );
  assert.match(document.body.textContent, /网络恢复后的最终答复/);
  assert.doesNotMatch(document.body.textContent, /历史读取临时失败/);
});

test("two completed runs show their final results without loading either event history", async () => {
  const done = {
    ...run,
    terminal: true,
    stopConfirmed: true,
    status: "verifying",
    resultReadComplete: true,
    lastSeq: 30000,
  };
  const call = async () => {
    throw Error("completed answers must not require log paging");
  };
  await act(async () =>
    root.render(
      React.createElement(ConversationMessages, {
        messages: [],
        renderMessage: () => null,
        binding: { bindingId: "binding" },
        call,
        runs: [
          { ...done, runId: "earlier", output: "上次执行的最终答复" },
          { ...done, output: "本次执行的最终答复", reportRevision: 2 },
        ],
        detail: {
          run: { ...done, reportRevision: 1 },
          events: [],
          hasMore: true,
        },
      }),
    ),
  );
  assert.match(document.body.textContent, /上次执行的最终答复/);
  assert.match(document.body.textContent, /本次执行的最终答复/);
  assert.doesNotMatch(document.body.textContent, /等待最终结果|读取执行结果/);
});

test("a confirmed empty completion never suggests the task is still waiting for a result", async () => {
  await render({
    output: [],
    state: {
      ...run,
      terminal: true,
      stopConfirmed: true,
      status: "verifying",
      resultReadComplete: true,
      output: "",
    },
  });
  assert.doesNotMatch(document.body.textContent, /正在等待|正在读取/);
  assert.match(document.body.textContent, /未保存最终答复/);
});

test("a queued continuation replaces the previous result before its first native report", async () => {
  const prior = { ...run, terminal: true, stopConfirmed: true, status: "verifying", reportRevision: 4, lastSeq: 30000, commandId: "old", updatedAt: "2026-11-13T01:00:00Z", output: "上一轮的最终答复", resultReadComplete: true };
  const queued = { ...prior, terminal: false, stopConfirmed: false, status: "queued", commandId: "new", updatedAt: "2026-11-13T01:00:01Z", output: undefined, resultReadComplete: undefined };
  await act(async () => root.render(React.createElement(ConversationMessages, {
    messages: [], renderMessage: () => null, binding: { bindingId: "binding" }, call: async () => ({}),
    runs: [queued], detail: { run: prior, events: [] },
  })));
  assert.doesNotMatch(document.body.textContent, /上一轮的最终答复/);
  assert.match(document.body.textContent, /已提交，等待电脑接收/);
});
