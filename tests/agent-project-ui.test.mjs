import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserLocks } from "./fixtures/browser-locks.mjs";
import {
  createWorkspaceRequests,
  workspaceScope,
} from "../src/agent/workspace-state.js";
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
test.beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  globalThis.navigator.locks = browserLocks();
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/agent-project-ui-"));
await build({
  entryPoints: [resolve("src/agent/ProjectSummaryPanel.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
});
const { default: ProjectSummaryPanel } = await import(
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
  activeRunId: "run-1",
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

test("module progress shows project background, current work and next steps with coverage collapsed", async () => {
  const state = structuredClone(ready);
  state.sourceKind = "codex_history";
  state.summary = {
    overview: "基础编辑已具备，导出仍在推进。",
    completed: [],
    inProgress: [],
    pending: [],
    blockers: [],
    verification: [],
    uncertainties: [],
    background: {
      name: "离线清单",
      purpose: "管理个人项目待办",
      stage: "导出开发中",
    },
    modules: [
      {
        name: "导出",
        status: "partial",
        current: [
          { text: "JSON 已实现", evidenceRef: "codex:test/turn/answer" },
        ],
        remaining: [{ text: "CSV 尚未实现" }],
        nextSteps: [{ text: "P1 完成 CSV 并验证中文编码" }],
      },
    ],
    coverage: {
      totalRecords: 403,
      deliveredRecords: 403,
      threadCount: 52,
      failedThreadCount: 1,
      excludedForkCount: 0,
      missingFinalCount: 0,
      incompleteTurnCount: 2,
      partial: true,
    },
  };
  const close = await mount(fixture(state));
  try {
    assert.match(
      document.querySelector('[aria-label="项目背景"]').textContent,
      /离线清单.*管理个人项目待办.*导出开发中/,
    );
    const module = document.querySelector('[aria-label="模块：导出"]');
    for (const fragment of [
      "部分完成",
      "当前进度",
      "JSON 已实现",
      "剩余工作",
      "CSV 尚未实现",
      "下一步",
      "P1 完成 CSV",
    ])
      assert.ok(module.textContent.includes(fragment), fragment);
    const details = document.querySelector("details.agent-summary-source");
    assert.equal(details.open, false);
    assert.match(details.textContent, /403.*403/);
    assert.match(details.textContent, /覆盖缺口/);
    assert.match(
      document.querySelector('[aria-label="项目进度"]').textContent,
      /项目进度/,
    );
    assert.equal(document.querySelector('[aria-label="摘要已完成"]'), null);
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
test("receiving a finished summary keeps polling until its delayed result is visible", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture({ ...initial, status: "finalizing", activeRunId: "run-1" });
  const close = await mount(f, { onOpenChat() {} });
  try {
    assert.match(document.body.textContent, /正在接收摘要/);
    assert.ok(button("停止等待"));
    assert.equal(button("重新总结").disabled, true);
    assert.equal(button("使用摘要聊天").disabled, true);
    f.setState(ready);
    await act(async () => t.mock.timers.tick(2000));
    assert.match(document.body.textContent, /项目包含已验证的安装文档/);
    assert.equal(button("使用摘要聊天").disabled, false);
    assert.equal(
      f.calls.filter(
        (c) => c.route.endsWith("/initialize") || c.route.endsWith("/refresh"),
      ).length,
      0,
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

const summaryBinding = {
  bindingId: "bound",
  revision: 2,
  enabled: true,
  runnerId: "runner",
  workspaceId: "workspace",
};
const summaryScope = () =>
  workspaceScope({
    accountId: "alice",
    canvasId: "room",
    sectionId: "section",
    binding: summaryBinding,
  });
const saveRefresh = () =>
  createWorkspaceRequests(summaryScope()).prepare(
    "summary:refresh",
    (requestId) => ({
      path: "/api/agent/project/refresh",
      method: "POST",
      body: {
        requestId,
        bindingId: "bound",
        bindingRevision: 2,
        expectedActiveRunId: "run-1",
        expectedSummaryRevision: 1,
      },
    }),
  );

test("restored unknown summary operation only reads and explicit retry preserves its exact payload", async () => {
  const saved = await saveRefresh();
  window.sessionStorage.clear();
  const f = fixture(ready),
    close = await mount(f, { autoSelect: false, initialPageId: "section" });
  try {
    assert.equal(
      f.calls.filter(
        (c) => c.method === "POST" && c.body?.name !== "codex_get_run",
      ).length,
      0,
    );
    assert.ok(button("核对原总结操作"));
    assert.ok(button("重试原总结操作"));
    await click("核对原总结操作");
    assert.equal(
      f.calls.filter(
        (c) => c.method === "POST" && c.body?.name !== "codex_get_run",
      ).length,
      0,
    );
    await click("重试原总结操作");
    assert.deepEqual(
      f.calls.find((c) => c.route.endsWith("/refresh")).body,
      saved.request.body,
    );
  } finally {
    await close();
  }
});

test("restored uninitialized project never auto starts and another account cannot see its pending action", async () => {
  await saveRefresh();
  const f = fixture();
  const close = await mount(f, {
    autoSelect: false,
    initialPageId: "section",
    userId: "bob",
  });
  try {
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
    assert.equal(button("重试原总结操作"), undefined);
  } finally {
    await close();
  }
});

test("reconciliation keeps stop available when Web Locks fail and never offers previous adoption", async () => {
  const f = fixture({
    ...ready,
    status: "reconciliation_required",
    ready: false,
    stale: true,
    activeRunId: "uncertain",
  });
  const close = await mount(f);
  globalThis.navigator.locks = undefined;
  try {
    assert.equal(button("重新总结").disabled, true);
    assert.equal(button("使用上次摘要"), undefined);
    await click("停止总结");
    assert.equal(
      f.calls.find((c) => c.body?.name === "codex_cancel_run").body.arguments
        .runId,
      "uncertain",
    );
    assert.match(document.body.textContent, /浏览器|保存|协调/);
  } finally {
    await close();
  }
});

test("stop discovers unknown planned target through inspect-only GET without starting or checkpointing", async () => {
  await saveRefresh();
  const f = fixture();
  const base = f.requestCloud;
  let inspect = false;
  f.requestCloud = async (route, options) => {
    if (route.includes("inspectOnly=true") && inspect) {
      f.calls.push({ route, ...options });
      return {
        ...initial,
        status: "queued",
        activeRunId: "planned",
        pendingLaunch: { runId: "planned", operationId: "op" },
      };
    }
    return base(route, options);
  };
  const close = await mount(f, { autoSelect: false, initialPageId: "section" });
  inspect = true;
  globalThis.navigator.locks = undefined;
  try {
    await click("停止总结");
    const writes = f.calls.filter((c) => c.method === "POST");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.name, "codex_cancel_run");
    assert.equal(writes[0].body.arguments.runId, "planned");
  } finally {
    await close();
  }
});

test("fresh refresh sends both CAS values", async () => {
  const f = fixture(ready);
  let close = await mount(f);
  const base = f.requestCloud;
  f.requestCloud = base;
  try {
    await click("重新总结");
    const body = f.calls.find((c) => c.route.endsWith("/refresh")).body;
    assert.equal(body.expectedSummaryRevision, 1);
    assert.equal(body.expectedActiveRunId, "run-1");
  } finally {
    await close();
  }
});

test("two summary pages retain one exact refresh request after a lost acknowledgement", async () => {
  const f = fixture(ready),
    base = f.requestCloud;
  f.requestCloud = async (route, options) => {
    if (route.endsWith("/refresh")) {
      f.calls.push({ route, ...options });
      throw Error("lost acknowledgement");
    }
    return base(route, options);
  };
  const close = await mount(f);
  const host = document.createElement("div");
  document.body.append(host);
  const second = createRoot(host);
  try {
    await act(async () =>
      second.render(
        React.createElement(ProjectSummaryPanel, {
          roomId: "room",
          userId: "alice",
          pages: [{ id: "section" }],
          initialPageId: "section",
          requestCloud: f.requestCloud,
          requestLocal: f.requestLocal,
        }),
      ),
    );
    await click("重新总结");
    const retry = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "重试原总结操作",
    );
    assert.ok(retry);
    await act(async () => retry.click());
    const writes = f.calls.filter((c) => c.route.endsWith("/refresh"));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].body, writes[1].body);
  } finally {
    await act(async () => second.unmount());
    host.remove();
    await close();
  }
});

test("an authoritative CAS rejection clears the rejected request and reads the new revision", async () => {
  const f = fixture(ready),
    base = f.requestCloud;
  f.requestCloud = async (route, options) => {
    if (route.endsWith("/refresh")) {
      f.calls.push({ route, ...options });
      f.setState({ ...ready, summaryRevision: 2, activeRunId: "other-page" });
      throw Object.assign(Error("项目摘要已变化，请刷新后重新操作。"), {
        status: 409,
      });
    }
    return base(route, options);
  };
  const close = await mount(f);
  try {
    await click("重新总结");
    assert.ok(!button("重试原总结操作"));
    assert.match(document.body.textContent, /第 2 版/);
    assert.equal(button("重新总结").disabled, false);
  } finally {
    await close();
  }
});

test("a durable pre-run seal resolves the matching browser operation without pretending native stop confirmation", async () => {
  const original = await saveRefresh(),
    f = fixture({
      ...initial,
      status: "queued",
      activeRunId: "planned",
      pendingLaunch: {
        runId: "planned",
        operationId: "create",
        projectRequestId: original.requestId,
      },
    }),
    base = f.requestCloud;
  f.requestCloud = async (route, options) => {
    if (options?.body?.name === "codex_cancel_run") {
      f.calls.push({ route, ...options });
      const sealedLaunch = {
        runId: "planned",
        operationId: "create",
        projectRequestId: original.requestId,
        sealedAt: new Date().toISOString(),
      };
      f.setState({
        ...initial,
        status: "failed",
        activeRunId: "planned",
        sealedLaunch,
      });
      return { result: { status: "accepted", sealedLaunch } };
    }
    return base(route, options);
  };
  const close = await mount(f, { initialPageId: "section", autoSelect: false });
  try {
    await click("停止总结");
    assert.match(document.body.textContent, /已封存原总结启动/);
    assert.doesNotMatch(document.body.textContent, /已确认停止总结/);
    assert.ok(!button("重试原总结操作"));
    assert.equal(button("重新总结").disabled, false);
  } finally {
    await close();
  }
});

test("unreadable browser storage blocks initialization while retaining inspect and safe stop", async () => {
  const get = window.Storage.prototype.getItem;
  window.Storage.prototype.getItem = function () {
    throw Error("storage unavailable");
  };
  const f = fixture({ ...initial, status: "running", activeRunId: "original" });
  let close;
  try {
    close = await mount(f);
    assert.equal(
      f.calls.some((c) => c.route.endsWith("/initialize")),
      false,
    );
    await click("停止总结");
    assert.equal(
      f.calls.find((c) => c.body?.name === "codex_cancel_run").body.arguments
        .runId,
      "original",
    );
  } finally {
    window.Storage.prototype.getItem = get;
    await close?.();
  }
});

test("an explicit selection does not authorize automatic initialization after switching account", async () => {
  const f = fixture(),
    root = createRoot(document.getElementById("root"));
  const render = (userId) =>
    act(async () =>
      root.render(
        React.createElement(ProjectSummaryPanel, {
          userId,
          roomId: "room",
          pages: [{ id: "section" }],
          requestCloud: f.requestCloud,
          requestLocal: f.requestLocal,
        }),
      ),
    );
  try {
    await render("alice");
    await act(async () => {
      const select = document.querySelector('[aria-label="总结项目"]');
      select.value = "section";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.equal(
      f.calls.filter((c) => c.route.endsWith("/initialize")).length,
      1,
    );
    f.setState(initial);
    await render("bob");
    assert.equal(
      f.calls.filter((c) => c.route.endsWith("/initialize")).length,
      1,
      "new account needs its own explicit selection",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test("binding replacement during confirmation does not turn the previous selection into a new launch", async () => {
  const f = fixture(),
    base = f.requestCloud;
  let bindings = 0;
  f.requestCloud = async (route, options) => {
    const result = await base(route, options);
    if (route.startsWith("/api/agent/bindings?") && ++bindings > 1)
      return {
        binding: {
          ...summaryBinding,
          revision: 3,
          workspaceId: "new-directory",
        },
      };
    return result;
  };
  const close = await mount(f);
  try {
    assert.equal(
      f.calls.some((c) => c.method === "POST"),
      false,
    );
    assert.equal(button("开始总结").disabled, false);
  } finally {
    await close();
  }
});
