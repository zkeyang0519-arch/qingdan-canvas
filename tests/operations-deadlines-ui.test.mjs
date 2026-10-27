import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  addDeployment,
  addProduct,
  addServer,
  createInitialOpsState,
  loadOpsState,
  saveOpsState,
  updateServer,
} from "../src/ops/model.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "localStorage",
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "CustomEvent",
  "MouseEvent",
  "Event",
  "AbortController",
  "AbortSignal",
  "getComputedStyle",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 10);
globalThis.cancelAnimationFrame = clearTimeout;
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/ops-deadlines-ui-"));
await build({
  entryPoints: [resolve("src/ops/OperationsCatalog.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile: resolve(dir, "ui.mjs"),
  plugins: [
    {
      name: "omit-css",
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (args) => ({
          path: args.path,
          namespace: "css",
        }));
        build.onLoad({ filter: /.*/, namespace: "css" }, () => ({
          contents: "",
          loader: "js",
        }));
      },
    },
  ],
});
const { default: OperationsCatalog } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
after(() => {
  dom.window.close();
  rmSync(dir, { recursive: true, force: true });
});

async function mount(t, state, props = {}) {
  localStorage.clear();
  saveOpsState(state);
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(React.createElement(OperationsCatalog, props)),
  );
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label || item.textContent === label,
  );
const deadlineButton = (name) =>
  [...document.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label")?.match(/设置截止时间|修改截止时间/) &&
      item.getAttribute("aria-label").includes(name),
  );
const picker = () => document.querySelector(".task-deadline-popover");
async function click(element) {
  assert.ok(element, "操作按钮存在");
  await act(async () => {
    element.dispatchEvent(
      new window.MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    element.focus();
  });
  await act(async () => element.click());
}
const selectDay = (label) =>
  click(
    [...picker().querySelectorAll(".rdp-day_button")].find((item) =>
      item.getAttribute("aria-label")?.includes(label),
    ),
  );
const dueAt = "2028-02-29T04:30:00.000Z";
function fixture() {
  let state = addProduct(createInitialOpsState(), { name: "轻单" });
  state = addServer(state, { name: "prod-api-01", dueAt });
  return addDeployment(state, {
    productId: state.products[0].id,
    serverId: state.servers[0].id,
    environment: "production",
    role: "API",
  });
}

test("服务器复用 DDL 日历保存区间，产品联动，重开恢复并可移除", async (t) => {
  const state = fixture();
  await mount(t, state);
  await click(button("服务器台账"));
  await click(deadlineButton("prod-api-01"));
  assert.ok(picker());
  assert.ok(
    picker().querySelector('[role="spinbutton"][aria-label="截止小时"]'),
  );
  assert.equal(picker().querySelector(".task-deadline-hint"), null);
  await selectDay("2028年2月27日");
  await selectDay("2028年2月28日");
  await click(button("确定"));
  const saved = loadOpsState().state.servers[0];
  assert.equal(saved.dueStartAt, new Date("2028-02-27T00:00:00").toISOString());
  assert.equal(new Date(saved.dueAt).getDate(), 28);
  assert.equal(new Date(saved.dueAt).getHours(), new Date(dueAt).getHours());
  assert.ok(
    document.querySelector(
      `.ops-record.server time[datetime="${saved.dueAt}"]`,
    ),
  );
  await click(button("产品目录"));
  assert.ok(
    document.querySelector(
      `.ops-product-deadline time[datetime="${saved.dueAt}"]`,
    ),
  );
  await click(button("打开产品：轻单"));
  assert.ok(
    document.querySelector(
      `.ops-deployment-row time[datetime="${saved.dueAt}"]`,
    ),
  );
  await click(button("服务器台账"));
  await click(deadlineButton("prod-api-01"));
  assert.match(
    picker().querySelector(".task-deadline-summary").textContent,
    /2028年2月27日.*2028年2月28日/,
  );
  await selectDay("2028年2月26日");
  await click(button("取消"));
  assert.equal(loadOpsState().state.servers[0].dueAt, saved.dueAt);
  await click(deadlineButton("prod-api-01"));
  await click(button("移除时间"));
  assert.equal(loadOpsState().state.servers[0].dueAt, null);
  assert.equal(loadOpsState().state.servers[0].dueStartAt, null);
  await click(button("产品目录"));
  assert.equal(document.querySelector(".ops-product-deadline time"), null);
});

test("服务器表单的 DDL 确认只改草稿，保存服务器才持久化，取消编辑保留原日期", async (t) => {
  await mount(t, fixture());
  await click(button("服务器台账"));
  await click(button("打开服务器：prod-api-01"));
  await click(button("编辑"));
  await click(document.querySelector(".ops-modal .todo-deadline-button"));
  await selectDay("2028年2月26日");
  await click(button("确定"));
  assert.ok(
    document.querySelector(".ops-modal"),
    "确认日期不能顺带提交服务器表单",
  );
  assert.equal(loadOpsState().state.servers[0].dueAt, dueAt);
  await click(button("取消"));
  assert.equal(loadOpsState().state.servers[0].dueAt, dueAt);
  await click(button("编辑"));
  await click(document.querySelector(".ops-modal .todo-deadline-button"));
  await selectDay("2028年2月25日");
  await click(button("确定"));
  await click(button("保存服务器"));
  assert.equal(new Date(loadOpsState().state.servers[0].dueAt).getDate(), 25);
  await click(button("返回服务器台账"));
  await click(button("新增服务器"));
  const name = document.querySelector('input[name="server-name"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(name, "new-server");
    name.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await click(document.querySelector(".ops-modal .todo-deadline-button"));
  await click(button("确定"));
  assert.equal(loadOpsState().state.servers.length, 1);
  await click(button("保存服务器"));
  assert.ok(
    loadOpsState().state.servers.find((server) => server.name === "new-server")
      ?.dueAt,
  );
});

test("产品按服务器列出全部 DDL，同一服务器去重，删除后联动且不保存独立副本", async (t) => {
  let state = fixture();
  state = addServer(state, {
    name: "prod-db-01",
    dueAt: "2028-02-25T04:30:00.000Z",
    dueStartAt: "2028-02-20T04:30:00.000Z",
  });
  state = addDeployment(state, {
    productId: state.products[0].id,
    serverId: state.servers[1].id,
    environment: "production",
    role: "数据库",
  });
  state = addDeployment(state, {
    productId: state.products[0].id,
    serverId: state.servers[1].id,
    environment: "staging",
    role: "数据库",
  });
  await mount(t, state);
  assert.ok(
    document.querySelector(
      '.ops-product-deadline time[datetime="2028-02-25T04:30:00.000Z"]',
    ),
  );
  assert.ok(
    document.querySelector(`.ops-product-deadline time[datetime="${dueAt}"]`),
  );
  assert.equal(document.querySelectorAll(".ops-product-deadline").length, 2);
  const dbDate = document.querySelector(
    '.ops-product-deadline time[datetime="2028-02-25T04:30:00.000Z"]',
  );
  assert.match(
    dbDate.closest(".ops-product-deadline").textContent,
    /prod-db-01/,
  );
  await click(button("打开产品：轻单"));
  assert.ok(
    document.querySelector(`.ops-deployment-row time[datetime="${dueAt}"]`),
  );
  assert.equal(
    document.querySelectorAll(
      '.ops-deployment-row time[datetime="2028-02-25T04:30:00.000Z"]',
    ).length,
    2,
  );
  await click(button("服务器台账"));
  const confirm = window.confirm;
  window.confirm = () => true;
  try {
    await click(button("删除服务器：prod-db-01"));
  } finally {
    window.confirm = confirm;
  }
  await click(button("产品目录"));
  assert.ok(
    document.querySelector(`.ops-product-deadline time[datetime="${dueAt}"]`),
  );
  assert.equal(document.querySelectorAll(".ops-product-deadline").length, 1);
  assert.equal(loadOpsState().state.products[0].dueAt, undefined);
});

test("只读运维资产可见 DDL 但无法改期", async (t) => {
  await mount(t, fixture(), { readOnly: true });
  await click(button("服务器台账"));
  assert.ok(deadlineButton("prod-api-01")?.disabled);
  const statusButtons = document.querySelectorAll(
    ".ops-server-status-switch button",
  );
  assert.equal(statusButtons.length, 3);
  assert.ok([...statusButtons].every((item) => item.disabled));
  assert.ok(
    document.querySelector(`.ops-record.server time[datetime="${dueAt}"]`),
  );
  await click(button("打开服务器：prod-api-01"));
  assert.ok(deadlineButton("prod-api-01")?.disabled);
  assert.equal(picker(), null);
});

test("服务器台账在 DDL 与删除之间切换三种状态，保留日期和其他服务器", async (t) => {
  const state = addServer(fixture(), { name: "prod-db-01", status: "running" });
  await mount(t, state);
  await click(button("服务器台账"));
  const row = button("打开服务器：prod-api-01").closest(".ops-record");
  const status = row.querySelector(
    '[role="group"][aria-label="服务器状态：prod-api-01"]',
  );
  assert.ok(status, "台账直接提供状态切换");
  assert.equal(status.previousElementSibling.className, "ops-server-deadline");
  assert.equal(
    status.nextElementSibling.getAttribute("aria-label"),
    "删除服务器：prod-api-01",
  );
  assert.deepEqual(
    [...status.querySelectorAll("button")].map((item) => item.textContent),
    ["运行中", "维护中", "停用"],
  );
  const choose = (text) =>
    click(
      [...status.querySelectorAll("button")].find(
        (item) => item.textContent === text,
      ),
    );
  await choose("维护中");
  assert.equal(row.dataset.status, "maintenance");
  assert.equal(
    status.querySelector('[aria-pressed="true"]').textContent,
    "维护中",
  );
  assert.equal(loadOpsState().state.servers[0].status, "maintenance");
  assert.equal(loadOpsState().state.servers[0].dueAt, dueAt);
  await choose("停用");
  assert.equal(row.dataset.status, "retired");
  assert.equal(loadOpsState().state.servers[0].status, "retired");
  await choose("运行中");
  assert.equal(row.dataset.status, "running");
  assert.equal(loadOpsState().state.servers[0].status, "running");
  assert.equal(loadOpsState().state.servers[1].status, "running");
  const undated = button("打开服务器：prod-db-01").closest(".ops-record");
  await click(
    [...undated.querySelectorAll(".ops-server-status-switch button")].find(
      (item) => item.textContent === "维护中",
    ),
  );
  assert.equal(undated.dataset.status, "maintenance", "没有 DDL 也能维护");
  assert.equal(loadOpsState().state.servers[1].dueAt, null);
  await click(button("产品目录"));
  await click(button("服务器台账"));
  assert.equal(
    button("打开服务器：prod-db-01").closest(".ops-record").dataset.status,
    "maintenance",
  );
});

test("产品按每台服务器展示 DDL 时间圈，倒计时与超时一致且不重复", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2027-01-01T00:00:00.000Z"));
  let state = fixture();
  state = updateServer(state, state.servers[0].id, {
    dueAt: "2027-01-03T00:00:00.000Z",
  });
  state = addServer(state, {
    name: "prod-db-01",
    dueAt: "2026-12-31T00:00:00.000Z",
  });
  for (const role of ["数据库", "备份"])
    state = addDeployment(state, {
      productId: state.products[0].id,
      serverId: state.servers[1].id,
      environment: "production",
      role,
    });
  await mount(t, state);
  const rows = [...document.querySelectorAll(".ops-product-deadline")];
  assert.equal(rows.length, 2);
  for (const row of rows)
    assert.ok(row.querySelector(".todo-deadline-ring"), "每台服务器都有时间圈");
  assert.equal(
    rows[0].querySelector(".todo-deadline-value").textContent,
    "2天",
  );
  assert.equal(
    rows[1].querySelector(".todo-deadline-value").textContent,
    "超时",
  );
  assert.match(
    rows[0].querySelector('[role="img"]').getAttribute("aria-label"),
    /prod-api-01/,
  );
  assert.equal(
    document.querySelector(".ops-record-open button"),
    null,
    "展示时间圈不嵌套按钮",
  );
  await click(button("服务器台账"));
  const info = deadlineButton("prod-api-01");
  assert.equal(info.querySelector(".todo-deadline-value").textContent, "2天");
});

test("切换服务器日期按钮只保留当前弹层，保存不会改到上一台服务器", async (t) => {
  const state = addServer(fixture(), { name: "prod-db-01", dueAt });
  await mount(t, state);
  await click(button("服务器台账"));
  await click(deadlineButton("prod-api-01"));
  await selectDay("2028年2月26日");
  await click(deadlineButton("prod-db-01"));
  assert.equal(document.querySelectorAll(".task-deadline-popover").length, 1);
  assert.equal(
    picker().querySelector(".task-deadline-title").textContent,
    "prod-db-01",
  );
  await selectDay("2028年2月25日");
  await click(button("确定"));
  const servers = loadOpsState().state.servers;
  assert.equal(servers[0].dueAt, dueAt);
  assert.equal(new Date(servers[1].dueAt).getDate(), 25);
});
