import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  addDeployment,
  addProduct,
  addServer,
  createInitialOpsState,
  saveOpsState,
} from "../src/ops/model.js";

const dom = new JSDOM('<div id="root"></div>', { url: "https://ops.test" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});

const dir = mkdtempSync(resolve("node_modules/.cache/ops-ui-"));
await build({
  entryPoints: [resolve("src/ops/OperationsCatalog.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  plugins: [{ name: "omit-css", setup(build) {
    build.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: "css" }));
    build.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
  } }],
  outfile: resolve(dir, "ui.mjs"),
});
const { default: OperationsCatalog } = await import(pathToFileURL(resolve(dir, "ui.mjs")));
rmSync(dir, { recursive: true, force: true });

test("operations catalog opens on the product directory", async () => {
  localStorage.clear();
  const root = createRoot(document.getElementById("root"));
  await act(async () => {
    root.render(React.createElement(OperationsCatalog, { onClose: () => {} }));
  });
  try {
    assert.equal(document.querySelector("h1")?.textContent, "产品目录");
    assert.ok(document.querySelector('button[aria-label="新增产品"]'));
    assert.match(document.body.textContent, /还没有产品记录/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("canvas workspace exposes the catalog entry in the left navigation", () => {
  const source = readFileSync(resolve("src/CanvasWorkspace.jsx"), "utf8");
  assert.match(source, /OperationsCatalog/);
  assert.match(source, /aria-label=\"运维资产\"/);
  assert.match(source, /operationsOpen/);
});

test("服务器表单提供状态开关并在台账中显示服务器状态", async () => {
  let state = createInitialOpsState();
  state = addServer(state, { name: "prod-api-01", status: "maintenance" });
  localStorage.clear();
  saveOpsState(state, localStorage);
  const root = createRoot(document.getElementById("root"));
  await act(async () => {
    root.render(React.createElement(OperationsCatalog, { onClose: () => {} }));
  });
  try {
    await act(async () =>
      document.querySelector('button[aria-label="服务器台账"]')?.click(),
    );
    assert.ok(
      document.querySelector('span[aria-label="服务器状态：维护中"]'),
      "服务器台账应显示当前状态",
    );
    await act(async () =>
      document.querySelector('button[aria-label="新增服务器"]')?.click(),
    );
    const status = document.querySelector('select[name="status"]');
    assert.ok(status, "服务器表单应提供状态开关");
    assert.equal(status.value, "running");
    assert.deepEqual(
      [...status.options].map(option => option.value),
      ["running", "maintenance", "retired"],
    );
    await act(async () =>
      document.querySelector('button[aria-label="关闭表单"]')?.click(),
    );
    await act(async () =>
      document.querySelector('button[aria-label="打开服务器：prod-api-01"]')?.click(),
    );
    const editButton = [...document.querySelectorAll(".ops-detail-actions button")]
      .find(button => button.textContent.includes("编辑"));
    assert.ok(editButton);
    await act(async () => editButton.click());
    const editStatus = document.querySelector('select[name="status"]');
    assert.ok(editStatus);
    editStatus.value = "retired";
    await act(async () =>
      editStatus.dispatchEvent(new window.Event("change", { bubbles: true })),
    );
    await act(async () =>
      document.querySelector('button[type="submit"]')?.click(),
    );
    assert.ok(document.querySelector('span[aria-label="服务器状态：已停用"]'));
  } finally {
    await act(async () => root.unmount());
  }
});

test("product and server records expose delete actions and product cards show server names", async () => {
  let state = createInitialOpsState();
  state = addProduct(state, { name: "轻单" });
  state = addServer(state, { name: "prod-api-01" });
  state = addDeployment(state, {
    productId: state.products[0].id,
    serverId: state.servers[0].id,
    environment: "production",
    role: "API",
  });
  localStorage.clear();
  saveOpsState(state, localStorage);
  const root = createRoot(document.getElementById("root"));
  await act(async () => {
    root.render(React.createElement(OperationsCatalog, { onClose: () => {} }));
  });
  try {
    const previousConfirm = window.confirm;
    window.confirm = () => true;
    assert.ok(document.querySelector('button[aria-label="删除产品：轻单"]'));
    assert.equal(document.querySelector('button[aria-label="删除服务器：prod-api-01"]'), null);
    assert.match(document.body.textContent, /prod-api-01/);
    assert.doesNotMatch(document.body.textContent, /1 台服务器/);
    await act(async () => document.querySelector('button[aria-label="服务器台账"]')?.click());
    assert.ok(document.querySelector('button[aria-label="删除服务器：prod-api-01"]'));
    await act(async () => document.querySelector('button[aria-label="删除服务器：prod-api-01"]')?.click());
    assert.match(document.body.textContent, /还没有服务器记录/);
    await act(async () => document.querySelector('button[aria-label="产品目录"]')?.click());
    assert.ok(document.querySelector('button[aria-label="删除产品：轻单"]'));
    await act(async () => document.querySelector('button[aria-label="删除产品：轻单"]')?.click());
    assert.match(document.body.textContent, /还没有产品记录/);
    window.confirm = previousConfirm;
  } finally {
    await act(async () => root.unmount());
  }
});
