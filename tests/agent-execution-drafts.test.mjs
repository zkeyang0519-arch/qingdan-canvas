import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const dom = new JSDOM('<div id="root"></div>', {
  url: "https://draft-fixture.test",
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
mkdirSync(resolve(".tmp"), { recursive: true });
const dir = mkdtempSync(resolve(".tmp/execution-drafts-"));
await build({
  entryPoints: ["src/agent/ExecutionPanel.jsx"],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile: resolve(dir, "ui.mjs"),
  logLevel: "silent",
});
const { default: ExecutionPanel } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
assert.ok(dir.startsWith(resolve(".tmp") + sep));
rmSync(dir, { recursive: true, force: true });
let root;
const storageSetItem = window.Storage.prototype.setItem;
test.beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
test.afterEach(async () => {
  window.Storage.prototype.setItem = storageSetItem;
  if (root) await act(async () => root.unmount());
  root = null;
});
test.after(() => dom.window.close());
const field = (label) => document.querySelector(`[aria-label="${label}"]`);
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (b) =>
      b.textContent.trim() === label || b.getAttribute("aria-label") === label,
  );
async function click(label) {
  const b = button(label);
  assert.ok(b, label);
  assert.equal(b.disabled, false, label);
  await act(async () => b.click());
}
async function edit(label, value) {
  const el = field(label);
  assert.ok(el, label);
  assert.equal(el.disabled, false, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function choose(label, value) {
  await act(async () => {
    field(label).value = value;
    field(label).dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
async function until(check) {
  for (let i = 0; i < 40; i++) {
    let ready;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
      ready = check();
    });
    if (ready) return;
  }
  assert.fail(document.body.textContent);
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture() {
  const calls = [];
  let revision = 1,
    turnId = "turn-1",
    bindingGate = null,
    followGate = null;
  const run = () => ({
    runId: "run",
    kind: "task",
    status: "running",
    threadId: "thread",
    turnId,
    terminal: false,
    stopConfirmed: false,
  });
  const requestCloud = async (route, options = {}) => {
    calls.push({
      route,
      ...options,
      body: options.body && structuredClone(options.body),
    });
    if (route === "/api/agent/devices")
      return {
        devices: [
          {
            runnerId: "runner",
            status: "online",
            workspaces: [{ workspaceId: "workspace", name: "fixture" }],
          },
        ],
      };
    if (route.startsWith("/api/agent/bindings")) {
      if (bindingGate) await bindingGate.promise;
      const page = new URL(route, "https://fixture.test").searchParams.get(
        "sectionId",
      );
      return {
        binding: {
          bindingId: "binding-" + page,
          runnerId: "runner",
          workspaceId: "workspace",
          revision,
          enabled: true,
        },
      };
    }
    if (route.includes("/runs?")) return { runs: [run()] };
    if (route.endsWith("/tools")) {
      if (options.body.name === "codex_list_projects")
        return { result: { projects: [] } };
      if (options.body.name === "codex_get_run")
        return {
          result: { run: run(), events: [], nextAfterSeq: 0, hasMore: false },
        };
      if (options.body.name === "codex_continue_run" && followGate)
        await followGate.promise;
      return { result: { status: "accepted", runId: "run" } };
    }
    throw Error("unexpected " + route);
  };
  return {
    calls,
    requestCloud,
    requestLocal: async () => ({
      runnerId: "runner",
      connectionStatus: "online",
    }),
    setRevision(value) {
      revision = value;
    },
    setTurn(value) {
      turnId = value;
    },
    delayBinding() {
      bindingGate = deferred();
      return bindingGate;
    },
    delayFollow() {
      followGate = deferred();
      return followGate;
    },
  };
}
async function render(f, extra = {}) {
  root ||= createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(
      React.createElement(ExecutionPanel, {
        userId: "alice",
        roomId: "canvas",
        pages: [{ id: "one" }, { id: "two" }],
        initialPageId: "one",
        requestCloud: f.requestCloud,
        requestLocal: f.requestLocal,
        ...extra,
      }),
    ),
  );
}
async function ready() {
  await until(
    () =>
      field("补充说明")?.disabled === false &&
      button("刷新状态")?.disabled === false,
  );
}
async function reopen(f, extra) {
  await act(async () => root.unmount());
  root = null;
  window.sessionStorage.clear();
  await render(f, extra);
  await ready();
}
const writes = (f) =>
  f.calls.filter(
    (c) =>
      c.method === "POST" &&
      !["codex_get_run", "codex_list_projects"].includes(c.body?.name),
  );

test("unsent task rows and followup survive a fresh UI session without execution POSTs", async () => {
  const f = fixture();
  await render(f);
  await ready();
  await edit("执行要求", "原执行要求");
  await edit("完成标准", "原完成标准");
  await click("添加待办");
  await edit("第 2 项执行要求", "第二项");
  await edit("第 2 项完成标准", "第二项标准");
  await edit("补充说明", "尚未发送的补充");
  await reopen(f);
  assert.equal(field("执行要求").value, "原执行要求");
  assert.equal(field("完成标准").value, "原完成标准");
  assert.equal(field("第 2 项执行要求").value, "第二项");
  assert.equal(field("补充说明").value, "尚未发送的补充");
  await click("添加待办");
  await edit("第 3 项执行要求", "第三项");
  assert.equal(
    field("第 2 项执行要求").value,
    "第二项",
    "restored row IDs remain distinct",
  );
  assert.equal(writes(f).length, 0);
});

test("hot account and project switches cannot expose or move another scope's drafts", async () => {
  const f = fixture();
  await render(f);
  await ready();
  await edit("执行要求", "alice one");
  await edit("补充说明", "alice follow");
  await render(f, { userId: "bob" });
  await ready();
  assert.equal(field("执行要求").value, "");
  assert.equal(field("补充说明").value, "");
  await edit("执行要求", "bob one");
  await render(f);
  await ready();
  assert.equal(field("执行要求").value, "alice one");
  await choose("清单关联", "two");
  await ready();
  assert.equal(field("执行要求").value, "");
  assert.equal(field("补充说明").value, "");
  await choose("清单关联", "one");
  await ready();
  assert.equal(field("执行要求").value, "alice one");
  assert.equal(field("补充说明").value, "alice follow");
  assert.equal(writes(f).length, 0);
});

test("binding revisions and execution turns keep distinct drafts rather than retargeting old text", async () => {
  const f = fixture();
  await render(f);
  await ready();
  await edit("执行要求", "revision one");
  await edit("补充说明", "turn one");
  f.setRevision(2);
  await click("刷新状态");
  await ready();
  assert.equal(field("执行要求").value, "");
  assert.equal(field("补充说明").value, "");
  f.setRevision(1);
  await click("刷新状态");
  await ready();
  assert.equal(field("执行要求").value, "revision one");
  assert.equal(field("补充说明").value, "turn one");
  f.setTurn("turn-2");
  await click("刷新状态");
  await ready();
  assert.equal(field("补充说明").value, "");
  assert.equal(button("发送补充说明").disabled, true);
  f.setTurn("turn-1");
  await click("刷新状态");
  await ready();
  assert.equal(field("补充说明").value, "turn one");
  assert.equal(writes(f).length, 0);
});

test("unresolved binding disables draft editing and never writes a null-binding recovery key", async () => {
  const f = fixture(),
    gate = f.delayBinding();
  try {
    await render(f);
    assert.equal(field("执行要求").disabled, true);
    assert.equal(field("完成标准").disabled, true);
    assert.equal(window.localStorage.length, 0);
  } finally {
    await act(async () => gate.resolve());
  }
  await ready();
  await edit("执行要求", "binding verified");
  await reopen(f);
  assert.equal(field("执行要求").value, "binding verified");
});

test("late followup ACK cannot clear another account's draft and successful current ACK clears durably", async () => {
  const f = fixture();
  await render(f);
  await ready();
  await edit("补充说明", "alice original");
  const gate = f.delayFollow();
  await click("发送补充说明");
  await render(f, { userId: "bob" });
  await ready();
  await edit("补充说明", "bob keep");
  await act(async () => gate.resolve());
  await until(() => button("刷新状态")?.disabled === false);
  assert.equal(field("补充说明").value, "bob keep");
  await reopen(f, { userId: "bob" });
  assert.equal(field("补充说明").value, "bob keep");
  await click("发送补充说明");
  await until(() => field("补充说明")?.value === "");
  await reopen(f, { userId: "bob" });
  assert.equal(field("补充说明").value, "");
});

test("denied draft storage shows a warning while read and stop controls remain usable", async () => {
  const f = fixture();
  await render(f);
  await ready();
  window.Storage.prototype.setItem = () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  await edit("执行要求", "visible memory draft");
  assert.match(document.body.textContent, /无法保存|存储|关闭页面/);
  await click("刷新状态");
  await ready();
  assert.equal(field("执行要求").value, "visible memory draft");
  assert.equal(button("请求停止").disabled, false);
  await click("请求停止");
  assert.equal(
    writes(f).filter((c) => c.body?.name === "codex_cancel_run").length,
    1,
  );
});
