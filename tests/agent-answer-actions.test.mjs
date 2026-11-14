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
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/answer-actions-"));
await build({
  entryPoints: [resolve("src/agent/AnswerActions.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile: resolve(dir, "ui.mjs"),
});
const { default: AnswerActions, appendQuotedReply } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });

test("quoting appends to an existing draft without losing its text and refuses overflow", () => {
  assert.equal(
    appendQuotedReply("已有草稿 ", "第一行\n第二行"),
    "已有草稿 \n\n> 第一行\n> 第二行\n\n",
  );
  assert.equal(appendQuotedReply("", "回答"), "> 回答\n\n");
  assert.equal(appendQuotedReply("x".repeat(11999), "回答"), null);
});

test("copy preserves Markdown and reports clipboard rejection; quote only calls the draft callback", async () => {
  const root = createRoot(document.getElementById("root"));
  const copied = [],
    quoted = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => copied.push(text) },
  });
  const text = "**结论**\n\n正文";
  try {
    await act(async () =>
      root.render(
        React.createElement(AnswerActions, {
          text,
          onQuote: (value) => quoted.push(value),
        }),
      ),
    );
    await act(async () =>
      document.querySelector('[aria-label="复制回答"]').click(),
    );
    assert.deepEqual(copied, [text]);
    assert.match(document.body.textContent, /已复制/);
    await act(async () =>
      document.querySelector('[aria-label="引用回答"]').click(),
    );
    assert.deepEqual(quoted, [text]);
    navigator.clipboard.writeText = async () => {
      throw Error("denied");
    };
    await act(async () =>
      document.querySelector('[aria-label="复制回答"]').click(),
    );
    assert.match(
      document.querySelector('[role="status"]').textContent,
      /复制失败/,
    );
  } finally {
    await act(async () => root.unmount());
  }
});
