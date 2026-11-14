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
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/project-picker-"));
let Picker;
try {
  await build({
    entryPoints: [resolve("src/agent/ProjectBindingPicker.jsx")],
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    loader: { ".css": "empty" },
    outfile: resolve(dir, "ui.mjs"),
    logLevel: "silent",
  });
  Picker = (await import(pathToFileURL(resolve(dir, "ui.mjs")))).default;
} catch (error) {
  test("Codex project picker is available", () => assert.fail(error.message));
}
rmSync(dir, { recursive: true, force: true });
const session = {
  threadId: "thread-a",
  title: "网站改版",
  cwd: "D:/Projects/site",
  projectName: "site",
  updatedAt: 100,
};
const selected = {
  runnerId: "runner",
  session,
  workspace: {
    workspaceId: "workspace",
    name: "site",
    displayPath: session.cwd,
  },
};
const binding = {
  bindingId: "binding",
  runnerId: "runner",
  workspaceId: "workspace",
  enabled: true,
  revision: 3,
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
const change = async (el, value) => {
  assert.ok(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};
const chooseAgent = async (value = "local") =>
  act(async () => {
    const field = document.querySelector('[aria-label="选择 agent 与设备"]');
    assert.ok(field);
    field.value = value;
    field.dispatchEvent(new window.Event("change", { bubbles: true }));
  });

if (Picker) {
  let root;
  test.beforeEach(() => {
    root = createRoot(document.getElementById("root"));
  });
  test.afterEach(async () => {
    if (root) await act(async () => root.unmount());
  });
  function fixture(extra = {}) {
    const calls = [],
      bound = [],
      created = [];
    let paired = extra.paired ?? true;
    const props = {
      roomId: "room",
      userId: "alice",
      page: { id: "page", title: "轻单项目" },
      requestLocal: async (route, options = {}) => {
        calls.push({ local: route, ...options });
        if (route.startsWith("/codex/sessions"))
          return { sessions: [session], nextCursor: null };
        if (route === "/status")
          return {
            paired,
            enabled: paired,
            runnerId: paired ? "runner" : null,
            connectionStatus: paired ? "online" : "unpaired",
          };
        if (route === "/pair") {
          paired = true;
          return {
            paired: true,
            enabled: true,
            runnerId: "runner",
            connectionStatus: "connecting",
          };
        }
        if (route === "/codex/select") return selected;
        if (
          route === "/workspaces/verify?runnerId=runner&workspaceId=workspace"
        ) {
          return { runnerId: "runner", workspace: selected.workspace };
        }
        throw Error(`Unexpected local ${route}`);
      },
      requestCloud: async (route, options = {}) => {
        calls.push({ cloud: route, ...options });
        if (route.startsWith("/api/agent/bindings?"))
          return { binding: extra.binding || null };
        if (route === "/api/agent/devices/pairings")
          return { pairingCode: "code" };
        if (route === "/api/agent/devices")
          return { enabled: true, devices: extra.devices || [] };
        if (route === "/api/agent/bindings") return { binding };
        throw Error(`Unexpected cloud ${route}`);
      },
      onBound: (value) => bound.push(value),
      onCreateProject: (name) => {
        created.push(name);
        return "new-page";
      },
      ...extra.props,
    };
    return {
      props,
      calls,
      bound,
      created,
      mount: () =>
        act(async () => root.render(React.createElement(Picker, props))),
    };
  }

  test("initial setup requires an explicit agent/device before choosing and binding a Codex directory", async () => {
    const f = fixture({ paired: false });
    await f.mount();
    assert.ok(!button("选择执行项目 site"));
    assert.equal(
      f.calls.some((call) => call.method === "POST"),
      false,
    );
    await chooseAgent();
    assert.doesNotMatch(document.body.textContent, /网站改版|选择会话/);
    assert.match(document.body.textContent, /D:\/Projects\/site/);
    await click(button("选择执行项目 site"));
    assert.equal(f.bound.length, 1);
    assert.equal(f.bound[0].sectionId, "page");
    assert.deepEqual(f.calls.find((c) => c.local === "/codex/select").body, {
      threadId: "thread-a",
    });
    assert.deepEqual(
      f.calls.find((c) => c.cloud === "/api/agent/bindings").body,
      {
        canvasId: "room",
        sectionId: "page",
        runnerId: "runner",
        workspaceId: "workspace",
        expectedRevision: null,
      },
    );
    assert.equal(f.calls.filter((c) => c.local === "/pair").length, 1);
    assert.ok(f.calls.every((c) => c.accountId === "alice"));
    assert.equal(f.created.length, 0);
    assert.ok(
      !f.calls.some((c) => /runs|chat\/|summary/.test(c.cloud || c.local)),
    );
  });

  test("an existing same-directory binding is reused without invalidating its revision and summary", async () => {
    const f = fixture({ binding });
    await f.mount();
    await chooseAgent();
    await click(button("选择执行项目 site"));
    assert.equal(
      f.calls.filter((c) => c.cloud === "/api/agent/bindings").length,
      0,
    );
    assert.equal(f.bound[0].binding.revision, 3);
  });

  test("an empty workspace creates a named checklist only after the project directory is validated", async () => {
    const f = fixture({ props: { page: null } });
    await f.mount();
    await chooseAgent();
    assert.equal(f.created.length, 0);
    await click(button("选择执行项目 site"));
    assert.deepEqual(f.created, ["site"]);
    assert.equal(f.bound[0].sectionId, "new-page");
  });

  test("failed selection leaves binding untouched and is retryable", async () => {
    const f = fixture();
    const local = f.props.requestLocal;
    let attempts = 0;
    f.props.requestLocal = (route, options) => {
      if (route === "/codex/select" && attempts++ === 0)
        throw Error("项目目录已移动");
      return local(route, options);
    };
    await f.mount();
    await chooseAgent();
    await click(button("选择执行项目 site"));
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /目录已移动/,
    );
    assert.equal(f.bound.length, 0);
    assert.equal(
      f.calls.filter((c) => c.cloud === "/api/agent/bindings").length,
      0,
    );
    await click(button("选择执行项目 site"));
    assert.equal(f.bound.length, 1);
  });

  test("closing during selection prevents later binding or checklist creation", async () => {
    const f = fixture({ props: { page: null } });
    const local = f.props.requestLocal;
    let release;
    f.props.requestLocal = (route, options) =>
      route === "/codex/select"
        ? new Promise((r) => {
            release = r;
          })
        : local(route, options);
    await f.mount();
    await chooseAgent();
    await click(button("选择执行项目 site"));
    assert.ok(release);
    await act(async () => root.unmount());
    root = null;
    await act(async () => release(selected));
    assert.equal(f.created.length, 0);
    assert.equal(f.bound.length, 0);
    assert.equal(
      f.calls.filter((c) => c.cloud === "/api/agent/bindings").length,
      0,
    );
  });

  test("pagination groups conversations by directory and filters project names and paths without registering them", async () => {
    const requests = [];
    const f = fixture({
      props: {
        requestLocal: async (route) => {
          if (route === "/status")
            return {
              paired: true,
              runnerId: "runner",
              connectionStatus: "online",
            };
          requests.push(route);
          if (route.includes("cursor="))
            return {
              sessions: [
                {
                  ...session,
                  threadId: "older",
                  cwd: "d:\\projects\\site\\",
                  title: "同目录旧对话",
                },
                {
                  ...session,
                  threadId: "b",
                  cwd: "D:/Projects/docs",
                  projectName: "文档",
                  title: "较早会话",
                },
              ],
              nextCursor: null,
            };
          return { sessions: [session], nextCursor: "next page" };
        },
      },
    });
    await f.mount();
    await chooseAgent();
    await click(button("加载更多项目"));
    assert.equal(
      document.querySelectorAll('[aria-label="选择执行项目 site"]').length,
      1,
    );
    assert.ok(button("选择执行项目 文档"));
    assert.doesNotMatch(
      document.body.textContent,
      /较早会话|同目录旧对话|网站改版/,
    );
    await change(document.querySelector('[aria-label="筛选项目"]'), "文档");
    assert.ok(button("选择执行项目 文档"));
    assert.equal(button("选择执行项目 site"), undefined);
    await change(
      document.querySelector('[aria-label="筛选项目"]'),
      "PROJECTS/site",
    );
    assert.ok(button("选择执行项目 site"));
    assert.equal(button("选择执行项目 文档"), undefined);
    assert.ok(requests.every((r) => r.startsWith("/codex/sessions")));
    assert.equal(
      new URL(requests[1], "http://local").searchParams.get("cursor"),
      "next page",
    );
  });

  test("an online device remains selectable while local discovery is still pending", async () => {
    let finishStatus;
    const f = fixture({
      devices: [
        { runnerId: "remote-runner", status: "online", workspaces: [] },
      ],
    });
    f.props.requestLocal = (route) => {
      assert.equal(route, "/status");
      return new Promise((resolve) => {
        finishStatus = resolve;
      });
    };
    await f.mount();
    try {
      const device = document.querySelector('[aria-label="选择 agent 与设备"]');
      assert.equal(device.disabled, false);
      assert.ok(
        [...device.options].some((option) => option.value === "remote-runner"),
      );
    } finally {
      await act(async () => finishStatus({ paired: false }));
    }
  });

  test("rerendering with a new request callback keeps the loaded projects and active filter", async () => {
    const f = fixture();
    await f.mount();
    await chooseAgent();
    await change(document.querySelector('[aria-label="筛选项目"]'), "site");
    const requestLocal = f.props.requestLocal;
    f.props.requestLocal = (...args) => requestLocal(...args);
    await f.mount();
    assert.equal(
      document.querySelector('[aria-label="筛选项目"]').value,
      "site",
    );
    assert.ok(button("选择执行项目 site"));
    assert.equal(
      f.calls.filter((call) => call.local === "/codex/sessions").length,
      1,
    );
  });

  test("a registered local directory can be bound when Codex thread discovery fails", async () => {
    const f = fixture({ binding });
    const requestLocal = f.props.requestLocal;
    f.props.requestLocal = async (route, options) => {
      if (route === "/codex/sessions") throw Error("Codex 协议版本不匹配");
      const result = await requestLocal(route, options);
      return route === "/status"
        ? { ...result, workspaces: [selected.workspace] }
        : result;
    };
    await f.mount();
    await chooseAgent();
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /Codex 协议版本不匹配/,
    );
    await click(button("选择执行项目 site"));
    assert.equal(f.bound[0]?.binding.revision, 3);
    assert.ok(f.bound[0]?.isLocalAgent);
    assert.ok(!f.calls.some((call) => call.method === "POST"));
    assert.ok(
      f.calls.some(
        (call) =>
          call.local ===
          "/workspaces/verify?runnerId=runner&workspaceId=workspace",
      ),
    );
  });

  test("a stale local registry entry cannot create a binding after its directory is replaced", async () => {
    const f = fixture();
    const requestLocal = f.props.requestLocal;
    f.props.requestLocal = async (route, options) => {
      if (route.startsWith("/workspaces/verify?"))
        throw Error("项目目录已移动或已被替换。");
      const result = await requestLocal(route, options);
      return route === "/status"
        ? { ...result, workspaces: [selected.workspace] }
        : result;
    };
    await f.mount();
    await chooseAgent();
    await click(button("选择执行项目 site"));
    assert.match(document.body.textContent, /目录已移动或已被替换/);
    assert.equal(f.bound.length, 0);
    assert.ok(!f.calls.some((call) => call.method === "POST"));
  });

  test("an online device selected before local discovery also verifies the directory once identified as local", async () => {
    const f = fixture({
      devices: [
        {
          runnerId: "runner",
          status: "online",
          workspaces: [selected.workspace],
        },
      ],
    });
    const requestLocal = f.props.requestLocal;
    let finishDiscovery;
    f.props.requestLocal = (route, options) => {
      if (route === "/status" && !finishDiscovery)
        return new Promise((resolve) => {
          finishDiscovery = resolve;
        });
      if (route.startsWith("/workspaces/verify?"))
        throw Error("项目目录已被替换。");
      return requestLocal(route, options);
    };
    await f.mount();
    await chooseAgent("runner");
    await act(async () =>
      finishDiscovery({
        paired: true,
        enabled: true,
        runnerId: "runner",
        connectionStatus: "online",
        workspaces: [selected.workspace],
      }),
    );
    await click(button("选择执行项目 site"));
    assert.match(document.body.textContent, /目录已被替换/);
    assert.equal(f.bound.length, 0);
    assert.ok(!f.calls.some((call) => call.method === "POST"));
  });

  test("a different page appearing during empty-workspace selection cancels the old binding", async () => {
    const f = fixture({ props: { page: null } });
    const requestLocal = f.props.requestLocal;
    let finishSelect;
    f.props.requestLocal = (route, options) =>
      route === "/codex/select"
        ? new Promise((resolve) => {
            finishSelect = resolve;
          })
        : requestLocal(route, options);
    await f.mount();
    await chooseAgent();
    await click(button("选择执行项目 site"));
    f.props.page = { id: "collaborator-page", title: "其他人新建的项目" };
    await f.mount();
    await act(async () => finishSelect(selected));
    assert.equal(f.created.length, 0);
    assert.equal(f.bound.length, 0);
    assert.ok(!f.calls.some((call) => call.cloud === "/api/agent/bindings"));
  });

  test("retrying a failed project page retains the loaded directories and requests the same cursor", async () => {
    const f = fixture();
    const requestLocal = f.props.requestLocal;
    const requests = [];
    f.props.requestLocal = (route, options) => {
      if (!route.startsWith("/codex/sessions"))
        return requestLocal(route, options);
      requests.push(route);
      if (requests.length === 1)
        return { sessions: [session], nextCursor: "next" };
      if (requests.length === 2) throw Error("Codex 暂时不可用");
      return {
        sessions: [{ threadId: "docs", cwd: "D:/docs", projectName: "文档" }],
        nextCursor: null,
      };
    };
    await f.mount();
    await chooseAgent();
    await click(button("加载更多项目"));
    assert.ok(button("选择执行项目 site"));
    await click(button("重试读取项目"));
    assert.deepEqual(requests, [
      "/codex/sessions",
      "/codex/sessions?cursor=next",
      "/codex/sessions?cursor=next",
    ]);
    assert.ok(button("选择执行项目 site"));
    assert.ok(button("选择执行项目 文档"));
  });

  test("switching devices ignores a pending local project list and retains only the selected device's directories", async () => {
    const f = fixture({
      devices: [
        {
          runnerId: "remote-runner",
          status: "online",
          workspaces: [
            {
              workspaceId: "remote-workspace",
              name: "远程项目",
              displayPath: "D:/remote",
            },
          ],
        },
      ],
    });
    const requestLocal = f.props.requestLocal;
    let finishSessions;
    f.props.requestLocal = (route, options) =>
      route === "/codex/sessions"
        ? new Promise((resolve) => {
            finishSessions = resolve;
          })
        : requestLocal(route, options);
    await f.mount();
    await chooseAgent();
    await chooseAgent("remote-runner");
    await act(async () => finishSessions({ sessions: [session] }));
    assert.ok(button("选择执行项目 远程项目"));
    assert.ok(!button("选择执行项目 site"));
    assert.ok(!f.calls.some((call) => call.method === "POST"));
  });

  test("changing accounts drops a pending project response and reloads the device list", async () => {
    const f = fixture();
    const requestLocal = f.props.requestLocal;
    let finishSessions;
    f.props.requestLocal = (route, options) => {
      if (route === "/codex/sessions" && options.accountId === "alice")
        return new Promise((resolve) => {
          finishSessions = resolve;
        });
      return requestLocal(route, options);
    };
    await f.mount();
    await chooseAgent();
    f.props.userId = "bob";
    await f.mount();
    await act(async () => finishSessions({ sessions: [session] }));
    assert.equal(
      document.querySelector('[aria-label="选择 agent 与设备"]').value,
      "",
    );
    assert.ok(!button("选择执行项目 site"));
    assert.ok(
      f.calls.some(
        (call) => call.local === "/status" && call.accountId === "bob",
      ),
    );
  });

  test("selecting an agent loads directories while binding is unavailable", async () => {
    const f = fixture({ props: { page: null, onCreateProject: undefined } });
    await f.mount();
    await chooseAgent();
    assert.equal(button("选择执行项目 site")?.disabled, true);
    f.props.page = { id: "page", title: "轻单项目" };
    await f.mount();
    assert.equal(button("选择执行项目 site")?.disabled, false);
    assert.equal(
      f.calls.filter((call) => call.local === "/codex/sessions").length,
      1,
    );
  });

  test("choosing another online agent binds its authorized project without mutating this computer", async () => {
    const f = fixture({
      devices: [
        {
          runnerId: "remote-runner",
          deviceName: "工作电脑",
          status: "online",
          workspaces: [
            {
              workspaceId: "remote-workspace",
              name: "远程项目",
              displayPath: "D:/remote",
            },
          ],
        },
      ],
    });
    await f.mount();
    await chooseAgent("remote-runner");
    await change(document.querySelector('[aria-label="筛选项目"]'), "无匹配项");
    assert.equal(button("选择执行项目 远程项目"), undefined);
    await change(
      document.querySelector('[aria-label="筛选项目"]'),
      "D:\\REMOTE",
    );
    await click(button("选择执行项目 远程项目"));
    assert.deepEqual(
      f.calls.find((call) => call.cloud === "/api/agent/bindings").body,
      {
        canvasId: "room",
        sectionId: "page",
        runnerId: "remote-runner",
        workspaceId: "remote-workspace",
        expectedRevision: null,
      },
    );
    assert.equal(
      f.calls.some((call) => call.local && call.method === "POST"),
      false,
    );
    assert.equal(f.bound.length, 1);
  });

  test("a remote device losing project authorization before selection cannot replace the binding", async () => {
    const device = {
      runnerId: "remote-runner",
      deviceName: "工作电脑",
      status: "online",
      workspaces: [
        {
          workspaceId: "remote-workspace",
          name: "远程项目",
          displayPath: "D:/remote",
        },
      ],
    };
    const f = fixture({ binding, devices: [device] });
    await f.mount();
    await chooseAgent("remote-runner");
    device.workspaces = [];
    await click(button("选择执行项目 远程项目"));
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /项目授权已变化/,
    );
    assert.equal(
      f.calls.some((call) => call.method === "POST"),
      false,
    );
    assert.equal(f.bound.length, 0);
  });
}
