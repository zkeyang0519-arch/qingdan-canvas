import test from "node:test";
import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const dom = new JSDOM('<div id="root"></div>', {
  url: "http://127.0.0.1:8797",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  FormData: dom.window.FormData,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/model-settings-"));
await build({
  entryPoints: [resolve("src/agent/ChatModelPicker.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
});
const { default: Picker } = await import(pathToFileURL(resolve(dir, "ui.mjs")));
rmSync(dir, { recursive: true, force: true });
const initial = {
  defaultId: "xingchi",
  modelsEndpoint: "/local/models",
  apiFormats: ["responses"],
  profiles: [
    { id: "xingchi", service: "星驰", model: "gpt-6.1-sol", configured: true },
    {
      id: "deepseek",
      service: "DeepSeek 官方",
      model: "deepseek-flash",
      configured: true,
    },
  ],
};
const button = (text) =>
  [...document.querySelectorAll("button")].find(
    (item) =>
      item.textContent.trim() === text ||
      item.getAttribute("aria-label") === text,
  );
async function choose(label, value) {
  await act(async () => {
    const field = document.querySelector(`[aria-label="${label}"]`);
    field.value = value;
    field.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
test("主模型和默认模型都需要明确应用", async () => {
  const calls = [],
    selected = [];
  const root = createRoot(document.getElementById("root"));
  function App() {
    const [catalog, setCatalog] = useState(initial),
      [model, setModel] = useState("xingchi");
    return React.createElement(Picker, {
      inline: true,
      catalog,
      selected: model,
      onCatalog: setCatalog,
      call: async (path, { body }) => {
        calls.push({ path, body });
        return { ...catalog, defaultId: body.id };
      },
      onChoose: async (id) => {
        selected.push(id);
        setModel(id);
        return true;
      },
    });
  }
  await act(async () => root.render(React.createElement(App)));
  try {
    assert.equal(button("应用到当前对话"), undefined);
    assert.equal(button("保存默认模型"), undefined);
    assert.match(
      document.querySelector('[aria-label="当前使用的主模型"]').textContent,
      /星驰.*gpt-6.1-sol/,
    );
    await choose("当前对话主模型", "deepseek");
    assert.equal(selected.length, 0);
    await act(async () => button("应用到当前对话").click());
    assert.deepEqual(selected, ["deepseek"]);
    assert.match(
      document.querySelector('[aria-label="当前使用的主模型"]').textContent,
      /DeepSeek 官方/,
    );
    await choose("新对话默认模型", "deepseek");
    assert.equal(calls.length, 0);
    await act(async () => button("保存默认模型").click());
    assert.deepEqual(calls[0].body, { action: "default", id: "deepseek" });
  } finally {
    await act(async () => root.unmount());
  }
});
test("DeepSeek 官方入口预填地址和模型，密钥由用户在界面填写", async () => {
  const root = createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(
      React.createElement(Picker, {
        inline: true,
        catalog: initial,
        selected: "xingchi",
        onChoose: () => {},
        onCatalog: () => {},
        call: async () => {
          throw Error("not called");
        },
      }),
    ),
  );
  try {
    await act(async () => button("新建模型连接").click());
    await choose("连接模板", "deepseek");
    assert.equal(
      document.querySelector('[name="baseUrl"]').value,
      "https://api.deepseek.com",
    );
    assert.equal(
      document.querySelector('[name="service"]').value,
      "DeepSeek 官方",
    );
    assert.equal(
      document.querySelector('[name="model"]').value,
      "deepseek-flash",
    );
    assert.equal(document.querySelector('[name="apiKey"]').value, "");
    assert.equal(document.querySelector('[name="apiKey"]').type, "password");
  } finally {
    await act(async () => root.unmount());
  }
});

test("连接列表默认收起，展开后保留全部连接与当前、默认状态", async () => {
  const root = createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(
      React.createElement(Picker, {
        inline: true,
        catalog: initial,
        selected: "xingchi",
        onChoose() {},
        onCatalog() {},
        call() {},
      }),
    ),
  );
  try {
    assert.equal(document.querySelector(".qd-model-connections"), null);
    const toggle = document.querySelector(
      'button[aria-controls$="-connections"]',
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await act(async () => toggle.click());
    assert.equal(
      document.querySelectorAll(".qd-model-connections li").length,
      initial.profiles.length,
    );
    assert.match(
      document.querySelector(".qd-model-connections").textContent,
      /当前使用.*新对话默认/,
    );
    await act(async () => toggle.click());
    assert.equal(document.querySelector(".qd-model-connections"), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test("自定义连接保存失败保留输入，重试保存不会自动切换当前模型", async () => {
  const root = createRoot(document.getElementById("root"));
  const requests = [],
    selected = [];
  function App() {
    const [catalog, update] = useState({
      ...initial,
      apiFormats: ["responses", "chat_completions"],
    });
    return React.createElement(Picker, {
      inline: true,
      catalog,
      selected: "xingchi",
      onChoose: (id) => selected.push(id),
      onCatalog: update,
      call: async (route, { body }) => {
        requests.push(body);
        if (requests.length === 1) throw Error("连接暂时不可用，请重试。");
        return {
          ...catalog,
          added: "new",
          profiles: [
            ...catalog.profiles,
            {
              id: "new",
              service: body.service,
              model: body.model,
              configured: true,
            },
          ],
        };
      },
    });
  }
  await act(async () => root.render(React.createElement(App)));
  try {
    await act(async () => button("新建模型连接").click());
    const form = document.querySelector(".qd-model-form");
    for (const [key, value] of Object.entries({
      service: "测试连接",
      baseUrl: "https://example.test/v1",
      model: "custom-model",
      apiKey: "fake-ui-only",
      apiFormat: "chat_completions",
    }))
      form.querySelector(`[name="${key}"]`).value = value;
    const submit = async () =>
      act(async () =>
        form.dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
    await submit();
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /请重试/,
    );
    assert.equal(form.querySelector('[name="apiKey"]').value, "fake-ui-only");
    await submit();
    assert.equal(document.querySelector('[name="apiKey"]'), null);
    assert.equal(
      document.querySelector('[aria-label="当前对话主模型"]').value,
      "new",
    );
    assert.deepEqual(selected, []);
    assert.equal(requests[1].apiFormat, "chat_completions");
    assert.deepEqual(
      Object.keys(requests[1]).sort(),
      ["action", "apiFormat", "apiKey", "baseUrl", "model", "service"].sort(),
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test("失败重试禁止选用失败连接，原来的重试操作仍然独立可用", async () => {
  const root = createRoot(document.getElementById("root"));
  const selected = [];
  await act(async () =>
    root.render(
      React.createElement(Picker, {
        inline: true,
        catalog: initial,
        selected: "xingchi",
        failedId: "xingchi",
        onChoose: (id) => selected.push(id),
        onCatalog() {},
        call() {},
      }),
    ),
  );
  try {
    const field = document.querySelector('[aria-label="重试主模型"]');
    assert.equal(field.value, "deepseek");
    assert.equal(field.querySelector('[value="xingchi"]').disabled, true);
    await act(async () => button("切换并重试").click());
    assert.deepEqual(selected, ["deepseek"]);
    assert.equal(
      document.querySelector('[aria-label="新对话默认模型"]').value,
      "xingchi",
    );
  } finally {
    await act(async () => root.unmount());
  }
});
