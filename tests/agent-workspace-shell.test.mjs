import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
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
  sessionStorage: dom.window.sessionStorage,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/workspace-shell-"));
const mocks = `import React,{useEffect} from 'react';
export const localRunnerRequest=async()=>({connectionStatus:'online',paired:true});
export const batchStatusLabel=run=>run?.status||'待执行';
export default function Panel(props){
 const page=props.pages?.[0]; const kind=KIND;
 if(kind==='ChatPanel')return React.createElement('section',{'data-chat':page.id},React.createElement('textarea',{'aria-label':'测试聊天草稿'}),React.createElement('button',{onClick:props.onTasksSaved},'模拟保存待办'),props.memoryOpen&&React.createElement('span',null,'记忆已打开'));
 if(kind==='ChecklistPanel')return React.createElement('section',{'data-checklist':page.id,'data-refresh':props.refreshToken},React.createElement('button',{onClick:()=>props.onOpenBatch({sectionId:page.id,bindingId:'binding-'+page.id,bindingRevision:1,runId:'run-'+page.id})},'模拟提交批次'));
 if(kind==='BatchPanel')return React.createElement('section',{'data-batch':page.id,'data-run':props.initialTarget?.runId||''},React.createElement('button',{onClick:()=>props.onRunChange({runId:'run-'+page.id,status:'running',batch:{items:[{taskId:'task',writeback:{status:'applied'}}]}})},'模拟完成回写'));
 if(kind==='PendingBatchNotice')return React.createElement('button',{onClick:()=>props.onOpen(props.target)},'处理其他项目请求');
 return React.createElement('span',null,'电脑设置内容');
}`;
await build({
  entryPoints: [resolve("src/agent/AgentWorkspace.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
  plugins: [
    {
      name: "panels",
      setup(b) {
        b.onResolve({ filter: /^react$/, namespace: "mock" }, (a) => ({
          path: a.path,
          external: true,
        }));
        b.onResolve(
          {
            filter:
              /\/(ChatPanel|ChecklistPanel|BatchPanel|DevicePanel|PendingBatchNotice)\.jsx$/,
          },
          (a) => ({
            path: a.path.match(/([^/]+)\.jsx$/)[1],
            namespace: "mock",
          }),
        );
        b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({
          contents: mocks.replace("KIND", JSON.stringify(a.path)),
          loader: "js",
        }));
      },
    },
  ],
});
const { default: AgentWorkspace } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
let root;
const pages = [
  { id: "a", title: "项目甲", tasks: [{ block: { done: false } }] },
  { id: "b", title: "项目乙", tasks: [] },
];
const opts = {
  roomId: "room",
  userId: "owner",
  pages,
  requestLocal: async () => ({ paired: true, connectionStatus: "online" }),
};
const button = (name) =>
  [...document.querySelectorAll("button")].find(
    (el) =>
      el.textContent.trim() === name || el.getAttribute("aria-label") === name,
  );
const click = async (el) => {
  assert.ok(el);
  await act(async () => el.click());
};
test.beforeEach(() => {
  sessionStorage.clear();
  root = createRoot(document.getElementById("root"));
});
test.afterEach(async () => {
  await act(async () => root.unmount());
});

test("formal workspace scopes every panel to the selected project and preserves chat node on mobile tab changes", async () => {
  await act(async () => root.render(React.createElement(AgentWorkspace, opts)));
  assert.equal(document.querySelector("[data-chat]").dataset.chat, "a");
  assert.equal(
    document.querySelector("[data-checklist]").dataset.checklist,
    "a",
  );
  const chat = document.querySelector("[data-chat]");
  await click(button("待办与执行"));
  await click(button("项目聊天"));
  assert.equal(document.querySelector("[data-chat]"), chat);
  await click(button("打开记忆"));
  assert.equal(document.querySelector("[data-chat]"), chat);
  assert.match(document.body.textContent, /记忆已打开/);
  await click(button("选择项目：项目乙"));
  assert.equal(document.querySelector("[data-chat]").dataset.chat, "b");
  assert.equal(
    document.querySelector("[data-checklist]").dataset.checklist,
    "b",
  );
});

test("opening Agent offers Codex sessions immediately, before opening computer settings", async () => {
  const routes = [];
  await act(async () =>
    root.render(
      React.createElement(AgentWorkspace, {
        ...opts,
        initialBatchTarget: {
          sectionId: "a",
          bindingId: "old",
          bindingRevision: 1,
          runId: "old-run",
        },
        requestLocal: async (route) => {
          routes.push(route);
          if (route.startsWith("/codex/sessions"))
            return {
              sessions: [
                {
                  threadId: "a",
                  title: "现有 Codex 会话",
                  cwd: "D:/existing",
                  updatedAt: 100,
                },
              ],
              nextCursor: null,
            };
          return { paired: false, connectionStatus: "unpaired" };
        },
      }),
    ),
  );
  assert.ok(
    document.querySelector('[role="dialog"][aria-label="选择 Codex 会话"]'),
  );
  assert.ok(button("选择会话：现有 Codex 会话"));
  assert.ok(routes.includes("/codex/sessions"));
  assert.equal(
    document.querySelector('[role="dialog"][aria-label="电脑与项目设置"]'),
    null,
  );
});

test("the connection chip distinguishes an account conflict and recovers when the current account connects", async () => {
  await act(async () =>
    root.render(
      React.createElement(AgentWorkspace, {
        ...opts,
        requestLocal: async () => {
          throw Object.assign(Error("这台电脑已绑定其他轻单账号。"), {
            code: "OWNER_MISMATCH",
          });
        },
      }),
    ),
  );
  assert.ok(button("电脑账号不匹配"));
  assert.equal(button("电脑未连接"), undefined);
  await act(async () => root.render(React.createElement(AgentWorkspace, opts)));
  assert.ok(button("电脑在线"));
  assert.equal(button("电脑账号不匹配"), undefined);
});

test("explicit navigation to a pending run opens progress without covering it with the session picker", async () => {
  sessionStorage.setItem(
    `qingdan.agent-workspace:${JSON.stringify(["owner", "room"])}:project`,
    JSON.stringify("b"),
  );
  await act(async () =>
    root.render(
      React.createElement(AgentWorkspace, {
        ...opts,
        startAtBatch: true,
        initialBatchTarget: {
          sectionId: "a",
          bindingId: "old",
          bindingRevision: 1,
          runId: "old-run",
        },
      }),
    ),
  );
  assert.equal(
    document.querySelector('[role="dialog"][aria-label="选择 Codex 会话"]'),
    null,
  );
  assert.equal(
    document.querySelector(".agent-workspace-columns").dataset.pane,
    "tasks",
  );
  assert.equal(document.querySelector("[data-batch]").dataset.run, "old-run");
});

test("selecting a session in an empty workspace survives the new checklist appearing before binding completes", async () => {
  const writes = [];
  function EmptyWorkspace() {
    const [created, setCreated] = React.useState([]);
    return React.createElement(AgentWorkspace, {
      ...opts,
      pages: created,
      onCreateProject: (title) => {
        setCreated([{ id: "new-page", title, tasks: [] }]);
        return "new-page";
      },
      requestLocal: async (route) => {
        if (route.startsWith("/codex/sessions"))
          return {
            sessions: [
              {
                threadId: "a",
                title: "源会话",
                cwd: "D:/site",
                updatedAt: 100,
              },
            ],
          };
        if (route === "/codex/select")
          return {
            runnerId: "runner",
            session: { threadId: "a" },
            workspace: { workspaceId: "workspace", name: "site" },
          };
        return { paired: true, enabled: true, connectionStatus: "online" };
      },
      requestCloud: async (route, options = {}) => {
        if (options.method === "POST") {
          writes.push(options.body);
          return { binding: { bindingId: "b", revision: 1 } };
        }
        // Yield to the UI so the asynchronously created page actually appears.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { binding: null };
      },
    });
  }
  await act(async () => root.render(React.createElement(EmptyWorkspace)));
  await click(button("选择会话：源会话"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sectionId, "new-page");
  assert.equal(
    document.querySelector('[role="dialog"][aria-label="选择 Codex 会话"]'),
    null,
  );
});
test("task save and a new writeback refresh checklist; repeated identical progress does not erase edits through repeated refreshes", async () => {
  await act(async () => root.render(React.createElement(AgentWorkspace, opts)));
  const token = () =>
    Number(document.querySelector("[data-checklist]").dataset.refresh);
  const initial = token();
  await click(button("模拟保存待办"));
  assert.equal(token(), initial + 1);
  await click(button("模拟完成回写"));
  const after = token();
  assert.ok(after > initial + 1);
  await click(button("模拟完成回写"));
  assert.equal(token(), after);
});
test("batch targets remain associated with their project and pending navigation returns to the exact originating run", async () => {
  const observed = [];
  await act(async () =>
    root.render(
      React.createElement(AgentWorkspace, {
        ...opts,
        onBatchTargetChange: (t) => observed.push(t),
      }),
    ),
  );
  await click(button("模拟提交批次"));
  assert.equal(document.querySelector("[data-batch]").dataset.run, "run-a");
  await click(button("选择项目：项目乙"));
  assert.equal(document.querySelector("[data-batch]").dataset.run, "");
  await click(button("处理其他项目请求"));
  assert.equal(document.querySelector("[data-chat]").dataset.chat, "a");
  assert.equal(document.querySelector("[data-batch]").dataset.run, "run-a");
  assert.equal(observed.at(-1).sectionId, "a");
});
test("submitting in another project retains the prior project request monitor", async () => {
  await act(async () => root.render(React.createElement(AgentWorkspace, opts)));
  await click(button("模拟提交批次"));
  await click(button("选择项目：项目乙"));
  await click(button("模拟提交批次"));
  assert.ok(button("处理其他项目请求"));
  await click(button("处理其他项目请求"));
  assert.equal(document.querySelector("[data-batch]").dataset.run, "run-a");
});
test("creating the first project opens one accessible form from the empty workspace", async () => {
  await act(async () =>
    root.render(
      React.createElement(AgentWorkspace, {
        ...opts,
        pages: [],
        onCreateProject: () => "new-page",
      }),
    ),
  );
  await click(document.querySelector(".agent-workspace-empty button"));
  assert.ok(document.querySelector('[role="dialog"][aria-label="新建项目"]'));
  assert.equal(
    document.querySelectorAll('[aria-label="新项目名称"]').length,
    1,
  );
});
test("changing account does not reuse another account project selection or batch target", async () => {
  await act(async () => root.render(React.createElement(AgentWorkspace, opts)));
  await click(button("选择项目：项目乙"));
  await click(button("模拟提交批次"));
  await act(async () =>
    root.render(
      React.createElement(AgentWorkspace, {
        ...opts,
        userId: "different-owner",
      }),
    ),
  );
  assert.equal(document.querySelector("[data-chat]").dataset.chat, "a");
  assert.equal(document.querySelector("[data-batch]").dataset.run, "");
});
test("new project is an explicit action, settings never submit a batch or initialize a model", async () => {
  const names = [];
  await act(async () =>
    root.render(
      React.createElement(AgentWorkspace, {
        ...opts,
        onCreateProject: (name) => {
          names.push(name);
          return "new-page";
        },
      }),
    ),
  );
  assert.equal(names.length, 0);
  await click(button("电脑与项目设置"));
  assert.match(document.body.textContent, /电脑设置内容/);
  assert.equal(document.querySelector("[data-batch]").dataset.run, "");
  await click(button("关闭电脑设置"));
  await click(button("新建项目"));
  const field = document.querySelector('[aria-label="新项目名称"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(field, "下周计划");
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await click(button("创建项目"));
  assert.deepEqual(names, ["下周计划"]);
});

test("settings recovery opens the exact saved execution without submitting a new batch", async () => {
  const calls = [];
  const requestCloud = async (route, options = {}) => {
    calls.push({ route, ...options });
    if (route.startsWith("/api/agent/bindings?"))
      return { binding: { bindingId: "bound-a", revision: 4, enabled: true } };
    if (route.includes("/execution/runs?"))
      return {
        runs: [
          {
            runId: "original-run",
            bindingId: "bound-a",
            sourceBacked: true,
            kind: "task",
            status: "reconciliation_required",
            terminal: false,
            stopConfirmed: false,
            batch: { items: [{ text: "恢复原批次" }] },
          },
        ],
      };
    throw Error(`Unexpected route: ${route}`);
  };
  await act(async () =>
    root.render(React.createElement(AgentWorkspace, { ...opts, requestCloud })),
  );
  await click(button("电脑与项目设置"));
  await click(button("诊断与恢复"));
  assert.match(document.body.textContent, /恢复原批次/);
  await click(button("查看这次执行"));
  assert.equal(
    document.querySelector('[role="dialog"][aria-label="电脑与项目设置"]'),
    null,
  );
  assert.equal(
    document.querySelector("[data-batch]").dataset.run,
    "original-run",
  );
  assert.deepEqual(
    calls.filter((call) => call.method === "POST"),
    [],
  );
});

test("diagnostic help remains keyboard accessible inside the settings focus boundary", async () => {
  await act(async () =>
    root.render(
      React.createElement(AgentWorkspace, {
        ...opts,
        requestCloud: async () => ({ binding: null }),
      }),
    ),
  );
  await click(button("电脑与项目设置"));
  await click(button("诊断与恢复"));
  const summary = document.querySelector(".agent-diagnostic-help summary");
  const close = button("关闭电脑设置");
  close.focus();
  window.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.ok(document.activeElement === summary);
  summary.parentElement.open = true;
  close.focus();
  window.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.ok(
    document.activeElement === summary.parentElement.querySelector("a"),
  );
});
