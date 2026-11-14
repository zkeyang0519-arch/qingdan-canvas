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
test.beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  navigator.locks = browserLocks();
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/agent-batch-ui-"));
await build({
  stdin: {
    contents: `
      export { default as BatchPanel } from "./src/agent/BatchPanel.jsx";
      export { default as PendingBatchNotice } from "./src/agent/PendingBatchNotice.jsx";
    `,
    resolveDir: resolve("."),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
});
const { BatchPanel, PendingBatchNotice } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (el) =>
      el.textContent.trim() === label ||
      el.getAttribute("aria-label") === label,
  );
const field = (label) => document.querySelector(`[aria-label="${label}"]`);
const text = () => document.body.textContent;
async function click(el) {
  assert.ok(el);
  assert.equal(el.disabled, false);
  await act(async () => el.click());
}
async function edit(label, value) {
  const el = field(label);
  assert.ok(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
function fixture() {
  const calls = [];
  const binding = {
    bindingId: "binding",
    revision: 1,
    runnerId: "runner",
    workspaceId: "workspace",
    enabled: true,
  };
  let run = {
    bindingId: "binding",
    runId: "exact-run",
    kind: "task",
    sourceBacked: true,
    status: "running",
    terminal: false,
    stopConfirmed: false,
    threadId: "one-chat",
    turnId: "turn-1",
    createdAt: "2026-11-05T10:00:00Z",
    queue: {
      managed: true,
      revision: 1,
      phase: "running",
      currentIndex: 0,
      turnId: "turn-1",
      pauseRequested: false,
      canResume: false,
      repairCount: 0,
    },
    batch: {
      currentIndex: 0,
      items: [
        { taskId: "a", text: "写第一份文件", status: "running", summary: "" },
        { taskId: "b", text: "写第二份文件", status: "pending", summary: "" },
      ],
    },
  };
  let loseControl = false;
  let conflict = false;
  const requestCloud = async (route, options = {}) => {
    calls.push({ route, ...options });
    if (route.startsWith("/api/agent/bindings?"))
      return {
        binding: route.includes("sectionId=section") ? { ...binding } : null,
      };
    if (route.includes("/runs?"))
      return {
        runs: [
          { ...run, runId: "newer-run" },
          run,
          {
            ...run,
            runId: "summary-run",
            kind: "summary",
            sourceBacked: false,
          },
        ],
      };
    if (route.endsWith("/queue")) {
      if (loseControl) {
        loseControl = false;
        throw Error("回执未收到");
      }
      if (conflict) {
        conflict = false;
        run.queue = { ...run.queue, revision: run.queue.revision + 1 };
        throw Object.assign(Error("批次进度已变化"), { status: 409 });
      }
      const phase = {
        pause: "pause_requested",
        resume: "running",
        confirm: "finalizing",
        recover: "finalizing",
      }[options.body.action];
      run.queue = {
        ...run.queue,
        revision: run.queue.revision + 1,
        phase,
        pauseRequested: phase === "pause_requested",
        canResume: false,
      };
      return { queue: structuredClone(run.queue) };
    }
    if (route.endsWith("/tools")) {
      if (options.body.name === "codex_get_run")
        return {
          result: {
            run: {
              ...structuredClone(run),
              runId: options.body.arguments.runId,
            },
            events: [],
            nextAfterSeq: 0,
            hasMore: false,
          },
        };
      if (options.body.name === "codex_cancel_run") {
        run.queue.phase = "cancel_requested";
        return { result: { status: "accepted", runId: run.runId } };
      }
      if (options.body.name === "codex_continue_run")
        return { result: { status: "accepted", runId: run.runId } };
    }
    throw Error(`unexpected ${route}`);
  };
  return {
    calls,
    requestCloud,
    patch(value) {
      run = { ...run, ...value };
    },
    queue(value) {
      run.queue = { ...run.queue, ...value };
    },
    loseControl() {
      loseControl = true;
    },
    conflict() {
      conflict = true;
    },
    rebind() {
      binding.revision++;
    },
  };
}
async function mount(f) {
  assert.equal(typeof BatchPanel, "function", "step 8 exports its batch panel");
  const root = createRoot(document.getElementById("root"));
  const render = (props) =>
    act(async () =>
      root.render(
        React.createElement(BatchPanel, {
          roomId: "canvas",
          userId: "alice",
          pages: [
            { id: "section", title: "我的清单" },
            { id: "other", title: "另一个清单" },
          ],
          initialTarget: {
            sectionId: "section",
            bindingId: "binding",
            bindingRevision: 1,
            runId: "exact-run",
          },
          ...f,
          ...props,
        }),
      ),
    );
  await render();
  const close = () => act(async () => root.unmount());
  close.render = render;
  return close;
}

test("a paused batch needing reconciliation offers recovery on the original run before resume", async () => {
  const f = fixture();
  f.patch({ status: "reconciliation_required", error: "运行租约已过期。" });
  f.queue({ phase: "paused", canResume: true, pauseRequested: true });
  const close = await mount(f);
  try {
    assert.equal(!!button("继续批次"), false);
    await click(button("核对并恢复连接"));
    const actions = f.calls.filter((call) => call.route.endsWith("/queue"));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].body.action, "recover");
    assert.equal(actions[0].body.runId, "exact-run");
    assert.ok(!f.calls.some((call) => call.body?.name === "codex_create_run"));
  } finally {
    await close();
  }
});

test("embedded batch reports meaningful changes once and keeps questions outside collapsed details", async () => {
  const f = fixture(),
    changes = [];
  const close = await mount({
    ...f,
    embedded: true,
    onRunChange: (r) => changes.push(r),
  });
  try {
    assert.equal(field("批次项目清单"), null);
    assert.equal(document.querySelector(".agent-intro"), null);
    assert.equal(changes.filter(Boolean).length, 1);
    await click(button("刷新批次"));
    assert.equal(changes.filter(Boolean).length, 1);
    f.patch({ updatedAt: "later" });
    await click(button("刷新批次"));
    assert.equal(changes.filter(Boolean).length, 1);
    f.queue({ phase: "finalizing", revision: 2 });
    await click(button("刷新批次"));
    assert.equal(changes.filter(Boolean).length, 2);
    assert.equal(changes.at(-1).queue.phase, "finalizing");
  } finally {
    await close();
  }
});

test("a newly submitted target opens after an in-flight control and never leaves the new batch disabled", async () => {
  const f = fixture(),
    request = f.requestCloud;
  let release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  f.requestCloud = async (route, options) => {
    if (route.endsWith("/queue")) await paused;
    return request(route, options);
  };
  const close = await mount({ ...f, embedded: true });
  try {
    await click(button("当前项完成后暂停"));
    await close.render({
      initialTarget: {
        sectionId: "section",
        bindingId: "binding",
        bindingRevision: 1,
        runId: "newer-run",
      },
    });
    await act(async () => {
      release();
      await paused;
    });
    assert.equal(field("查看执行批次").value, "newer-run");
    assert.equal(button("刷新批次").disabled, false);
    assert.equal(f.calls.filter((c) => c.body?.action === "pause").length, 1);
    assert.equal(
      f.calls.some((c) => c.body?.name === "codex_create_run"),
      false,
    );
  } finally {
    release();
    await close();
  }
});
test("viewing batch history does not snap back to the initial target on read completion", async () => {
  const f = fixture(),
    close = await mount({ ...f, embedded: true });
  try {
    await act(async () => {
      field("查看执行批次").value = "newer-run";
      field("查看执行批次").dispatchEvent(
        new window.Event("change", { bubbles: true }),
      );
    });
    assert.equal(field("查看执行批次").value, "newer-run");
    await click(button("刷新批次"));
    assert.equal(field("查看执行批次").value, "newer-run");
  } finally {
    await close();
  }
});

test("step 8 opens the submitted batch without creating another run or choosing a newer summary", async () => {
  const f = fixture();
  const close = await mount(f);
  try {
    assert.equal(field("查看执行批次").value, "exact-run");
    assert.doesNotMatch(field("查看执行批次").textContent, /summary-run/);
    assert.ok(document.querySelector('a[href="codex://threads/one-chat"]'));
    assert.equal(
      f.calls.some((call) => call.body?.name === "codex_create_run"),
      false,
    );
    assert.match(text(), /写第一份文件.*写第二份文件/);
  } finally {
    await close();
  }
});

test("pause retries keep the request identity and resume waits for the authoritative paused phase", async () => {
  const f = fixture();
  const close = await mount(f);
  try {
    f.loseControl();
    await click(button("当前项完成后暂停"));
    await click(button("当前项完成后暂停"));
    const pauses = f.calls.filter((call) => call.body?.action === "pause");
    assert.deepEqual(pauses[0].body, pauses[1].body);
    assert.match(text(), /当前项完成后暂停/);
    assert.ok(!button("继续批次") || button("继续批次").disabled);
    f.queue({ phase: "paused", revision: 3, canResume: true, currentIndex: 1 });
    f.patch({ terminal: true, stopConfirmed: true });
    await click(button("刷新批次"));
    await click(button("继续批次"));
    assert.deepEqual(
      f.calls.find((call) => call.body?.action === "resume").body,
      {
        bindingId: "binding",
        bindingRevision: 1,
        runId: "exact-run",
        action: "resume",
        expectedRevision: 3,
        requestId: f.calls.find((call) => call.body?.action === "resume").body
          .requestId,
      },
    );
  } finally {
    await close();
  }
});

test("human acceptance is explicit and finalizing does not claim checklist completion", async () => {
  const f = fixture();
  f.queue({ phase: "waiting_human" });
  f.patch({
    terminal: true,
    stopConfirmed: true,
    batch: {
      currentIndex: 0,
      items: [
        {
          taskId: "a",
          text: "写第一份文件",
          status: "done",
          summary: "文件已生成",
        },
      ],
    },
  });
  const close = await mount(f);
  try {
    assert.equal(
      f.calls.some((call) => call.body?.action === "confirm"),
      false,
    );
    assert.doesNotMatch(text(), /已通过验收/);
    await click(button("确认本项验收通过"));
    assert.equal(
      f.calls.find((call) => call.body?.action === "confirm").body
        .expectedTurnId,
      "turn-1",
    );
    assert.match(text(), /正在更新清单/);
    assert.doesNotMatch(text(), /本批次已全部完成/);
    assert.ok(!button("继续批次") || button("继续批次").disabled);
  } finally {
    await close();
  }
});

test("immediate stop requires confirmation and waits for the actual stopped receipt", async () => {
  const f = fixture();
  const close = await mount(f);
  try {
    await click(button("立即停止"));
    assert.equal(
      f.calls.some((call) => call.body?.name === "codex_cancel_run"),
      false,
    );
    await click(button("确认停止本批次"));
    assert.match(text(), /正在等待本机确认停止/);
    f.queue({ phase: "cancelled" });
    f.patch({ terminal: true, stopConfirmed: false });
    await click(button("刷新批次"));
    assert.doesNotMatch(text(), /本批次已停止/);
    f.patch({ stopConfirmed: true });
    await click(button("刷新批次"));
    assert.match(text(), /本批次已停止/);
    assert.doesNotMatch(text(), /正在等待本机确认停止/);
  } finally {
    await close();
  }
});

test("blocked tasks accept a guarded reply in the same chat but native approval waits are not replies", async () => {
  const f = fixture();
  f.queue({ phase: "blocked", reason: "需要报告标题" });
  f.patch({ terminal: true, stopConfirmed: true, status: "failed" });
  const close = await mount(f);
  try {
    await edit("补充执行说明", "标题为本周总结");
    await click(button("补充说明并继续当前项"));
    const follow = f.calls.find(
      (call) => call.body?.name === "codex_continue_run",
    ).body.arguments;
    assert.equal(follow.runId, "exact-run");
    assert.equal(follow.expectedTurnId, "turn-1");
    assert.equal(follow.mode, "reply");
    assert.equal(follow.message, "标题为本周总结");
    f.patch({
      terminal: false,
      stopConfirmed: false,
      status: "waiting_approval",
    });
    await click(button("刷新批次"));
    assert.match(text(), /正在核对当前审批请求/);
    assert.ok(
      !button("补充说明并继续当前项") ||
        button("补充说明并继续当前项").disabled,
    );
  } finally {
    await close();
  }
});

const approval = (overrides = {}) => ({
  requestId: "native-request",
  runId: "exact-run",
  threadId: "one-chat",
  turnId: "turn-1",
  kind: "approval",
  responseStatus: "pending",
  description: "创建批次文件",
  details: {
    method: "item/fileChange/requestApproval",
    cwd: "D:/test",
    files: ["notes.txt"],
    allowedDecisions: ["accept", "decline", "cancel"],
  },
  ...overrides,
});

test("native approval shows exact operation, never answers automatically and retries the same decision identity", async () => {
  const f = fixture();
  f.patch({
    status: "waiting_approval",
    pendingRequests: [approval()],
    executionPermissions: { profile: "workspace_manual", network: false },
  });
  const request = f.requestCloud;
  let first = true;
  f.requestCloud = async (route, options) => {
    if (!route.endsWith("/respond")) return request(route, options);
    f.calls.push({ route, ...options });
    if (first) {
      first = false;
      throw Error("回执未收到");
    }
    return {
      responseId: "response",
      pendingRequestId: "native-request",
      status: "queued",
    };
  };
  const close = await mount(f);
  try {
    const dialog = document.querySelector(
      '[role="dialog"][aria-label="Codex 请求审批"]',
    );
    assert.ok(dialog);
    assert.match(dialog.textContent, /notes.txt/);
    assert.match(dialog.textContent, /D:\/test/);
    assert.equal(f.calls.filter((c) => c.route.endsWith("/respond")).length, 0);
    await click(button("仅本次同意"));
    assert.ok(!button("拒绝本次操作") || button("拒绝本次操作").disabled);
    await click(button("重试发送选择"));
    const responses = f.calls.filter((c) => c.route.endsWith("/respond"));
    assert.equal(responses.length, 2);
    assert.deepEqual(responses[0].body, responses[1].body);
    assert.equal(responses[0].body.runId, "exact-run");
    assert.equal(responses[0].body.expectedTurnId, "turn-1");
    assert.equal(responses[0].body.pendingRequestId, "native-request");
    assert.deepEqual(responses[0].body.response, { decision: "accept" });
    assert.match(dialog.textContent, /等待本机确认/);
    f.patch({ status: "running", pendingRequests: [] });
    await click(button("刷新批次"));
    assert.equal(document.querySelector('[aria-label="Codex 请求审批"]'), null);
  } finally {
    await close();
  }
});

test("expired and mismatched prompts never open or respond after a run has stopped", async () => {
  const f = fixture();
  f.patch({
    status: "waiting_approval",
    pendingRequests: [
      approval({ turnId: "old-turn" }),
      approval({ runId: "other-run" }),
    ],
  });
  const close = await mount(f);
  try {
    assert.equal(document.querySelector('[aria-label="Codex 请求审批"]'), null);
    f.patch({
      pendingRequests: [approval()],
      terminal: true,
      stopConfirmed: true,
    });
    await click(button("刷新批次"));
    assert.equal(document.querySelector('[aria-label="Codex 请求审批"]'), null);
    assert.equal(f.calls.filter((c) => c.route.endsWith("/respond")).length, 0);
  } finally {
    await close();
  }
});

test("native question preserves question ids and requires explicit answers", async () => {
  const f = fixture();
  f.patch({
    status: "waiting_input",
    pendingRequests: [
      approval({
        kind: "input",
        questions: [
          {
            id: "title",
            prompt: "文件标题？",
            options: [{ label: "周报", description: "每周总结" }],
            isOther: true,
          },
          { id: "detail", prompt: "补充内容？" },
        ],
      }),
    ],
  });
  const request = f.requestCloud;
  f.requestCloud = async (route, options) => {
    if (!route.endsWith("/respond")) return request(route, options);
    f.calls.push({ route, ...options });
    return {
      responseId: "response",
      pendingRequestId: "native-request",
      status: "queued",
    };
  };
  const close = await mount(f);
  try {
    assert.ok(document.querySelector('[aria-label="Codex 需要你的回答"]'));
    assert.equal(button("发送回答").disabled, true);
    await click(document.querySelector('input[value="周报"]'));
    await edit("补充内容？", "按时间排序");
    await click(button("发送回答"));
    const body = f.calls.find((c) => c.route.endsWith("/respond")).body;
    assert.deepEqual(body.response, {
      answers: {
        title: { answers: ["周报"] },
        detail: { answers: ["按时间排序"] },
      },
    });
  } finally {
    await close();
  }
});

test("refusal and cancellation preserve the precise native request instead of continuing the chat", async () => {
  for (const [label, decision] of [
    ["拒绝本次操作", "decline"],
    ["取消当前请求", "cancel"],
  ]) {
    const f = fixture();
    f.patch({ status: "waiting_approval", pendingRequests: [approval()] });
    const request = f.requestCloud;
    f.requestCloud = async (route, options) => {
      if (!route.endsWith("/respond")) return request(route, options);
      f.calls.push({ route, ...options });
      return {
        responseId: "response",
        pendingRequestId: "native-request",
        status: "queued",
      };
    };
    const close = await mount(f);
    try {
      await click(button(label));
      assert.deepEqual(
        f.calls.find((c) => c.route.endsWith("/respond")).body.response,
        { decision },
      );
      assert.equal(
        f.calls.some((c) => c.body?.name === "codex_continue_run"),
        false,
      );
    } finally {
      await close();
    }
  }
});

test("restricted or legacy approval prompts cannot grant an unavailable permission", async () => {
  for (const allowedDecisions of [["decline", "cancel"], undefined]) {
    const f = fixture();
    f.patch({
      status: "waiting_approval",
      pendingRequests: [
        approval({
          details: {
            method: "item/fileChange/requestApproval",
            allowedDecisions,
          },
        }),
      ],
    });
    const close = await mount(f);
    try {
      assert.equal(button("仅本次同意").disabled, true);
      assert.equal(button("拒绝本次操作").disabled, false);
      assert.match(text(), /当前操作不能批准/);
      assert.equal(
        f.calls.filter((c) => c.route.endsWith("/respond")).length,
        0,
      );
    } finally {
      await close();
    }
  }
});

test("option-only native questions do not offer an unsupported free-text answer", async () => {
  const f = fixture();
  f.patch({
    status: "waiting_input",
    pendingRequests: [
      approval({
        kind: "input",
        questions: [
          {
            id: "format",
            prompt: "选择格式",
            options: [{ label: "TXT", description: "文本" }],
            isOther: false,
          },
        ],
      }),
    ],
  });
  const close = await mount(f);
  try {
    assert.equal(document.querySelector('[aria-label="选择格式"]'), null);
    assert.equal(button("发送回答").disabled, true);
    await click(document.querySelector('input[value="TXT"]'));
    assert.equal(button("发送回答").disabled, false);
  } finally {
    await close();
  }
});

test("background monitor reports an outstanding request and opens only its exact observed batch", async () => {
  const f = fixture();
  f.patch({ status: "waiting_approval", pendingRequests: [approval()] });
  const target = {
    sectionId: "section",
    bindingId: "binding",
    bindingRevision: 1,
    runId: "exact-run",
  };
  const opened = [];
  const root = createRoot(document.getElementById("root"));
  const render = (extra) =>
    act(async () =>
      root.render(
        React.createElement(PendingBatchNotice, {
          roomId: "canvas",
          userId: "alice",
          target,
          onOpen: (value) => opened.push(value),
          requestCloud: f.requestCloud,
          floating: true,
          ...extra,
        }),
      ),
    );
  try {
    await render();
    assert.match(text(), /批次正在等待你的审批/);
    assert.ok(document.querySelector(".agent-pending-toast"));
    await click(button("查看并处理请求"));
    assert.deepEqual(opened, [target]);
    assert.equal(
      f.calls.some((c) => c.route.endsWith("/respond")),
      false,
    );
    f.rebind();
    await render({ target: { ...target, runId: "another" } });
    assert.equal(button("查看并处理请求"), undefined);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a delayed prior account monitor cannot expose its prompt after the account changes", async () => {
  const target = {
    sectionId: "section",
    bindingId: "binding",
    bindingRevision: 1,
    runId: "exact-run",
  };
  let release;
  const requestCloud = async (route, options) => {
    if (options.accountId === "bob") return { binding: null };
    if (route.includes("/bindings?"))
      return { binding: { bindingId: "binding", revision: 1, enabled: true } };
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const root = createRoot(document.getElementById("root"));
  const render = (userId) =>
    act(async () =>
      root.render(
        React.createElement(PendingBatchNotice, {
          roomId: "canvas",
          userId,
          target,
          requestCloud,
          onOpen() {},
        }),
      ),
    );
  try {
    await render("alice");
    await render("bob");
    await act(async () =>
      release({
        result: {
          run: {
            ...target,
            threadId: "one-chat",
            turnId: "turn-1",
            pendingRequests: [approval()],
          },
        },
      }),
    );
    assert.equal(button("查看并处理请求"), undefined);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a version conflict refreshes state without replaying a changed command", async () => {
  const f = fixture();
  const close = await mount(f);
  try {
    f.conflict();
    await click(button("当前项完成后暂停"));
    assert.equal(
      f.calls.filter((call) => call.body?.action === "pause").length,
      1,
    );
    assert.match(text(), /批次进度已变化/);
    await click(button("当前项完成后暂停"));
    const pauses = f.calls.filter((call) => call.body?.action === "pause");
    assert.equal(pauses[1].body.expectedRevision, 2);
    assert.notEqual(pauses[0].body.requestId, pauses[1].body.requestId);
  } finally {
    await close();
  }
});

test("an accepted queue control updates the visible phase even if its follow-up read fails", async () => {
  const f = fixture();
  const request = f.requestCloud;
  let accepted = false;
  f.requestCloud = async (route, options = {}) => {
    if (accepted && route.includes("/runs?")) throw Error("暂时无法刷新记录");
    const response = await request(route, options);
    if (route.endsWith("/queue")) accepted = true;
    return response;
  };
  const close = await mount(f);
  try {
    await click(button("当前项完成后暂停"));
    assert.match(
      document.querySelector('.agent-managed-batch [role="status"]')
        .textContent,
      /将在当前项完成后暂停/,
    );
    assert.ok(!button("当前项完成后暂停"));
    assert.match(text(), /暂时无法刷新记录/);
  } finally {
    await close();
  }
});

test("binding changes prevent queued controls from acting on the old project", async () => {
  const f = fixture();
  const close = await mount(f);
  try {
    f.rebind();
    await click(button("当前项完成后暂停"));
    assert.equal(
      f.calls.some((call) => call.body?.action === "pause"),
      false,
    );
    assert.match(text(), /项目关联已变化/);
  } finally {
    await close();
  }
});
