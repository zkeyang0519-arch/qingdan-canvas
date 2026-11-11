import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserLocks } from "./fixtures/browser-locks.mjs";

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
const dir = mkdtempSync(resolve("node_modules/.cache/diagnostics-ui-"));
await build({
  entryPoints: [resolve("src/agent/DiagnosisPanel.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile: resolve(dir, "ui.mjs"),
});
const { default: DiagnosisPanel } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
const button = (name) =>
  [...document.querySelectorAll("button")].find(
    (el) =>
      el.textContent.trim() === name || el.getAttribute("aria-label") === name,
  );
const click = async (node) => {
  assert.ok(node);
  assert.equal(node.disabled, false);
  await act(async () => node.click());
};
const body = () => document.body.textContent;
let root;
test.beforeEach(() => {
  window.localStorage.clear();
  navigator.locks = browserLocks();
  root = createRoot(document.getElementById("root"));
});
test.afterEach(async () => {
  await act(async () => root.unmount());
});
const defaults = {
  roomId: "room",
  userId: "alice",
  page: { id: "section", title: "当前项目" },
};
const render = async (props) =>
  act(async () =>
    root.render(React.createElement(DiagnosisPanel, { ...defaults, ...props })),
  );
function fixture() {
  const calls = [],
    opened = [];
  const state = {
    local: {
      paired: true,
      ownerId: "alice",
      runnerId: "runner",
      enabled: false,
      connectionStatus: "offline",
      lastHeartbeatAt: "2026-11-05T00:00:00Z",
      workspaces: [],
    },
    diagnostics: {
      service: { version: "0.2.0", nodeVersion: "24.11.0" },
      codex: { version: "0.131.0", authenticated: true, available: true },
      checkedAt: "2026-11-05T01:00:00Z",
    },
    binding: {
      bindingId: "binding",
      revision: 3,
      runnerId: "runner",
      workspaceId: "workspace",
      enabled: true,
    },
    runs: [
      {
        runId: "existing-run",
        bindingId: "binding",
        workspaceId: "workspace",
        sourceBacked: true,
        kind: "task",
        status: "reconciliation_required",
        terminal: false,
        stopConfirmed: false,
        threadId: "thread",
        turnId: "turn",
        createdAt: "2026-11-05T00:01:00Z",
        updatedAt: "2026-11-05T00:02:00Z",
        queue: {
          managed: true,
          revision: 1,
          phase: "running",
          currentIndex: 0,
          canResume: false,
        },
        batch: {
          items: [{ taskId: "task", text: "整理项目文件", status: "running" }],
        },
      },
    ],
  };
  return {
    state,
    calls,
    opened,
    onOpenRun: (target) => opened.push(target),
    requestLocal: async (route, options = {}) => {
      calls.push({ route, ...options });
      if (route === "/diagnostics") return state.diagnostics;
      if (route === "/reconnect" || route === "/connection")
        state.local = {
          ...state.local,
          enabled: true,
          connectionStatus: "online",
        };
      if (route === "/status" && state.statusError)
        throw Error(state.statusError);
      return { ...state.local };
    },
    requestCloud: async (route, options = {}) => {
      calls.push({ route, ...options });
      if (route.startsWith("/api/agent/bindings?"))
        return { binding: state.binding };
      if (route.startsWith("/api/agent/execution/runs?")) {
        if (state.historyError) throw Error(state.historyError);
        return { runs: state.runs };
      }
      throw Error(`Unexpected route: ${route}`);
    },
  };
}

test("opening diagnostics reads versions and recovery history without reconnecting or submitting work", async () => {
  const f = fixture();
  await render(f);
  assert.match(body(), /24\.11\.0/);
  assert.match(body(), /0\.131\.0/);
  assert.match(body(), /0\.2\.0/);
  assert.match(body(), /电脑已暂时断开/);
  assert.match(body(), /需要核对本机进度/);
  assert.match(body(), /整理项目文件/);
  assert.deepEqual(
    f.calls.filter((call) => call.method === "POST"),
    [],
  );
  await click(button("查看这次执行"));
  assert.deepEqual(f.opened, [
    {
      sectionId: "section",
      bindingId: "binding",
      bindingRevision: 3,
      runId: "existing-run",
    },
  ]);
  assert.deepEqual(
    f.calls.filter((call) => call.method === "POST"),
    [],
  );
});

test("historical summaries open a supported execution view and stop the selected original run", async () => {
  const f = fixture(),
    base = f.requestCloud;
  let lost = true;
  const run = {
    ...f.state.runs[0],
    runId: "orphan-summary",
    kind: "summary",
    sourceBacked: false,
    batch: undefined,
    queue: undefined,
  };
  f.state.runs = [run];
  f.requestCloud = async (route, options = {}) => {
    if (route === "/api/agent/devices") {
      f.calls.push({ route, ...options });
      return { devices: [] };
    }
    if (route === "/api/agent/execution/tools") {
      f.calls.push({ route, ...options });
      if (options.body.name === "codex_list_projects")
        return { result: { projects: [] } };
      if (options.body.name === "codex_get_run")
        return { result: { run, events: [], nextCursor: null } };
      if (options.body.name === "codex_cancel_run") {
        if (lost) {
          lost = false;
          throw Error("lost cancel ACK");
        }
        return { result: { status: "accepted" } };
      }
      throw Error("unexpected tool " + options.body.name);
    }
    return base(route, options);
  };
  await render(f);
  await click(button("查看这次总结"));
  assert.match(body(), /核对原总结执行/);
  assert.equal(button("提交批次"), undefined);
  assert.equal(button("只总结项目"), undefined);
  assert.equal(f.opened.length, 0);
  await click(button("请求停止"));
  await click(button("关闭总结执行"));
  await click(button("查看这次总结"));
  await click(button("请求停止"));
  const cancellations = f.calls.filter(
    (c) => c.body?.name === "codex_cancel_run",
  );
  assert.equal(cancellations.length, 2);
  assert.equal(cancellations[0].body.arguments.runId, "orphan-summary");
  assert.deepEqual(cancellations[0].body, cancellations[1].body);
  assert.ok(
    f.calls.every(
      (c) => !["codex_create_run", "codex_continue_run"].includes(c.body?.name),
    ),
  );
});

test("explicit reconnect refreshes observed state and never restarts an uncertain run", async () => {
  const f = fixture();
  await render(f);
  await click(button("继续连接"));
  assert.match(body(), /电脑在线/);
  assert.match(body(), /需要核对本机进度/);
  assert.deepEqual(
    f.calls
      .filter((call) => call.method === "POST")
      .map(({ route, body }) => ({ route, body })),
    [{ route: "/connection", body: { enabled: true } }],
  );
  await click(button("重新连接"));
  assert.deepEqual(
    f.calls.filter((call) => call.method === "POST").map((call) => call.route),
    ["/connection", "/reconnect"],
  );
});

test("failed probes remove a previously online badge and expose an actionable failure", async () => {
  const f = fixture();
  f.state.local = {
    ...f.state.local,
    enabled: true,
    connectionStatus: "online",
  };
  await render(f);
  assert.match(body(), /电脑在线/);
  f.state.statusError = "本机服务没有响应";
  f.state.historyError = "无法读取执行记录";
  await click(button("重新检查"));
  assert.doesNotMatch(body(), /电脑在线/);
  assert.match(body(), /本机服务没有响应/);
  assert.match(body(), /无法读取执行记录/);
  assert.equal(button("重新连接")?.disabled ?? true, true);
  assert.equal(button("查看这次执行"), undefined);
});

test("pending native approval stays attached to its existing run after reconnect", async () => {
  const f = fixture();
  f.state.runs[0] = {
    ...f.state.runs[0],
    status: "waiting_approval",
    pendingRequests: [
      {
        requestId: "approval",
        runId: "existing-run",
        threadId: "thread",
        turnId: "turn",
        kind: "approval",
        responseStatus: "pending",
      },
    ],
  };
  await render(f);
  assert.match(body(), /等待.*审批/);
  await click(button("继续连接"));
  await click(button("查看这次执行"));
  assert.equal(f.opened[0].runId, "existing-run");
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});

test("a stale account response cannot replace the next account's diagnostics or execution history", async () => {
  const f = fixture();
  let release;
  const delayed = async (route, options) =>
    options.accountId === "alice" && route === "/diagnostics"
      ? new Promise((resolve) => {
          release = () =>
            resolve({
              ...f.state.diagnostics,
              codex: {
                ...f.state.diagnostics.codex,
                version: "private-old-version",
              },
            });
        })
      : f.requestLocal(route, options);
  await render({ ...f, requestLocal: delayed });
  const g = fixture();
  g.state.runs = [];
  await render({ ...g, userId: "bob" });
  await act(async () => release());
  assert.doesNotMatch(body(), /private-old-version|整理项目文件/);
  assert.match(body(), /还没有执行记录/);
});

test("failed reconnect displays the failure without creating an execution or reporting a successful recovery", async () => {
  const f = fixture();
  const requestLocal = async (route, options) => {
    if (route === "/reconnect") throw Error("连接被拒绝，请重新绑定电脑");
    return f.requestLocal(route, options);
  };
  await render({ ...f, requestLocal });
  await click(button("重新连接"));
  assert.match(
    document.querySelector('[role="alert"]').textContent,
    /连接被拒绝/,
  );
  assert.doesNotMatch(body(), /电脑在线|已恢复执行/);
  assert.ok(f.calls.every((call) => call.method !== "POST"));
});

test("unknown Codex login state stays unknown when installation checks fail", async () => {
  const f = fixture();
  f.state.diagnostics.codex = {
    available: false,
    authenticated: null,
    version: "9.8.7",
    error: "无法读取本机登录状态",
  };
  await render(f);
  assert.match(body(), /9\.8\.7/);
  assert.match(body(), /尚未确认/);
  assert.match(body(), /无法读取本机登录状态/);
  assert.doesNotMatch(body(), /尚未登录|请先完成本机 Codex 登录/);
});

test("late history from another project cannot replace the selected project's recovery target", async () => {
  const f = fixture();
  let release;
  const requestCloud = async (route, options) =>
    route.includes("/execution/runs?")
      ? new Promise((resolve) => {
          release = () => resolve({ runs: f.state.runs });
        })
      : f.requestCloud(route, options);
  await render({ ...f, requestCloud });
  const g = fixture();
  g.state.binding = {
    ...g.state.binding,
    bindingId: "other-binding",
    revision: 8,
  };
  g.state.runs = [
    {
      ...g.state.runs[0],
      runId: "other-run",
      bindingId: "other-binding",
      batch: { items: [{ text: "另一个项目" }] },
    },
  ];
  await render({ ...g, page: { id: "other-section", title: "其他项目" } });
  await act(async () => release());
  assert.doesNotMatch(body(), /整理项目文件/);
  assert.match(body(), /另一个项目/);
  await click(button("查看这次执行"));
  assert.deepEqual(g.opened, [
    {
      sectionId: "other-section",
      bindingId: "other-binding",
      bindingRevision: 8,
      runId: "other-run",
    },
  ]);
});

test("a late binding response after an account change cannot issue another account's history read", async () => {
  const f = fixture();
  let release;
  const requestCloud = async (route, options) => {
    if (route.includes("/bindings?"))
      return new Promise((resolve) => {
        release = () => resolve({ binding: f.state.binding });
      });
    return f.requestCloud(route, options);
  };
  await render({ ...f, requestCloud });
  const g = fixture();
  g.state.binding = null;
  await render({ ...g, userId: "bob" });
  await act(async () => release());
  assert.equal(
    f.calls.filter(({ route }) => route.includes("/execution/runs?")).length,
    0,
  );
  assert.doesNotMatch(body(), /整理项目文件/);
});

test("a reconnect completing after switching project cannot refresh or mutate the next project", async () => {
  const f = fixture();
  let release;
  const requestLocal = async (route, options) =>
    route === "/reconnect"
      ? new Promise((resolve) => {
          release = resolve;
        })
      : f.requestLocal(route, options);
  await render({ ...f, requestLocal });
  await click(button("重新连接"));
  const before = f.calls.length;
  const g = fixture();
  g.state.runs = [];
  await render({ ...g, page: { id: "next-project", title: "新项目" } });
  await act(async () => release({ paired: true, connectionStatus: "online" }));
  assert.equal(f.calls.length, before);
  assert.doesNotMatch(body(), /电脑在线|连接请求已发出|整理项目文件/);
  assert.match(body(), /还没有执行记录/);
});
