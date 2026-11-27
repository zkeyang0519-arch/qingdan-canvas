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

test("编辑预填已有连接，密钥不回显，保存失败保留表单，成功同步当前与默认选择", async () => {
  const root = createRoot(document.getElementById("root")),
    requests = [],
    selections = [];
  const profile = {
    id: "custom",
    service: "我的模型",
    model: "model-one",
    baseUrl: "https://one.example.com/v1",
    apiFormat: "responses",
    configured: true,
  };
  function App() {
    const [catalog, setCatalog] = useState({
      ...initial,
      defaultId: "custom",
      apiFormats: ["responses", "chat_completions"],
      profiles: [initial.profiles[0], profile],
    });
    const [selected, setSelected] = useState("custom");
    return React.createElement(Picker, {
      inline: true,
      catalog,
      selected,
      onChoose: (id) => selections.push(id),
      onCatalog: (next) => {
        setCatalog(next);
        if (next.updated) setSelected(next.updated);
      },
      call: async (_route, { body }) => {
        requests.push(body);
        if (requests.length === 1) throw Error("保存失败，请重试");
        return {
          ...catalog,
          updated: "updated",
          replaced: body.id,
          defaultId: "updated",
          profiles: [
            catalog.profiles[0],
            {
              ...profile,
              id: "updated",
              service: body.service,
              model: body.model,
              apiFormat: body.apiFormat,
            },
          ],
        };
      },
    });
  }
  await act(async () => root.render(React.createElement(App)));
  try {
    await act(async () =>
      document.querySelector('button[aria-controls$="-connections"]').click(),
    );
    await act(async () => button("编辑 我的模型 model-one").click());
    const form = document.querySelector(".qd-model-form");
    assert.equal(form.querySelector('[name="service"]').value, "我的模型");
    assert.equal(form.querySelector('[name="baseUrl"]').value, profile.baseUrl);
    assert.equal(form.querySelector('[name="model"]').value, "model-one");
    assert.equal(form.querySelector('[name="apiKey"]').value, "");
    assert.equal(form.querySelector('[name="apiKey"]').required, false);
    form.querySelector('[name="model"]').value = "model-two";
    form.querySelector('[name="apiFormat"]').value = "chat_completions";
    const submit = () =>
      act(async () =>
        form.dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
    await submit();
    assert.match(form.textContent, /保存失败/);
    assert.equal(form.querySelector('[name="model"]').value, "model-two");
    await submit();
    assert.equal(document.querySelector(".qd-model-form"), null);
    assert.equal(
      document.querySelector('[aria-label="当前对话主模型"]').value,
      "updated",
    );
    assert.equal(
      document.querySelector('[aria-label="新对话默认模型"]').value,
      "updated",
    );
    assert.deepEqual(selections, []);
    assert.equal(requests[1].action, "update");
    assert.equal(requests[1].id, "custom");
    assert.equal(requests[1].apiKey, "");
    assert.equal(requests[1].apiFormat, "chat_completions");
  } finally {
    await act(async () => root.unmount());
  }
});

test("删除连接需要明确点击，取消不发送，失败可重试且删除后不自动切换模型", async () => {
  const root = createRoot(document.getElementById("root")),
    requests = [],
    selections = [];
  function App() {
    const [catalog, setCatalog] = useState({
      ...initial,
      defaultId: "deepseek",
    });
    return React.createElement(Picker, {
      inline: true,
      catalog,
      selected: "deepseek",
      onChoose: (id) => selections.push(id),
      onCatalog: setCatalog,
      call: async (_path, { body }) => {
        requests.push(body);
        if (requests.length === 1) throw Error("这个连接还有任务正在运行");
        return {
          ...catalog,
          deleted: "deepseek",
          defaultId: "unselected",
          profiles: [catalog.profiles[0]],
        };
      },
    });
  }
  await act(async () => root.render(React.createElement(App)));
  try {
    await act(async () =>
      document.querySelector('button[aria-controls$="-connections"]').click(),
    );
    await act(async () => button("删除 DeepSeek 官方 deepseek-flash").click());
    assert.equal(requests.length, 0);
    assert.match(
      document.querySelector(".qd-connection-confirm").textContent,
      /聊天记录会保留/,
    );
    await act(async () => button("取消").click());
    assert.equal(requests.length, 0);
    await act(async () => button("删除 DeepSeek 官方 deepseek-flash").click());
    await act(async () => button("删除连接").click());
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /任务正在运行/,
    );
    await act(async () => button("删除连接").click());
    assert.equal(button("删除 DeepSeek 官方 deepseek-flash"), undefined);
    assert.equal(
      document.querySelector('[aria-label="新对话默认模型"]').value,
      "unselected",
    );
    assert.deepEqual(selections, []);
    assert.deepEqual(requests[1], { action: "delete", id: "deepseek" });
  } finally {
    await act(async () => root.unmount());
  }
});

test("编辑到新域名需明确沿用密钥，继续修改地址会重置该选择", async () => {
  const root = createRoot(document.getElementById("root"));
  const catalog = {
    ...initial,
    profiles: [
      initial.profiles[0],
      {
        id: "custom",
        service: "测试",
        model: "model",
        baseUrl: "https://one.example.com/v1",
        apiFormat: "responses",
        configured: true,
      },
    ],
  };
  await act(async () =>
    root.render(
      React.createElement(Picker, {
        inline: true,
        catalog,
        selected: "custom",
        onCatalog() {},
        onChoose() {},
        call() {
          throw Error("not submitted");
        },
      }),
    ),
  );
  const fill = async (value) =>
    act(async () => {
      const field = document.querySelector('[name="baseUrl"]');
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set.call(field, value);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  try {
    await act(async () =>
      document.querySelector('button[aria-controls$="-connections"]').click(),
    );
    await act(async () => button("编辑 测试 model").click());
    await fill("https://two.example.com/api/v3");
    assert.equal(button("保存修改").disabled, true);
    const checkbox = document.querySelector(".qd-model-key-reuse input");
    assert.ok(checkbox);
    await act(async () => checkbox.click());
    assert.equal(button("保存修改").disabled, false);
    await fill("https://three.example.com/api/v3");
    assert.equal(
      document.querySelector(".qd-model-key-reuse input").checked,
      false,
    );
    assert.equal(button("保存修改").disabled, true);
  } finally {
    await act(async () => root.unmount());
  }
});
