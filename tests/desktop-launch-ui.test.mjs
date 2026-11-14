import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1:8790/app",
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "Node",
  "Event",
  "MouseEvent",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/desktop-launch-ui-", import.meta.url),
);
await build({
  stdin: {
    contents:
      'export { default as DesktopLaunchButton } from "./src/desktop/DesktopLaunchButton.jsx";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "omit-css",
      setup(builder) {
        builder.onResolve({ filter: /\.css$/ }, (args) => ({
          path: args.path,
          namespace: "css",
        }));
        builder.onLoad({ filter: /.*/, namespace: "css" }, () => ({
          contents: "",
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "button.mjs"),
});
const { DesktopLaunchButton } = await import(
  pathToFileURL(path.join(output, "button.mjs"))
);
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});

async function mount(t, origin = "http://127.0.0.1:8790") {
  dom.reconfigure({ url: `${origin}/app?room=test-room` });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let disposed = false;
  const render = async (id = "account-a", roomId = "test-room") =>
    act(async () =>
      root.render(
        React.createElement(DesktopLaunchButton, {
          user: { id },
          room: { id: roomId },
        }),
      ),
    );
  const dispose = async () => {
    if (!disposed) {
      disposed = true;
      await act(async () => root.unmount());
      host.remove();
    }
  };
  t.after(dispose);
  await render();
  return {
    host,
    render,
    dispose,
    button: () => host.querySelector('button[aria-label="轻岛"]'),
  };
}
async function click(button) {
  assert.ok(button);
  await act(async () =>
    button.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}
const status = () => document.querySelector('[aria-label="轻岛启动状态"]');
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("8790入口发送当前账号画布，收到applied确认后才提示已打开", async (t) => {
  const response = deferred();
  const calls = [];
  t.mock.method(globalThis, "fetch", (...args) => {
    calls.push(args);
    return response.promise;
  });
  const fixture = await mount(t);
  await click(fixture.button());
  await click(fixture.button());
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, "/api/local-desktop/launch");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), { roomId: "test-room" });
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.headers["X-Qingdan-Local"], "1");
  assert.equal(options.headers["X-QD-Account"], "account-a");
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.equal(fixture.button().disabled, true);
  await act(async () =>
    response.resolve(Response.json({ started: true, applied: true })),
  );
  assert.equal(fixture.button().disabled, false);
  assert.match(status().textContent, /已打开当前画布的轻岛。/);
  assert.doesNotMatch(status().textContent, /首次.*登录/);
  await click(document.querySelector('[aria-label="关闭轻岛启动提示"]'));
  assert.equal(status(), null);
});

for (const port of [8788, 5178]) {
  test(`${port}网页使用固定8790入口并携带跨端口凭据`, async (t) => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (...args) => {
      calls.push(args);
      return Response.json({ started: true, applied: true });
    });
    const fixture = await mount(t, `http://127.0.0.1:${port}`);
    await click(fixture.button());
    assert.equal(
      calls[0]?.[0],
      "http://127.0.0.1:8790/api/local-desktop/launch",
    );
    assert.equal(calls[0][1].credentials, "include");
    assert.equal(calls[0][1].headers["X-QD-Account"], "account-a");
  });
}

for (const origin of ["http://localhost:8790"]) {
  test(`${origin}不主动请求本机端口，只给出本机入口`, async (t) => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (...args) => {
      calls.push(args);
      return Response.json({ started: true, applied: true });
    });
    const fixture = await mount(t, origin);
    await click(fixture.button());
    assert.equal(calls.length, 0);
    assert.match(status()?.textContent || "", /本机入口/);
    assert.equal(status().querySelector("a").href, "http://127.0.0.1:8790/app");
  });
}

test("线上按钮通过一次性交接直接打开当前账号画布，等待桌面确认且不打开新页面", async (t) => {
  const calls = [],
    applied = deferred();
  t.mock.method(window, "open", () => {
    throw Error("must not open another page");
  });
  t.mock.method(globalThis, "fetch", async (...args) => {
    calls.push(args);
    if (calls.length === 1)
      return Response.json({
        requestId: "a".repeat(32),
        challenge: "b".repeat(64),
      });
    if (calls.length === 2)
      return Response.json({ ticket: "c".repeat(64) }, { status: 201 });
    return applied.promise;
  });
  const f = await mount(t, "https://qingdan-canvas.zkeyang0519.workers.dev");
  await click(f.button());
  assert.equal(calls.length, 3);
  assert.equal(
    calls[0][0],
    "http://127.0.0.1:8791/api/local-desktop/online/prepare",
  );
  assert.equal(calls[0][1].credentials, "omit");
  assert.equal(calls[0][1].targetAddressSpace, "loopback");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    accountId: "account-a",
    roomId: "test-room",
  });
  assert.equal(calls[1][0], "/api/desktop/handoff");
  assert.equal(calls[1][1].credentials, "same-origin");
  assert.equal(calls[1][1].headers["X-QD-Account"], "account-a");
  assert.equal(f.button().disabled, true);
  assert.equal(status().querySelector("a"), null);
  await act(async () =>
    applied.resolve(Response.json({ started: true, applied: true })),
  );
  assert.match(status().textContent, /已打开/);
});

test("线上交接等待期间换账号或画布，旧授权不得继续交给本机", async (t) => {
  const calls = [],
    ticket = deferred();
  t.mock.method(globalThis, "fetch", (...args) => {
    calls.push(args);
    return calls.length === 1
      ? Promise.resolve(
          Response.json({
            requestId: "a".repeat(32),
            challenge: "b".repeat(64),
          }),
        )
      : ticket.promise;
  });
  const f = await mount(t, "https://qingdan-canvas.zkeyang0519.workers.dev");
  await click(f.button());
  assert.equal(calls.length, 2);
  await f.render("account-b", "other-room");
  assert.equal(calls[1][1].signal.aborted, true);
  await act(async () =>
    ticket.resolve(Response.json({ ticket: "c".repeat(64) })),
  );
  assert.equal(calls.length, 2);
  assert.equal(status(), null);
});

test("线上未连接到已安装应用时说明浏览器权限并提供首次安装入口", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  const f = await mount(t, "https://qingdan-canvas.zkeyang0519.workers.dev");
  await click(f.button());
  assert.match(status().textContent, /尚未连接到轻岛/);
  assert.match(status().textContent, /浏览器|权限/);
  assert.equal(
    status().querySelector("a").href,
    "https://github.com/zkeyang0519-arch/qingdan-canvas/releases/latest",
  );
  assert.match(status().textContent, /已安装，打开轻岛/);
});

test("服务不可达、认证失败和未确认启动都提供准确失败提示", async (t) => {
  const outcomes = [
    () => Promise.reject(new TypeError("Failed to fetch")),
    () =>
      Promise.resolve(
        Response.json({ error: "请先在本机入口登录当前账号" }, { status: 401 }),
      ),
    () => Promise.resolve(Response.json({ started: false })),
    () => Promise.resolve(Response.json({ started: true })),
    () =>
      Promise.resolve(Response.json({ error: "找不到接口" }, { status: 404 })),
  ];
  let expired = 0;
  const listener = () => {
    expired++;
  };
  window.addEventListener("qingdan-session-expired", listener);
  t.after(() =>
    window.removeEventListener("qingdan-session-expired", listener),
  );
  t.mock.method(globalThis, "fetch", () => outcomes.shift()());
  const fixture = await mount(t);
  await click(fixture.button());
  assert.match(status()?.textContent || "", /无法连接本机/);
  assert.ok(status().querySelector("a"));
  await click(fixture.button());
  assert.match(status().textContent, /请先在本机入口登录当前账号/);
  assert.equal(
    expired,
    0,
    "local login failure must not expire a different page session",
  );
  await click(fixture.button());
  assert.match(status().textContent, /未确认启动/);
  assert.equal(fixture.button().disabled, false);
  await click(fixture.button());
  assert.match(status().textContent, /未确认启动/);
  await click(fixture.button());
  assert.match(status().textContent, /请重启本机轻单服务/);
});

test("账号切换和卸载取消等待，旧启动回包不会覆盖新账号状态", async (t) => {
  const first = deferred(),
    second = deferred();
  const calls = [];
  t.mock.method(globalThis, "fetch", (...args) => {
    calls.push(args);
    return calls.length === 1 ? first.promise : second.promise;
  });
  const fixture = await mount(t);
  await click(fixture.button());
  await fixture.render("account-b");
  assert.equal(calls[0][1].signal.aborted, true);
  assert.equal(fixture.button().disabled, false);
  await act(async () =>
    first.resolve(Response.json({ error: "旧账号已过期" }, { status: 401 })),
  );
  assert.equal(status(), null);
  await click(fixture.button());
  assert.equal(calls[1][1].headers["X-QD-Account"], "account-b");
  await fixture.dispose();
  assert.equal(calls[1][1].signal.aborted, true);
  await act(async () =>
    second.resolve(Response.json({ started: true, applied: true })),
  );
  assert.equal(status(), null);
});

test("同账号切换画布取消旧启动请求，旧ACK不会显示在新画布", async (t) => {
  const first = deferred();
  const calls = [];
  t.mock.method(globalThis, "fetch", (...args) => {
    calls.push(args);
    return calls.length === 1
      ? first.promise
      : Promise.resolve(Response.json({ started: true, applied: true }));
  });
  const fixture = await mount(t);
  await click(fixture.button());
  await fixture.render("account-a", "next-room");
  assert.equal(calls[0][1].signal.aborted, true);
  await act(async () =>
    first.resolve(Response.json({ started: true, applied: true })),
  );
  assert.equal(status(), null);
  await click(fixture.button());
  assert.deepEqual(JSON.parse(calls[1][1].body), { roomId: "next-room" });
});
