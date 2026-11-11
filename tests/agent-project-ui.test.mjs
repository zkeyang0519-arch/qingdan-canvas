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
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/agent-project-ui-"));
await build({
  entryPoints: [resolve("src/agent/AgentExperience.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
});
const { ProjectSummaryPanel } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
const button = (name) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === name,
  );
const click = async (name) => {
  const el = button(name);
  assert.ok(el, name);
  assert.equal(el.disabled, false, name);
  await act(async () => el.click());
};
const initial = {
  bindingId: "bound",
  bindingRevision: 2,
  status: "uninitialized",
  ready: false,
  stale: false,
  summaryRevision: 0,
  summary: null,
  capturedAt: null,
  sourceRunId: null,
  threadId: null,
  turnId: null,
  cwd: null,
  gitBaseline: null,
  error: null,
  activeRunId: null,
};
const ready = {
  ...initial,
  status: "ready",
  ready: true,
  summaryRevision: 1,
  summary: {
    overview: "项目包含已验证的安装文档。",
    completed: [{ text: "安装步骤已完成", evidenceRef: "README.md" }],
    inProgress: [],
    pending: [{ text: "补充演示" }],
    blockers: [],
    verification: [{ text: "只读检查README", evidenceRef: "README.md" }],
    uncertainties: [{ text: "未执行构建" }],
  },
  capturedAt: "2026-11-05T03:00:00Z",
  sourceRunId: "run-1",
  threadId: "thread-verified",
  turnId: "turn-verified",
  cwd: "D:\\test-project",
  gitBaseline: { branch: "main", commit: "abc", dirty: false },
};
function fixture(start = initial) {
  let state = structuredClone(start);
  let stopped = false,
    loseCancel = false;
  const calls = [];
  const requestCloud = async (route, options = {}) => {
    calls.push({ route, ...options });
    if (route.startsWith("/api/agent/bindings?"))
      return {
        binding: {
          bindingId: "bound",
          revision: 2,
          enabled: true,
          workspaceId: "workspace",
          runnerId: "runner",
        },
      };
    if (route.startsWith("/api/agent/project/state"))
      return structuredClone(state);
    if (route.endsWith("/initialize") || route.endsWith("/refresh")) {
      state = {
        ...state,
        status: "queued",
        ready: false,
        activeRunId: "pending",
      };
      return structuredClone(state);
    }
    if (route.endsWith("/use-previous")) {
      state = { ...state, status: "ready", ready: true, stale: true };
      return structuredClone(state);
    }
    if (route === "/api/agent/execution/tools") {
      if (options.body.name === "codex_cancel_run") {
        if (loseCancel) {
          loseCancel = false;
          throw Error("停止回执未收到");
        }
        return { result: { status: "accepted" } };
      }
      if (options.body.name === "codex_get_run")
        return {
          result: {
            run: {
              runId: state.activeRunId,
              terminal: stopped,
              stopConfirmed: stopped,
              status: stopped ? "cancelled" : "cancel_requested",
            },
          },
        };
    }
    throw Error("unexpected " + route);
  };
  const requestLocal = async (route, options = {}) => {
    calls.push({ local: true, route, ...options });
    if (route === "/status")
      return { runnerId: "runner", connectionStatus: "online" };
    if (route === "/execution/context") return {};
    throw Error("unexpected local " + route);
  };
  return {
    calls,
    requestCloud,
    requestLocal,
    setState(value) {
      state = structuredClone(value);
    },
    loseCancelReceipt() {
      loseCancel = true;
    },
    stop() {
      stopped = true;
      state = { ...state, status: "failed", ready: false, error: "总结已停止" };
    },
  };
}
async function mount(f, extra = {}) {
  assert.equal(
    typeof ProjectSummaryPanel,
    "function",
    "Step7 project summary UI is exported",
  );
  const root = createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(
      React.createElement(ProjectSummaryPanel, {
        roomId: "room",
        userId: "alice",
        pages: [{ id: "section", title: "测试清单" }],
        requestCloud: f.requestCloud,
        requestLocal: f.requestLocal,
        ...extra,
      }),
    ),
  );
  if (extra.autoSelect !== false)
    await act(async () => {
      const select = document.querySelector('[aria-label="总结项目"]');
      select.value = (extra.pages ?? [{ id: "section" }])[0].id;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  return () => act(async () => root.unmount());
}

test("opening step7 waits for an explicit project selection before dispatch", async () => {
  const f = fixture(),
    close = await mount(f, { autoSelect: false });
  try {
    assert.equal(document.querySelector('[aria-label="总结项目"]').value, "");
    assert.equal(f.calls.length, 0);
  } finally {
    await close();
  }
});

test("selecting a project initializes once and the finished summary shows verified sources", async () => {
  const f = fixture();
  let chosen;
  let close = await mount(f, { onOpenChat: (id) => (chosen = id) });
  try {
    const init = f.calls.filter((c) => c.route.endsWith("/initialize"));
    assert.equal(init.length, 1);
    assert.equal(init[0].body.bindingRevision, 2);
    assert.ok(
      f.calls.findIndex((c) => c.route === "/execution/context") <
        f.calls.indexOf(init[0]),
    );
    assert.match(document.body.textContent, /等待项目空闲|等待总结/);
    f.setState(ready);
    await click("刷新总结状态");
    assert.match(document.body.textContent, /项目包含已验证的安装文档/);
    assert.match(document.body.textContent, /thread-verified/);
    assert.match(document.body.textContent, /来源：README.md/);
    assert.match(document.body.textContent, /未执行构建/);
    assert.equal(document.querySelector('a[href^="codex:"]'), null);
    await click("使用摘要聊天");
    assert.equal(chosen, "section");
    await close();
    close = await mount(f, { onOpenChat() {} });
    assert.equal(
      f.calls.filter((c) => c.route.endsWith("/initialize")).length,
      1,
      "remount only reads persisted ready state",
    );
  } finally {
    await close();
  }
});
test("a failed refresh shows its prior summary as stale until explicitly adopted", async () => {
  const f = fixture({
      ...ready,
      status: "failed",
      ready: false,
      stale: true,
      error: "总结失败",
    }),
    close = await mount(f, { onOpenChat() {} });
  try {
    assert.match(document.body.textContent, /上次摘要/);
    assert.match(document.body.textContent, /总结失败/);
    assert.equal(button("使用摘要聊天")?.disabled, true);
    await click("使用上次摘要");
    const call = f.calls.find((c) => c.route.endsWith("/use-previous"));
    assert.equal(call.body.expectedSummaryRevision, 1);
    assert.equal(call.body.bindingRevision, 2);
    assert.match(document.body.textContent, /正在使用上次摘要/);
    await click("重新总结");
    assert.equal(f.calls.filter((c) => c.route.endsWith("/refresh")).length, 1);
    assert.equal(button("重新总结").disabled, true);
  } finally {
    await close();
  }
});
test("a missing binding does not start a summary", async () => {
  const f = fixture();
  f.requestCloud = async (route) => {
    f.calls.push({ route });
    return { binding: null };
  };
  const close = await mount(f);
  try {
    assert.match(document.body.textContent, /第 3 步/);
    assert.equal(f.calls.length, 1);
  } finally {
    await close();
  }
});
test("switching project ignores an earlier in-flight binding read", async () => {
  const f = fixture(ready);
  let resolveFirst;
  const base = f.requestCloud;
  f.requestCloud = (route, options) =>
    route.includes("sectionId=first")
      ? new Promise((resolve) => (resolveFirst = resolve))
      : base(route, options);
  const close = await mount(f, {
    pages: [
      { id: "first", title: "旧项目" },
      { id: "second", title: "新项目" },
    ],
  });
  try {
    await act(async () => {
      const select = document.querySelector('[aria-label="总结项目"]');
      select.value = "second";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await act(async () =>
      resolveFirst({
        binding: { bindingId: "old", revision: 1, enabled: true },
      }),
    );
    assert.match(document.body.textContent, /项目包含已验证的安装文档/);
    assert.equal(
      f.calls.some((c) => c.route.includes("bindingId=old")),
      false,
    );
  } finally {
    await close();
  }
});

test("stopping a summary reuses its request and waits for native stop confirmation", async () => {
  const f = fixture({
    ...initial,
    status: "running",
    activeRunId: "summary-active",
    error: "总结等待本机审批。",
  });
  f.loseCancelReceipt();
  const close = await mount(f);
  try {
    await click("停止总结");
    assert.match(document.body.textContent, /停止回执未收到/);
    assert.equal(button("重新总结").disabled, true);
    await click("停止总结");
    const stops = f.calls.filter((c) => c.body?.name === "codex_cancel_run");
    assert.equal(stops.length, 2);
    assert.equal(
      stops[0].body.arguments.requestId,
      stops[1].body.arguments.requestId,
    );
    assert.equal(stops[0].body.arguments.runId, "summary-active");
    assert.equal(stops[0].body.bindingId, "bound");
    assert.match(document.body.textContent, /等待本机确认/);
    assert.equal(button("重新总结").disabled, true);
    f.stop();
    await click("刷新总结状态");
    assert.match(document.body.textContent, /已确认停止总结/);
    assert.equal(button("重新总结").disabled, false);
  } finally {
    await close();
  }
});
