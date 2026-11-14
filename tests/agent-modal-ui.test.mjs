import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/agent-modal-"));
await build({
  stdin: {
    contents:
      "export {default as WorkspaceDrawer} from './src/agent/WorkspaceDrawer.jsx'; export {NativeRequestPrompt} from './src/agent/PermissionControls.jsx';",
    resolveDir: resolve("."),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile: resolve(dir, "ui.mjs"),
});
const { WorkspaceDrawer, NativeRequestPrompt } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
test("drawer keyboard navigation includes disclosure controls and skips their collapsed fields", async () => {
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () =>
      root.render(
        React.createElement(
          WorkspaceDrawer,
          { title: "项目摘要", onClose: () => {} },
          React.createElement(
            "details",
            null,
            React.createElement("summary", null, "查看总结来源"),
            React.createElement("input", { "aria-label": "来源详情" }),
          ),
          React.createElement("button", null, "重新总结"),
          React.createElement(
            "details",
            null,
            React.createElement("summary", null, "更多详情"),
            React.createElement("input", { "aria-label": "更多内容" }),
          ),
        ),
      ),
    );
    const [source, more] = document.querySelectorAll("summary");
    const close = document.querySelector('[aria-label="关闭项目摘要"]');
    source.focus();
    const forward = new window.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(forward);
    assert.equal(
      forward.defaultPrevented,
      false,
      "Tab on a middle disclosure must continue normally",
    );
    close.focus();
    window.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(
      document.activeElement === more,
      true,
      "reverse wrap must choose the last visible summary, not its hidden input",
    );
    window.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(document.activeElement === close, true);
  } finally {
    await act(async () => root.unmount());
  }
});
test("an approval arriving above a drawer owns Tab and Escape and stays outside a hidden mobile pane", async () => {
  const root = createRoot(document.getElementById("root"));
  let closed = 0;
  const render = (native) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(
        WorkspaceDrawer,
        { title: "记忆", onClose: () => closed++ },
        React.createElement("input", { "aria-label": "后台记忆" }),
      ),
      native &&
        React.createElement(
          "div",
          { style: { display: "none" } },
          React.createElement(NativeRequestPrompt, {
            request: {
              requestId: "approval",
              kind: "approval",
              description: "修改测试文件",
              details: { allowedDecisions: ["decline"] },
            },
            busy: false,
            onRespond: () => {},
          }),
        ),
    );
  try {
    await act(async () => root.render(render(false)));
    await act(async () => root.render(render(true)));
    const native = document.querySelector(".agent-request-dialog");
    assert.ok(native);
    assert.equal(native.closest('[style="display: none;"]'), null);
    assert.ok(native.contains(document.activeElement));
    await act(async () =>
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.ok(
      native.contains(document.activeElement),
      "Tab must not move behind the approval",
    );
    await act(async () =>
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(document.querySelector(".agent-request-dialog"), null);
    assert.equal(closed, 0, "Escape closes only the top approval");
    assert.ok(
      document
        .querySelector('[aria-label="记忆"]')
        .contains(document.activeElement),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
