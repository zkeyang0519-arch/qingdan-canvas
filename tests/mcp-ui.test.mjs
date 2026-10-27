import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import React, { act } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://alias.test/",
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "getComputedStyle",
  "location",
  "history",
  "localStorage",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(new URL("../.tmp/mcp-ui-", import.meta.url));
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});
let appPromise;
async function appComponent() {
  appPromise ??= (async () => {
    await build({
      entryPoints: [fileURLToPath(new URL("../src/App.jsx", import.meta.url))],
      bundle: true,
      jsx: "automatic",
      packages: "external",
      platform: "node",
      format: "esm",
      loader: { ".css": "empty" },
      outfile: path.join(output, "app.mjs"),
      plugins: [
        {
          name: "unrelated-canvas",
          setup(builder) {
            builder.onResolve({ filter: /CanvasWorkspace\.jsx$/ }, () => ({
              path: "canvas",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents:
                'export default function Canvas(){throw new Error("Consent must not enter canvas")}',
            }));
          },
        },
      ],
    });
    return (await import(pathToFileURL(path.join(output, "app.mjs")))).default;
  })();
  return appPromise;
}
const user = { id: "account-a", name: "阿青", username: "qing" };
const other = { id: "account-b", name: "另一账号", username: "other" };
const room = { id: "room-a", name: "春日计划", role: "owner" };
const consent = (extra = {}) => ({
  handle: "opaque",
  csrf: "csrf-from-server",
  expires_at: Date.now() + 600000,
  account: user,
  client: {
    id: "actual-client-id",
    name: "<img src=x onerror=alert(1)>",
    domain: "client.example",
    redirect_host: "127.0.0.1",
    redirect_is_loopback: true,
    name_verified: false,
  },
  requested_scopes: ["qingdan:read"],
  supported_scopes: ["qingdan:read", "qingdan:write", "offline_access"],
  resource: "https://canonical.test/mcp",
  canvases: [{ canvas_id: room.id, name: room.name, role: room.role }],
  ...extra,
});
const grant = (extra = {}) => ({
  id: "grant-a",
  client_id: "actual-client-id",
  resource: "https://canonical.test/mcp",
  scopes: ["qingdan:read", "qingdan:write"],
  state: "active",
  created_at: Date.now() - 10000,
  expires_at: Date.now() + 300000,
  revoked_at: null,
  last_used_at: null,
  client: {
    id: "actual-client-id",
    name: "Unknown Agent",
    domain: "client.example",
    name_verified: false,
  },
  canvases: [{ canvas_id: room.id, name: room.name, role: room.role }],
  ...extra,
});
const operation = (extra = {}) => ({
  operation_id: "op-a",
  tool: "delete_task",
  client_id: "actual-client-id",
  created_at: new Date().toISOString(),
  result: {
    canvas_id: room.id,
    note_id: "note-a",
    revision: 2,
    changed: true,
    task_count: 1,
  },
  restorable_until: new Date(Date.now() + 86400000).toISOString(),
  restored: false,
  ...extra,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function mount(t, handler, url = "/mcp/consent?handle=opaque") {
  history.replaceState(null, "", url);
  const requests = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const request = {
      url,
      ...options,
      body: options?.body ? JSON.parse(options.body) : undefined,
    };
    requests.push(request);
    return (await handler(request)) ?? json({});
  };
  const App = await appComponent();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = previous;
  });
  await act(async () => root.render(React.createElement(App)));
  await flush();
  return { host, requests };
}
function button(host, text) {
  const found = [...host.querySelectorAll("button")].find((node) =>
    node.textContent.includes(text),
  );
  assert.ok(found, `Button ${text} exists`);
  return found;
}
async function click(node) {
  await act(async () => node.click());
}
function input(host, text) {
  const label = [...host.querySelectorAll("label")].find((node) =>
    node.textContent.trim().startsWith(text),
  );
  assert.ok(label, `Label ${text} exists`);
  return label.querySelector("input, select");
}
async function fill(node, value) {
  await act(async () => {
    const proto =
      node.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(
      new Event(node.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function submit(form) {
  await act(async () =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
}
const consentHandler = (r) => {
  if (r.url === "/api/session") return json({ user });
  if (r.url === "/api/rooms") return json({ rooms: [room] });
  if (r.url === "/api/mcp/consent/opaque" && r.method !== "POST")
    return json(consent());
};
async function openConnections(host) {
  await click(button(host, user.name));
  const summary = [...host.querySelectorAll("summary")].find((node) =>
    node.textContent.includes("Agent 连接"),
  );
  assert.ok(summary, "Profile exposes Agent connections");
  await click(summary);
  await flush();
}

test("专用授权路由在登录后继续，忽略同 URL 的画布和邀请", async (t) => {
  let loggedIn = false;
  const f = await mount(
    t,
    (r) => {
      if (r.url === "/api/session")
        return json({ user: loggedIn ? user : null });
      if (r.url === "/api/auth/login") {
        loggedIn = true;
        return json({ user });
      }
      return consentHandler(r);
    },
    "/mcp/consent?handle=opaque&room=private#invite=secret",
  );
  assert.match(f.host.textContent, /登录/);
  await fill(input(f.host, "用户名"), "qing");
  await fill(input(f.host, "密码"), "test-password");
  await submit(f.host.querySelector("form"));
  await flush();
  assert.match(f.host.textContent, /授权 Agent/);
  assert.equal(location.pathname, "/mcp/consent");
  assert.equal(
    f.requests.some((r) => r.url === "/api/rooms" || r.url.includes("/join")),
    false,
  );
});

test("授权展示真实账号、未验证名称、客户端标识、域名、回调主机及规范资源", async (t) => {
  const { host } = await mount(t, consentHandler);
  for (const value of [
    user.name,
    user.username,
    "actual-client-id",
    "client.example",
    "127.0.0.1",
    "https://canonical.test/mcp",
    "未经验证",
    "本机",
    "任务",
    "便签",
  ])
    assert.ok(host.textContent.includes(value), value);
  assert.ok(host.textContent.includes("<img src=x onerror=alert(1)>"));
  assert.equal(host.querySelector("img[src=x]"), null);
  assert.equal(input(host, "只读").checked, true);
  assert.equal(input(host, "读写").checked, false);
  assert.equal(input(host, room.name).checked, false);
  assert.equal(button(host, "允许访问").disabled, true);
});

test("显式选择当前画布及读写后带 CSRF 提交；重复提交被拦截，失败后可重试", async (t) => {
  const pending = deferred();
  let posts = 0;
  const { host, requests } = await mount(t, (r) => {
    if (r.method === "POST") {
      posts++;
      return posts === 1 ? pending.promise : json({ error: "请重试" }, 503);
    }
    return consentHandler(r);
  });
  await click(input(host, room.name));
  await click(input(host, "读写"));
  const requested = host.querySelector('[aria-label="客户端请求的权限"]');
  assert.ok(
    requested,
    "Original requested permissions remain visible after changing selection",
  );
  assert.match(requested.textContent, /只读/);
  const form = button(host, "允许访问").closest("form");
  await submit(form);
  await submit(form);
  assert.equal(posts, 1);
  const request = requests.find((r) => r.method === "POST");
  assert.deepEqual(request.body, {
    decision: "approve",
    scopes: ["qingdan:read", "qingdan:write"],
    canvas_ids: ["room-a"],
    csrf: "csrf-from-server",
  });
  assert.equal(request.headers["X-QD-Account"], user.id);
  pending.resolve(json({ error: "暂时无法授权" }, 503));
  await flush();
  assert.match(
    host.querySelector('[role="alert"]').textContent,
    /暂时无法授权/,
  );
  assert.equal(button(host, "允许访问").disabled, false);
  await submit(form);
  assert.equal(posts, 2);
});

test("没有画布时有帮助信息，允许不可用，拒绝仍可提交并清理授权路由", async (t) => {
  const { host, requests } = await mount(t, (r) => {
    if (r.method === "POST")
      return json({
        redirect_to: "https://client.example/callback?error=access_denied",
      });
    if (r.url.startsWith("/api/mcp/")) return json(consent({ canvases: [] }));
    return consentHandler(r);
  });
  assert.match(host.textContent, /没有可授权的画布/);
  assert.equal(button(host, "允许访问").disabled, true);
  await click(button(host, "拒绝"));
  assert.deepEqual(requests.find((r) => r.method === "POST").body, {
    decision: "deny",
    scopes: [],
    canvas_ids: [],
    csrf: "csrf-from-server",
  });
  assert.equal(location.pathname, "/");
  assert.equal(location.search, "");
  assert.match(host.textContent, /我的画布/);
});

test("会话过期后旧授权 GET 不能出现在新账号页面", async (t) => {
  const old = deferred();
  let account = user;
  const { host } = await mount(t, (r) => {
    if (r.url === "/api/session") return json({ user: account });
    if (r.url === "/api/auth/login") return json({ user: account });
    if (r.url.startsWith("/api/mcp/"))
      return account === user
        ? old.promise
        : json(
            consent({
              account: other,
              client: { ...consent().client, name: "New agent" },
            }),
          );
    return consentHandler(r);
  });
  await act(async () =>
    window.dispatchEvent(new Event("qingdan-session-expired")),
  );
  account = other;
  await fill(input(host, "用户名"), "other");
  await fill(input(host, "密码"), "test-password");
  await submit(host.querySelector("form"));
  await flush();
  old.resolve(
    json(
      consent({ client: { ...consent().client, name: "PRIVATE OLD AGENT" } }),
    ),
  );
  await flush();
  assert.match(host.textContent, /New agent/);
  assert.equal(host.textContent.includes("PRIVATE OLD AGENT"), false);
});

test("连接分页、有效期判断及显式撤销，展示服务器资源和设备替换说明", async (t) => {
  const { host, requests } = await mount(
    t,
    (r) => {
      if (r.url.startsWith("/api/profile/mcp-grants?"))
        return json({
          enabled: true,
          resource: "https://canonical.test/mcp",
          items: [
            grant(
              r.url.includes("cursor=")
                ? { id: "grant-b", expires_at: Date.now() - 1 }
                : {},
            ),
          ],
          next_cursor: r.url.includes("cursor=") ? null : "grant cursor+",
        });
      if (r.method === "DELETE") return json({ ok: true });
      return consentHandler(r);
    },
    "/",
  );
  await openConnections(host);
  for (const value of [
    "https://canonical.test/mcp",
    "actual-client-id",
    "未经验证",
    "client.example",
    "同一客户端",
    "设备",
    "尚未使用",
    room.name,
  ])
    assert.ok(host.textContent.includes(value), value);
  await click(button(host, "更多连接"));
  assert.ok(requests.some((r) => r.url.includes("cursor=grant+cursor%2B")));
  assert.match(host.textContent, /已到期/);
  await click(button(host, "撤销连接"));
  assert.equal(
    requests.some((r) => r.method === "DELETE"),
    false,
  );
  await click(button(host, "确认撤销"));
  assert.equal(
    requests.find((r) => r.method === "DELETE").url,
    "/api/profile/mcp-grants/grant-a",
  );
  assert.match(host.textContent, /已撤销/);
});

test("服务停用且没有有效连接时仍可分页查看本人历史并恢复删除，错误可重试", async (t) => {
  let restoreCount = 0;
  const { host, requests } = await mount(
    t,
    (r) => {
      if (r.url.startsWith("/api/profile/mcp-grants?"))
        return json({
          enabled: false,
          resource: "https://canonical.test/mcp",
          items: [grant({ state: "revoked" })],
          next_cursor: null,
        });
      if (r.url.endsWith("/restore"))
        return ++restoreCount === 1
          ? json({ error: "便签已锁定", code: "LOCKED", retryable: false }, 409)
          : json({
              canvas_id: room.id,
              operation_id: "op-a",
              sequence: 8,
              notes: [{ note_id: "note-a", revision: 3 }],
              task_ids: ["task-a"],
              changed: true,
            });
      if (r.url.includes("mcp-operations?"))
        return json({
          items: [
            operation(
              r.url.includes("cursor=")
                ? {
                    operation_id: "op-expired",
                    restorable_until: "2000-01-01T00:00:00.000Z",
                  }
                : {},
            ),
          ],
          next_cursor: r.url.includes("cursor=") ? null : "audit cursor+",
        });
      return consentHandler(r);
    },
    "/",
  );
  await openConnections(host);
  assert.match(host.textContent, /已停用/);
  await fill(input(host, "操作记录画布"), room.id);
  await flush();
  assert.match(host.textContent, /删除任务/);
  assert.match(host.textContent, /恢复截止/);
  await click(button(host, "更多操作"));
  assert.ok(requests.some((r) => r.url.includes("cursor=audit+cursor%2B")));
  assert.match(host.textContent, /恢复期限已过/);
  assert.equal(
    [...host.querySelectorAll("button")].filter(
      (b) => b.textContent === "恢复删除",
    ).length,
    1,
  );
  await click(button(host, "恢复删除"));
  assert.match(host.textContent, /便签已锁定/);
  await click(button(host, "恢复删除"));
  assert.match(
    host.querySelector('.mcp-history > [role="status"]').textContent,
    /已恢复 1 段删除内容/,
  );
  const restores = requests.filter((r) => r.url.endsWith("/restore"));
  assert.equal(
    restores[0].url,
    "/api/rooms/room-a/mcp-operations/op-a/restore",
  );
  assert.ok(restores[0].body.request_id.length > 0);
});

test("切换历史画布后旧请求结果不能覆盖新画布", async (t) => {
  const old = deferred();
  const { host } = await mount(
    t,
    (r) => {
      if (r.url.startsWith("/api/profile/mcp-grants?"))
        return json({
          enabled: true,
          resource: null,
          items: [],
          next_cursor: null,
        });
      if (r.url === "/api/rooms")
        return json({
          rooms: [room, { id: "room-b", name: "夏日计划", role: "editor" }],
        });
      if (r.url.startsWith("/api/rooms/room-a/mcp-operations"))
        return old.promise;
      if (r.url.startsWith("/api/rooms/room-b/mcp-operations"))
        return json({
          items: [operation({ operation_id: "op-b", client_id: "NEW CLIENT" })],
          next_cursor: null,
        });
      return consentHandler(r);
    },
    "/",
  );
  await openConnections(host);
  await fill(input(host, "操作记录画布"), "room-a");
  await fill(input(host, "操作记录画布"), "room-b");
  await flush();
  old.resolve(
    json({
      items: [operation({ client_id: "PRIVATE OLD CLIENT" })],
      next_cursor: null,
    }),
  );
  await flush();
  assert.match(host.textContent, /NEW CLIENT/);
  assert.equal(host.textContent.includes("PRIVATE OLD CLIENT"), false);
});

test("同账号修改密码会更新会话边界，旧连接 401 不会注销新会话", async (t) => {
  const old = deferred();
  let reads = 0;
  const { host } = await mount(
    t,
    (r) => {
      if (r.url.startsWith("/api/profile/mcp-grants?"))
        return reads++ === 0
          ? old.promise
          : json({
              enabled: true,
              resource: "https://canonical.test/mcp",
              items: [
                grant({
                  client: { ...grant().client, name: "Renewed session agent" },
                }),
              ],
              next_cursor: null,
            });
      if (r.url === "/api/auth/password")
        return json({ user: { ...user, name: "密码已更新的阿青" } });
      return consentHandler(r);
    },
    "/",
  );
  await openConnections(host);
  await fill(input(host, "当前密码"), "current-password");
  await fill(input(host, "新密码"), "new-long-password");
  await fill(input(host, "确认新密码"), "new-long-password");
  await submit(button(host, "更新密码").closest("form"));
  await flush();
  assert.match(host.textContent, /Renewed session agent/);
  old.resolve(json({ error: "old session expired" }, 401));
  await flush();
  assert.match(host.textContent, /Renewed session agent/);
  assert.equal(host.textContent.includes("old session expired"), false);
  assert.equal(host.textContent.includes("登录账号"), false);
});

test("旧授权 POST 在切换账号后返回成功，不得跳转或清理新授权路由", async (t) => {
  const old = deferred();
  let account = user;
  const { host } = await mount(t, (r) => {
    if (r.url === "/api/session" || r.url === "/api/auth/login")
      return json({ user: account });
    if (r.url.startsWith("/api/mcp/") && r.method === "POST")
      return old.promise;
    if (r.url.startsWith("/api/mcp/"))
      return json(
        consent({
          account,
          client: {
            ...consent().client,
            name: account === other ? "Current agent" : "Old agent",
          },
        }),
      );
    return consentHandler(r);
  });
  await click(input(host, room.name));
  await submit(button(host, "允许访问").closest("form"));
  await act(async () =>
    window.dispatchEvent(new Event("qingdan-session-expired")),
  );
  account = other;
  await fill(input(host, "用户名"), "other");
  await fill(input(host, "密码"), "test-password");
  await submit(host.querySelector("form"));
  await flush();
  old.resolve(json({ redirect_to: "https://old.example/callback" }));
  await flush();
  assert.match(host.textContent, /Current agent/);
  assert.equal(location.pathname, "/mcp/consent");
  assert.equal(location.search, "?handle=opaque");
});

test("读取授权失败可安全重试；请求的写入和离线权限默认选中但可降级", async (t) => {
  let reads = 0;
  const { host, requests } = await mount(t, (r) => {
    if (r.url.startsWith("/api/mcp/") && r.method !== "POST")
      return ++reads === 1
        ? json({ error: "暂时不可用" }, 503)
        : json(
            consent({
              requested_scopes: [
                "qingdan:read",
                "qingdan:write",
                "offline_access",
              ],
            }),
          );
    if (r.method === "POST")
      return json({
        redirect_to: "https://client.example/callback?code=verified",
      });
    return consentHandler(r);
  });
  assert.match(host.textContent, /暂时不可用/);
  await click(button(host, "重试读取授权"));
  assert.equal(input(host, "读写").checked, true);
  assert.equal(input(host, "允许持续连接").checked, true);
  assert.equal(
    requests.some((r) => r.method === "POST"),
    false,
  );
  await click(input(host, "只读"));
  await click(input(host, "允许持续连接"));
  await click(button(host, "全选当前画布"));
  await submit(button(host, "允许访问").closest("form"));
  assert.deepEqual(requests.find((r) => r.method === "POST").body.scopes, [
    "qingdan:read",
  ]);
  assert.equal(location.pathname, "/");
});

test("失效授权只提示重新发起，不能再次提交或采用 URL 传来的回调", async (t) => {
  let posts = 0;
  const { host } = await mount(
    t,
    (r) => {
      if (r.method === "POST") {
        posts++;
        return json({ error: "consent expired" }, 403);
      }
      return consentHandler(r);
    },
    "/mcp/consent?handle=opaque&redirect_to=https://attacker.example",
  );
  await click(input(host, room.name));
  await submit(button(host, "允许访问").closest("form"));
  assert.match(host.textContent, /重新发起授权/);
  assert.equal(button(host, "允许访问").disabled, true);
  await submit(button(host, "允许访问").closest("form"));
  assert.equal(posts, 1);
  assert.equal(location.pathname, "/mcp/consent");
});

test("授权响应缺少服务器回调时保持页面并显示错误", async (t) => {
  const { host } = await mount(t, (r) =>
    r.method === "POST" ? json({ ok: true }) : consentHandler(r),
  );
  await click(input(host, room.name));
  await submit(button(host, "允许访问").closest("form"));
  assert.match(host.querySelector('[role="alert"]').textContent, /返回地址/);
  assert.equal(location.pathname, "/mcp/consent");
});

test("连接列表失败不妨碍历史加载，撤销失败可以取消或重试", async (t) => {
  let reads = 0,
    deletes = 0;
  const { host } = await mount(
    t,
    (r) => {
      if (r.url.startsWith("/api/profile/mcp-grants?"))
        return ++reads === 1
          ? json({ error: "连接读取失败" }, 503)
          : json({
              enabled: true,
              resource: null,
              items: [grant()],
              next_cursor: null,
            });
      if (r.method === "DELETE")
        return ++deletes === 1
          ? json({ error: "撤销失败" }, 503)
          : json({ ok: true });
      if (r.url.includes("mcp-operations?"))
        return json({ items: [], next_cursor: null });
      return consentHandler(r);
    },
    "/",
  );
  await openConnections(host);
  assert.match(host.textContent, /连接读取失败/);
  await fill(input(host, "操作记录画布"), room.id);
  await flush();
  assert.match(host.textContent, /没有你的 Agent 操作记录/);
  await click(button(host, "重试读取连接"));
  await click(button(host, "撤销连接"));
  await click(button(host, "确认撤销"));
  assert.match(host.textContent, /撤销失败/);
  await click(button(host, "确认撤销"));
  assert.match(host.textContent, /已撤销/);
});

test("恢复只提交一次，切换画布后的旧恢复结果不改变当前历史", async (t) => {
  const old = deferred();
  let restores = 0;
  const { host } = await mount(
    t,
    (r) => {
      if (r.url.startsWith("/api/profile/mcp-grants?"))
        return json({
          enabled: true,
          resource: null,
          items: [],
          next_cursor: null,
        });
      if (r.url === "/api/rooms")
        return json({
          rooms: [room, { id: "room-b", name: "夏日计划", role: "editor" }],
        });
      if (r.url.endsWith("/restore")) {
        restores++;
        return old.promise;
      }
      if (r.url.includes("mcp-operations?"))
        return json({
          items: [
            operation({
              client_id: r.url.includes("room-b")
                ? "Summer agent"
                : "Spring agent",
            }),
          ],
          next_cursor: null,
        });
      return consentHandler(r);
    },
    "/",
  );
  await openConnections(host);
  await fill(input(host, "操作记录画布"), room.id);
  await flush();
  const restore = button(host, "恢复删除");
  await click(restore);
  await click(restore);
  assert.equal(restores, 1);
  await fill(input(host, "操作记录画布"), "room-b");
  await flush();
  old.resolve(
    json({
      canvas_id: room.id,
      operation_id: "op-a",
      sequence: 9,
      notes: [{ note_id: "note-a", revision: 4 }],
      task_ids: ["task-a"],
      changed: true,
    }),
  );
  await flush();
  assert.match(host.textContent, /Summer agent/);
  assert.equal(host.textContent.includes("已恢复"), false);
  assert.equal(button(host, "恢复删除").disabled, false);
});

test("缺少 handle 的专用页面阻止画布导航，并提示重新连接", async (t) => {
  const { host, requests } = await mount(
    t,
    consentHandler,
    "/mcp/consent?room=private#invite=secret",
  );
  assert.match(host.textContent, /缺少请求标识/);
  assert.equal(
    requests.some((r) => r.url === "/api/rooms" || r.url.includes("/api/mcp/")),
    false,
  );
});
