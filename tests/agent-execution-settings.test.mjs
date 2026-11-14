import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import {
  defaultExecutionSettings,
  executionSettingsIssue,
  executionSettingsPayload,
  useCodexModelCatalog,
} from "../src/agent/execution-settings.js";

const dom = new JSDOM("<body></body>", { url: "http://127.0.0.1:8788" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const binding = { bindingId: "binding", revision: 1, runnerId: "runner" };
const models = [
  {
    id: "available-model",
    name: "Available",
    isDefault: true,
    supportsFast: true,
  },
];

async function mountCatalog(t, requestLocal) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let catalog;
  function Probe({ selectedBinding }) {
    catalog = useCodexModelCatalog(
      "account",
      selectedBinding,
      requestLocal,
      true,
    );
    return null;
  }
  const render = async (selectedBinding) => {
    await act(async () =>
      root.render(React.createElement(Probe, { selectedBinding })),
    );
  };
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await render(binding);
  return { read: () => catalog, render };
}

test("model catalog reads models only after confirming the bound runner", async (t) => {
  const calls = [];
  const catalog = await mountCatalog(t, async (route, options) => {
    calls.push({ route, options });
    if (route === "/status")
      return { runnerId: "runner", connectionStatus: "offline" };
    if (route === "/codex/models") return { models };
    throw Error(`Unexpected route: ${route}`);
  });
  assert.equal(catalog.read().status, "ready");
  assert.deepEqual(catalog.read().models, models);
  assert.deepEqual(calls, [
    { route: "/status", options: { accountId: "account" } },
    { route: "/codex/models", options: { accountId: "account" } },
  ]);
});

for (const [name, status] of [
  [
    "a different runner",
    { runnerId: "other-runner", connectionStatus: "online" },
  ],
  ["an unpaired runner", { runnerId: null, connectionStatus: "unpaired" }],
  ["an incomplete status", {}],
  ["an unavailable status", new Error("Local runner unavailable")],
]) {
  test(`model catalog rejects ${name} without reading its models`, async (t) => {
    const calls = [];
    const catalog = await mountCatalog(t, async (route) => {
      calls.push(route);
      if (route === "/status") {
        if (status instanceof Error) throw status;
        return status;
      }
      return { models };
    });
    assert.equal(catalog.read().status, "error");
    assert.ok(catalog.read().error);
    assert.deepEqual(catalog.read().models, []);
    assert.deepEqual(calls, ["/status"]);
    assert.equal(
      executionSettingsIssue(defaultExecutionSettings, catalog.read()),
      "",
    );
    assert.ok(
      executionSettingsIssue(
        { ...defaultExecutionSettings, model: "available-model" },
        catalog.read(),
      ),
    );
    assert.ok(
      executionSettingsIssue(
        { ...defaultExecutionSettings, fastMode: true },
        catalog.read(),
      ),
    );
  });
}

test("a late status for the previous binding cannot start another model lookup", async (t) => {
  let resolveFirst;
  const firstStatus = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let statuses = 0;
  const calls = [];
  const catalog = await mountCatalog(t, async (route) => {
    calls.push(route);
    if (route === "/status") {
      statuses++;
      return statuses === 1 ? firstStatus : { runnerId: "new-runner" };
    }
    return { models };
  });
  await catalog.render({ ...binding, revision: 2, runnerId: "new-runner" });
  await act(async () => resolveFirst({ runnerId: "runner" }));
  assert.equal(catalog.read().status, "ready");
  assert.deepEqual(catalog.read().models, models);
  assert.deepEqual(calls, ["/status", "/status", "/codex/models"]);
});

test("refresh retains the current project speed and a failed lookup inherits the native defaults", async (t) => {
  let complete;
  let lookups = 0;
  const current = { model: models[0].id, fastMode: true };
  const pending = new Promise((_resolve, reject) => {
    complete = reject;
  });
  const catalog = await mountCatalog(t, async (route) => {
    if (route === "/status") return { runnerId: "runner" };
    return lookups++ === 0 ? { models, current } : pending;
  });
  await act(async () => catalog.read().refresh());
  assert.equal(catalog.read().status, "loading");
  assert.deepEqual(
    executionSettingsPayload(defaultExecutionSettings, catalog.read()),
    current,
  );
  await act(async () => complete(Error("offline")));
  assert.equal(catalog.read().status, "error");
  assert.equal(
    executionSettingsPayload(defaultExecutionSettings, catalog.read()),
    undefined,
  );
});
