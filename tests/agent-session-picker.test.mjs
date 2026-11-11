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
const dir = mkdtempSync(resolve("node_modules/.cache/session-picker-"));
let Picker;
try {
  await build({
    entryPoints: [resolve("src/agent/CodexSessionPicker.jsx")],
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    outfile: resolve(dir, "ui.mjs"),
    logLevel: "silent",
  });
  Picker = (await import(pathToFileURL(resolve(dir, "ui.mjs")))).default;
} catch (error) {
  test("Codex session picker is available", () => assert.fail(error.message));
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
const change = async (el, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
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
        throw Error(`Unexpected local ${route}`);
      },
      requestCloud: async (route, options = {}) => {
        calls.push({ cloud: route, ...options });
        if (route.startsWith("/api/agent/bindings?"))
          return { binding: extra.binding || null };
        if (route === "/api/agent/devices/pairings")
          return { pairingCode: "code" };
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

  test("opening lists sessions without pairing or binding; choosing auto-pairs and binds only the verified project", async () => {
    const f = fixture({ paired: false });
    await f.mount();
    assert.match(document.body.textContent, /网站改版/);
    assert.match(document.body.textContent, /D:\/Projects\/site/);
    assert.equal(f.calls.length, 1);
    await click(button("选择会话：网站改版"));
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
    await click(button("选择会话：网站改版"));
    assert.equal(
      f.calls.filter((c) => c.cloud === "/api/agent/bindings").length,
      0,
    );
    assert.equal(f.bound[0].binding.revision, 3);
  });

  test("an empty workspace creates a named checklist only after the session directory is validated", async () => {
    const f = fixture({ props: { page: null } });
    await f.mount();
    assert.equal(f.created.length, 0);
    await click(button("选择会话：网站改版"));
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
    await click(button("选择会话：网站改版"));
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /目录已移动/,
    );
    assert.equal(f.bound.length, 0);
    assert.equal(
      f.calls.filter((c) => c.cloud === "/api/agent/bindings").length,
      0,
    );
    await click(button("选择会话：网站改版"));
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
    await click(button("选择会话：网站改版"));
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

  test("pagination appends unique sessions and search replaces the list without registering directories", async () => {
    const requests = [];
    const f = fixture({
      props: {
        requestLocal: async (route) => {
          requests.push(route);
          if (route.includes("searchTerm="))
            return {
              sessions: [{ ...session, threadId: "found", title: "搜索结果" }],
              nextCursor: null,
            };
          if (route.includes("cursor="))
            return {
              sessions: [
                session,
                { ...session, threadId: "b", title: "较早会话" },
              ],
              nextCursor: null,
            };
          return { sessions: [session], nextCursor: "next page" };
        },
      },
    });
    await f.mount();
    await click(button("加载更多会话"));
    assert.equal(
      document.querySelectorAll('[aria-label="选择会话：网站改版"]').length,
      1,
    );
    assert.ok(button("选择会话：较早会话"));
    await change(
      document.querySelector('[aria-label="搜索 Codex 会话"]'),
      "需要 搜索",
    );
    await click(button("搜索"));
    assert.ok(button("选择会话：搜索结果"));
    assert.equal(button("选择会话：网站改版"), undefined);
    assert.ok(requests.every((r) => r.startsWith("/codex/sessions")));
    assert.match(requests[1], /cursor=next\+page/);
  });
}
