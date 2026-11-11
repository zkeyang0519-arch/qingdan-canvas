import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
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
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
const dir = mkdtempSync(resolve("node_modules/.cache/agent-device-ui-"));
await build({
  entryPoints: [resolve("src/agent/DevicePanel.jsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
});
const { default: DevicePanel } = await import(
  pathToFileURL(resolve(dir, "ui.mjs"))
);
rmSync(dir, { recursive: true, force: true });
const button = (name) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === name,
  );
const click = async (node) => {
  assert.ok(node);
  await act(async () => node.click());
};
const input = async (label, value) => {
  const el = document.querySelector(`[aria-label="${label}"]`);
  assert.ok(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};
async function mount(props) {
  const root = createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(
      React.createElement(DevicePanel, {
        roomId: "canvas",
        userId: "alice",
        pages: [{ id: "section", title: "当前清单" }],
        ...props,
      }),
    ),
  );
  return () => act(async () => root.unmount());
}
function fixture() {
  const calls = [];
  let binding = null;
  let local = {
    paired: false,
    ownerId: null,
    runnerId: null,
    deviceName: "测试电脑",
    enabled: true,
    connectionStatus: "unpaired",
    connectionEpoch: 0,
    lastHeartbeatAt: null,
    workspaces: [],
    error: null,
    credentialStorage: "windows-credential-manager",
  };
  const requestCloud = async (route, options) => {
    calls.push({ route, body: options?.body });
    if (route.endsWith("/pairings"))
      return {
        pairingCode: "ABCD".repeat(8),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
    if (route.endsWith("/revoke")) {
      local = { ...local, connectionStatus: "revoked" };
      return { ok: true };
    }
    if (route === "/api/agent/bindings" && options?.method === "POST") {
      binding = {
        ...options.body,
        ownerId: "alice",
        bindingId: "binding",
        revision: 1,
        enabled: true,
      };
      return { binding };
    }
    if (route.startsWith("/api/agent/bindings")) return { binding };
    return {
      enabled: true,
      devices: local.paired
        ? [
            {
              ...local,
              status:
                local.connectionStatus === "online"
                  ? "online"
                  : local.connectionStatus === "revoked"
                    ? "revoked"
                    : "offline",
              authEpoch: 1,
            },
          ]
        : [],
    };
  };
  const requestLocal = async (route, options) => {
    calls.push({ route, body: options?.body, accountId: options?.accountId });
    if (route === "/pair")
      local = {
        ...local,
        paired: true,
        ownerId: "alice",
        runnerId: "device",
        connectionStatus: "online",
        connectionEpoch: 1,
      };
    if (route === "/workspaces")
      local = {
        ...local,
        workspaces: [
          {
            workspaceId: "workspace",
            name: "允许的项目",
            displayPath: options.body.root,
            revision: 1,
            checks: [],
          },
        ],
      };
    if (route === "/connection")
      local = {
        ...local,
        enabled: options.body.enabled,
        connectionStatus: options.body.enabled ? "online" : "offline",
      };
    if (route === "/reconnect")
      local = {
        ...local,
        connectionStatus: "online",
        enabled: true,
        connectionEpoch: local.connectionEpoch + 1,
      };
    if (route === "/forget")
      local = {
        ...local,
        paired: false,
        ownerId: null,
        runnerId: null,
        workspaces: [],
        connectionStatus: "unpaired",
      };
    return local;
  };
  return { requestCloud, requestLocal, calls };
}

test("revoked device exposes authenticated reset with the old identity and retries a lost ACK", async () => {
  const calls = [];
  let attempts = 0;
  let local = {
    paired: true,
    runnerId: "old-device",
    ownerId: "alice",
    deviceName: "PC",
    enabled: true,
    connectionStatus: "offline",
    workspaces: [],
    error: "credential unavailable",
  };
  const close = await mount({
    requestCloud: async (route) =>
      route.startsWith("/api/agent/bindings")
        ? { binding: null }
        : {
            enabled: true,
            devices: [
              {
                runnerId: "old-device",
                ownerId: "alice",
                status: "revoked",
                authEpoch: 2,
              },
            ],
          },
    requestLocal: async (route, options) => {
      if (route === "/reset") {
        calls.push(options);
        attempts++;
        local = {
          ...local,
          paired: false,
          runnerId: null,
          connectionStatus: "unpaired",
        };
        if (attempts === 1) throw Error("response lost");
      }
      return local;
    },
  });
  try {
    await click(button("核对并重置本机绑定"));
    assert.match(document.body.textContent, /response lost/);
    await click(button("核对并重置本机绑定"));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.accountId, "alice");
      assert.deepEqual(call.body, { expectedRunnerId: "old-device" });
    }
    assert.match(document.body.textContent, /尚未绑定/);
  } finally {
    await close();
  }
});

test("formal settings select the currently bound workspace and notify only a confirmed rebind", async () => {
  const workspaces = [
    { workspaceId: "first", name: "另一个目录" },
    { workspaceId: "current", name: "当前项目目录" },
  ];
  let binding = {
    bindingId: "binding",
    revision: 1,
    runnerId: "device",
    workspaceId: "current",
    enabled: true,
  };
  const changes = [];
  const close = await mount({
    embedded: true,
    initialPageId: "section",
    onBindingChanged: (next) => changes.push(next),
    requestLocal: async () => ({
      paired: true,
      runnerId: "device",
      connectionStatus: "online",
      workspaces,
    }),
    requestCloud: async (route, options) => {
      if (route === "/api/agent/devices")
        return { enabled: true, devices: [{ runnerId: "device", workspaces }] };
      if (options?.method === "POST")
        binding = { ...binding, ...options.body, revision: 2 };
      return { binding };
    },
  });
  try {
    const select = document.querySelector('[aria-label="选择执行项目"]');
    assert.equal(select.value, "current");
    assert.equal(changes.length, 0);
    assert.doesNotMatch(document.body.textContent, /本步骤|下一步接入/);
    await act(async () => {
      select.value = "first";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await click(button("绑定到当前清单"));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].workspaceId, "first");
  } finally {
    await close();
  }
});
test("pairing, allowed project and current-list binding are usable from the panel", async () => {
  const f = fixture();
  const unmount = await mount(f);
  try {
    assert.match(document.body.textContent, /尚未绑定/);
    await click(button("绑定这台电脑"));
    assert.match(document.body.textContent, /已绑定/);
    assert.equal(
      f.calls.filter((c) => c.route.endsWith("/pairings")).length,
      1,
    );
    assert.equal(
      f.calls.find((c) => c.route === "/pair").body.pairingCode,
      "ABCD".repeat(8),
    );
    await input("允许执行的项目目录", "D:/my-project");
    await click(button("添加项目"));
    assert.match(document.body.textContent, /D:\/my-project/);
    await click(button("绑定到当前清单"));
    const bind = f.calls.find(
      (c) => c.route === "/api/agent/bindings" && c.body,
    );
    assert.deepEqual(bind.body, {
      canvasId: "canvas",
      sectionId: "section",
      runnerId: "device",
      workspaceId: "workspace",
      expectedRevision: null,
    });
    assert.match(document.body.textContent, /当前清单已绑定/);
    assert.ok(
      f.calls
        .filter((c) => c.route.startsWith("/") && !c.route.startsWith("/api/"))
        .every((c) => c.accountId === "alice"),
    );
  } finally {
    await unmount();
  }
});
test("disconnect/reconnect and revocation show real returned states", async () => {
  const f = fixture();
  await f.requestLocal("/pair");
  const unmount = await mount(f);
  try {
    await click(button("暂时断开"));
    assert.match(document.body.textContent, /离线/);
    await click(button("继续连接"));
    assert.match(document.body.textContent, /在线/);
    await click(button("重新连接"));
    await click(button("解除绑定"));
    await click(button("确认解除绑定"));
    assert.match(document.body.textContent, /尚未绑定/);
    assert.equal(
      f.calls.some((c) => c.route.endsWith("/revoke")),
      false,
      "the browser must not revoke before the local execution safety guard",
    );
    assert.deepEqual(f.calls.find((c) => c.route === "/forget").body, {
      expectedRunnerId: "device",
    });
  } finally {
    await unmount();
  }
});
test("a delayed unpaired poll cannot overwrite an accepted pairing", async () => {
  const f = fixture();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let poll,
    release,
    statusCalls = 0;
  globalThis.setInterval = (callback) => {
    poll = callback;
    return 1;
  };
  globalThis.clearInterval = () => {};
  const requestLocal = async (route, options) => {
    const value = await f.requestLocal(route, options);
    if (route === "/status" && ++statusCalls === 2)
      return new Promise((resolve) => {
        release = () => resolve(value);
      });
    return value;
  };
  let unmount;
  try {
    unmount = await mount({ ...f, requestLocal });
    await act(async () => {
      poll();
    });
    assert.equal(typeof release, "function");
    await click(button("绑定这台电脑"));
    assert.ok(button("暂时断开"));
    await act(async () => release());
    assert.ok(button("暂时断开"));
    assert.equal(button("绑定这台电脑"), undefined);
  } finally {
    await unmount?.();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("a missing local Runner cannot be represented as a paired online computer", async () => {
  const unmount = await mount({
    requestCloud: async () => ({ enabled: true, devices: [] }),
    requestLocal: async () => {
      throw Error("本机 Runner 尚未启动");
    },
  });
  try {
    assert.match(document.body.textContent, /npm run agent:start/);
    assert.equal(button("绑定这台电脑").disabled, true);
    assert.match(document.body.textContent, /本机 Runner 尚未启动/);
  } finally {
    await unmount();
  }
});

test("a different device owner is explained without suggesting that the service is stopped or allowing takeover", async () => {
  const unmount = await mount({
    requestCloud: async () => ({ enabled: true, devices: [] }),
    requestLocal: async () => {
      throw Object.assign(
        Error("这台电脑已绑定其他轻单账号。请先在原账号解除绑定。"),
        {
          code: "OWNER_MISMATCH",
        },
      );
    },
  });
  try {
    assert.match(document.body.textContent, /电脑绑定账号不一致/);
    assert.match(document.body.textContent, /已绑定其他轻单账号/);
    assert.doesNotMatch(
      document.body.textContent,
      /需要启动本机服务|npm run agent:start/,
    );
    assert.equal(button("绑定这台电脑").disabled, true);
  } finally {
    await unmount();
  }
});

test("changing account while pairing waits for cloud cannot bind the old account afterward", async () => {
  const f = fixture();
  let release;
  const requestCloud = async (route, options) => {
    if (route.endsWith("/pairings"))
      return new Promise((resolve) => {
        release = () => resolve({ pairingCode: "old-code" });
      });
    return f.requestCloud(route, options);
  };
  const root = createRoot(document.getElementById("root"));
  const render = (userId) =>
    act(async () =>
      root.render(
        React.createElement(DevicePanel, {
          ...f,
          requestCloud,
          userId,
          roomId: "canvas",
          pages: [{ id: "section" }],
        }),
      ),
    );
  try {
    await render("alice");
    await click(button("绑定这台电脑"));
    assert.equal(typeof release, "function");
    await render("bob");
    await act(async () => release());
    assert.equal(f.calls.filter((call) => call.route === "/pair").length, 0);
    assert.doesNotMatch(document.body.textContent, /已绑定当前轻单账号/);
    assert.equal(button("绑定这台电脑").disabled, false);
  } finally {
    await act(async () => root.unmount());
  }
});
