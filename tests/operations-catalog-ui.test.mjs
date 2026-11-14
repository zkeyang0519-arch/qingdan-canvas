import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  addDeployment,
  addOpsTask,
  addProduct,
  addServer,
  createInitialOpsState,
  loadOpsState,
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
for (const name of [
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "CustomEvent",
  "getComputedStyle",
])
  globalThis[name] = dom.window[name];
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 10);
globalThis.cancelAnimationFrame = clearTimeout;
const { createRoot } = await import("react-dom/client");

const dir = mkdtempSync(resolve("node_modules/.cache/ops-ui-"));
await build({
  entryPoints: [resolve("src/ops/OperationsCatalog.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
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
  outfile: resolve(dir, "ui.mjs"),
});
const { default: OperationsCatalog } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });

test("运维资产默认打开部署地图，空地图可以新增产品和服务器", async () => {
  localStorage.clear();
  const root = createRoot(document.getElementById("root"));
  await act(async () => {
    root.render(React.createElement(OperationsCatalog, { onClose: () => {} }));
  });
  try {
    assert.equal(document.querySelector("h1")?.textContent, "部署地图");
    assert.ok(document.querySelector('button[aria-label="新增产品"]'));
    assert.ok(document.querySelector('button[aria-label="新增服务器"]'));
    assert.match(document.body.textContent, /还没有资产记录/);
  } finally {
    await act(async () => root.unmount());
  }
});

function deploymentFixture() {
  let state = addProduct(createInitialOpsState(), { name: "轻单" });
  state = addProduct(state, { name: "独立产品" });
  state = addServer(state, {
    name: "prod-api-01",
    address: "api.example.test",
  });
  state = addServer(state, { name: "staging-01" });
  state = addServer(state, { name: "备用服务器" });
  for (const [index, role, environment] of [
    [0, "API", "production"],
    [1, "预发布", "staging"],
  ]) {
    state = addDeployment(state, {
      productId: state.products[0].id,
      serverId: state.servers[index].id,
      role,
      environment,
    });
  }
  return state;
}

async function mountCatalog(t, state, props) {
  localStorage.clear();
  saveOpsState(state);
  const root = createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(React.createElement(OperationsCatalog, props)),
  );
  t.after(() => act(async () => root.unmount()));
}

const mapButton = (label) =>
  document.querySelector(`button[aria-label="${label}"]`);
async function clickButton(label) {
  const button = mapButton(label);
  assert.ok(button, `找不到按钮 ${label}`);
  await act(async () => button.click());
  return button;
}

async function setInput(input, value) {
  assert.ok(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input.constructor.prototype,
      "value",
    ).set.call(input, value);
    input.dispatchEvent(
      new window.Event(input.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

test("地图按同一条部署关系组合关键词和环境，并保留未关联资产入口", async (t) => {
  await mountCatalog(t, deploymentFixture());
  assert.ok(mapButton("打开产品：独立产品"));
  assert.ok(mapButton("打开服务器：备用服务器"));
  assert.ok(mapButton("打开部署：轻单 / 生产 / API / prod-api-01"));
  const input = document.querySelector('input[aria-label="搜索运维资产"]');
  await setInput(input, "api.example.test");
  assert.ok(mapButton("打开产品：轻单"));
  assert.ok(mapButton("打开服务器：prod-api-01"));
  assert.equal(mapButton("打开服务器：staging-01"), null);
  assert.equal(mapButton("打开产品：独立产品"), null);
  await setInput(
    document.querySelector('select[aria-label="筛选环境"]'),
    "staging",
  );
  assert.equal(mapButton("打开产品：轻单"), null);
  assert.match(document.body.textContent, /没有匹配的资产/);
});

test("从部署节点修改角色后保留关系待办，删除关系后移除它的待办", async (t) => {
  let state = deploymentFixture();
  state = addOpsTask(state, {
    text: "部署检查",
    targetType: "deployment",
    targetId: state.deployments[0].id,
  });
  await mountCatalog(t, state);
  await clickButton("打开部署：轻单 / 生产 / API / prod-api-01");
  assert.ok(mapButton("完成待办：部署检查"));
  await clickButton("编辑部署关系");
  await setInput(
    document.querySelector('.ops-modal input[name="role"]'),
    "网关",
  );
  await act(async () =>
    document.querySelector('.ops-modal button[type="submit"]').click(),
  );
  const saved = loadOpsState().state;
  assert.equal(saved.deployments[0].role, "网关");
  assert.equal(saved.tasks[0].targetId, saved.deployments[0].id);
  assert.ok(mapButton("完成待办：部署检查"));
  await clickButton("关闭资产详情");
  assert.equal(
    document.activeElement,
    mapButton("打开部署：轻单 / 生产 / 网关 / prod-api-01"),
  );
  await clickButton("打开部署：轻单 / 生产 / 网关 / prod-api-01");
  const confirm = window.confirm;
  window.confirm = () => true;
  try {
    await clickButton("删除部署关系");
  } finally {
    window.confirm = confirm;
  }
  assert.equal(loadOpsState().state.tasks.length, 0);
  assert.equal(loadOpsState().state.deployments[0].role, "预发布");
  assert.equal(mapButton("打开部署：轻单 / 生产 / 网关 / prod-api-01"), null);
  assert.ok(mapButton("打开服务器：prod-api-01"));
});

test("只读地图可以查看关系与服务器，但无法修改关系或新增关联待办", async (t) => {
  await mountCatalog(t, deploymentFixture(), { readOnly: true });
  assert.ok(mapButton("新增产品")?.disabled);
  assert.ok(mapButton("新增服务器")?.disabled);
  await clickButton("打开部署：轻单 / 生产 / API / prod-api-01");
  assert.ok(mapButton("编辑部署关系")?.disabled);
  assert.ok(mapButton("删除部署关系")?.disabled);
  assert.ok(
    [...document.querySelectorAll(".ops-detail-drawer button")].find(
      (button) => button.textContent === "新建待办",
    )?.disabled,
  );
  const server = [
    ...document.querySelectorAll(".ops-detail-drawer button"),
  ].find((button) => button.textContent === "prod-api-01");
  assert.ok(server);
  await act(async () => server.click());
  assert.ok(
    document.querySelector(
      '.ops-detail-drawer [aria-label="服务器状态：运行中"]',
    ),
  );
});

test("部署编辑写入失败时保留草稿，恢复后可以重试", async (t) => {
  await mountCatalog(t, deploymentFixture());
  await clickButton("打开部署：轻单 / 生产 / API / prod-api-01");
  await clickButton("编辑部署关系");
  const input = document.querySelector('.ops-modal input[name="role"]');
  await setInput(input, "网关");
  const write = t.mock.method(window.Storage.prototype, "setItem", () => {
    throw new window.DOMException("本地存储已满", "QuotaExceededError");
  });
  const submit = () =>
    act(async () =>
      document.querySelector('.ops-modal button[type="submit"]').click(),
    );
  await submit();
  assert.equal(loadOpsState().state.deployments[0].role, "API");
  assert.equal(
    document.querySelector('.ops-modal input[name="role"]')?.value,
    "网关",
  );
  assert.match(
    document.querySelector(".ops-modal .ops-form-error")?.textContent || "",
    /本地存储已满/,
  );
  assert.equal(
    document.querySelector(".ops-detail-drawer h1")?.textContent,
    "API",
  );
  write.mock.restore();
  await submit();
  assert.equal(document.querySelector(".ops-modal"), null);
  assert.equal(loadOpsState().state.deployments[0].role, "网关");
});

test("部署删除写入失败时保留详情、地图节点和关系待办", async (t) => {
  let state = deploymentFixture();
  state = addOpsTask(state, {
    text: "部署检查",
    targetType: "deployment",
    targetId: state.deployments[0].id,
  });
  await mountCatalog(t, state);
  const node = "打开部署：轻单 / 生产 / API / prod-api-01";
  await clickButton(node);
  t.mock.method(window, "confirm", () => true);
  t.mock.method(window.Storage.prototype, "setItem", () => {
    throw new window.DOMException("本地存储已满", "QuotaExceededError");
  });
  await clickButton("删除部署关系");
  assert.ok(mapButton(node));
  assert.ok(mapButton("完成待办：部署检查"));
  assert.match(
    document.querySelector('.ops-detail-drawer [role="alert"]')?.textContent ||
      "",
    /本地存储已满/,
  );
  assert.deepEqual(loadOpsState().state, state);
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
      [...status.options].map((option) => option.value),
      ["running", "maintenance", "retired"],
    );
    await act(async () =>
      document.querySelector('button[aria-label="关闭表单"]')?.click(),
    );
    await act(async () =>
      document
        .querySelector('button[aria-label="打开服务器：prod-api-01"]')
        ?.click(),
    );
    const editButton = [
      ...document.querySelectorAll(".ops-detail-actions button"),
    ].find((button) => button.textContent.includes("编辑"));
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
    await clickButton("产品目录");
    assert.equal(
      document.querySelector('button[aria-label="删除产品：轻单"]'),
      null,
      "删除收在更多操作中",
    );
    await act(async () =>
      document.querySelector('button[aria-label="更多操作：轻单"]')?.click(),
    );
    assert.ok(document.querySelector('button[aria-label="删除产品：轻单"]'));
    assert.equal(
      document.querySelector('button[aria-label="删除服务器：prod-api-01"]'),
      null,
    );
    assert.match(document.body.textContent, /prod-api-01/);
    assert.doesNotMatch(document.body.textContent, /1 台服务器/);
    await act(async () =>
      document.querySelector('button[aria-label="服务器台账"]')?.click(),
    );
    await act(async () =>
      document
        .querySelector('button[aria-label="更多操作：prod-api-01"]')
        ?.click(),
    );
    assert.ok(
      document.querySelector('button[aria-label="删除服务器：prod-api-01"]'),
    );
    await act(async () =>
      document
        .querySelector('button[aria-label="删除服务器：prod-api-01"]')
        ?.click(),
    );
    assert.match(document.body.textContent, /还没有服务器记录/);
    await act(async () =>
      document.querySelector('button[aria-label="产品目录"]')?.click(),
    );
    await act(async () =>
      document.querySelector('button[aria-label="更多操作：轻单"]')?.click(),
    );
    assert.ok(document.querySelector('button[aria-label="删除产品：轻单"]'));
    await act(async () =>
      document.querySelector('button[aria-label="删除产品：轻单"]')?.click(),
    );
    assert.match(document.body.textContent, /还没有产品记录/);
    window.confirm = previousConfirm;
  } finally {
    await act(async () => root.unmount());
  }
});
