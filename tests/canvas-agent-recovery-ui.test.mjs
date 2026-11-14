import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWorkspace } from "../src/canvas/model.js";

const dom = new JSDOM("", { url: "http://127.0.0.1:8790/" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  sessionStorage: dom.window.sessionStorage,
});
mkdirSync(resolve("node_modules/.cache"), { recursive: true });
const dir = mkdtempSync(resolve("node_modules/.cache/canvas-agent-recovery-"));
await build({
  entryPoints: ["src/CanvasWorkspace.jsx"],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
  logLevel: "silent",
  plugins: [
    {
      name: "isolated-canvas",
      setup(builder) {
        builder.onResolve({ filter: /\.css$/ }, () => ({
          path: "style",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /\/sync\/useRoomWorkspace\.js$/ }, () => ({
          path: "workspace",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /\/canvas\/Canvas\.jsx$/ }, () => ({
          path: "canvas",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents:
            path === "workspace"
              ? "export function useRoomWorkspace(){return globalThis.testWorkspace;}"
              : path === "style"
                ? ""
                : "export default function Canvas(){return null;}",
          loader: "js",
        }));
      },
    },
  ],
});
const { default: CanvasWorkspace } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
test.after(() => dom.window.close());
test("saved Agent preferences retain the module and batch recovery without validation UI", () => {
  const state = createWorkspace();
  const boardId = state.boards[0].id;
  state.preferences.views[boardId] = {
    ...state.preferences.views[boardId],
    surface: "agent",
  };
  globalThis.testWorkspace = {
    state,
    current: { current: state },
    update() {},
    end() {},
    members: [],
    profiles: [],
    status: "saved",
  };
  const room = { id: state.boards[0].id, name: "隔离画布", role: "owner" };
  const user = { id: "alice", name: "隔离账号" };
  window.localStorage.setItem(
    `qingdan.observed-batch:${JSON.stringify([user.id, room.id])}`,
    "unreadable",
  );
  const markup = renderToStaticMarkup(
    React.createElement(CanvasWorkspace, {
      room,
      user,
      agentEnabled: true,
      onLeave() {},
    }),
  );
  const rendered = new JSDOM(markup);
  const document = rendered.window.document;
  assert.match(
    document.querySelector('[aria-label="批次提醒保存状态"]')?.textContent ||
      "",
    /保存|存储/,
  );
  assert.ok(document.querySelector(".agent-mode"));
  assert.equal(document.querySelector('[aria-label="Agent 验证"]'), null);
  assert.equal(document.querySelector('[aria-label="画布工具"]'), null);
  assert.equal(
    [...document.querySelectorAll(".view-mode-switch button")]
      .find((button) => button.textContent.trim() === "Agent")
      ?.getAttribute("aria-pressed"),
    "true",
  );
  rendered.window.close();
});
