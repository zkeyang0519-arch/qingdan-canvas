import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/?room=invited-room#invite=kept-invitation",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "localStorage",
  "location",
  "history",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(
  new URL("../.tmp/account-recovery-ui-", import.meta.url),
);
await build({
  stdin: {
    contents:
      'export { default as AuthScreen } from "./src/auth/AuthScreen.jsx"; export { default as ForgotPassword } from "./src/auth/ForgotPassword.jsx"; export { default as EmailSettings } from "./src/auth/EmailSettings.jsx"; export { setActiveAccount } from "./src/api.js";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  jsx: "automatic",
  packages: "external",
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "omit-css",
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (args) => ({
          path: args.path,
          namespace: "test-css",
        }));
        build.onLoad({ filter: /.*/, namespace: "test-css" }, () => ({
          contents: "",
          loader: "js",
        }));
      },
    },
  ],
  outfile: path.join(output, "ui.mjs"),
});
const { AuthScreen, ForgotPassword, EmailSettings, setActiveAccount } =
  await import(pathToFileURL(path.join(output, "ui.mjs")));
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount(t, Component = AuthScreen, props = {}) {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const render = async (next = props) => {
    await act(async () => root.render(React.createElement(Component, next)));
  };
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    host.remove();
  };
  t.after(async () => {
    await unmount();
    setActiveAccount(null);
  });
  await render();
  return { host, render, unmount };
}
function button(host, label) {
  const element = [...host.querySelectorAll("button")].find(
    (item) => item.textContent.trim() === label,
  );
  assert.ok(element, `找不到按钮：${label}`);
  return element;
}
function input(host, label) {
  const element = [...host.querySelectorAll("label")]
    .find((item) => item.firstChild?.textContent.trim() === label)
    ?.querySelector("input");
  assert.ok(element, `找不到输入框：${label}`);
  return element;
}
async function fill(host, label, value) {
  const element = input(host, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(element) {
  await act(async () => element.click());
}
async function submit(host) {
  await act(async () =>
    host
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function startRecovery(host) {
  await click(button(host, "忘记密码？"));
  await fill(host, "用户名", "alice");
  await fill(host, "绑定邮箱", "alice@example.com");
  await submit(host);
}

test("忘记密码保留用户名和邀请链接，返回后登录与注册仍走原接口", async (t) => {
  const requests = [],
    authenticated = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response({ user: { id: "alice", username: "alice" } });
  });
  const f = await mount(t, AuthScreen, {
    onAuthenticated: (value) => authenticated.push(value),
    legacyRoomCount: 2,
  });
  const url = location.href;
  await fill(f.host, "用户名", "alice");
  await click(button(f.host, "忘记密码？"));
  assert.match(f.host.querySelector("h2").textContent, /找回密码/);
  assert.equal(input(f.host, "用户名").value, "alice");
  await click(button(f.host, "返回登录"));
  assert.equal(location.href, url);
  assert.equal(input(f.host, "用户名").value, "alice");
  await fill(f.host, "密码", "a-long-password");
  await submit(f.host);
  assert.equal(requests[0].url, "/api/auth/login");
  assert.equal(requests[0].body.claimLegacy, true);
  assert.equal(authenticated.length, 1);
  await click(button(f.host, "注册账号"));
  await fill(f.host, "密码", "registration-password");
  await fill(f.host, "确认密码", "registration-password");
  await submit(f.host);
  assert.equal(requests[1].url, "/api/auth/register");
  assert.equal(requests[1].body.password, "registration-password");
  assert.equal(
    f.host.querySelector('input[type="email"]'),
    null,
    "注册不要求邮箱",
  );
});

test("验证码发送使用统一提示，拦截不一致新密码，成功后回到登录且不自动登录", async (t) => {
  const requests = [],
    authenticated = [];
  setActiveAccount("another-account");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return response(
      url.endsWith("/request")
        ? {
            challengeId: "reset-one",
            retryAfter: 60,
            message:
              "如果用户名和绑定邮箱匹配，验证码将发送至该邮箱，请检查收件箱和垃圾邮件。",
          }
        : { ok: true },
      url.endsWith("/request") ? 202 : 200,
    );
  });
  const f = await mount(t, AuthScreen, {
    onAuthenticated: (value) => authenticated.push(value),
  });
  const url = location.href;
  await startRecovery(f.host);
  assert.equal(requests[0].url, "/api/auth/password-reset/request");
  assert.deepEqual(requests[0].body, {
    username: "alice",
    email: "alice@example.com",
  });
  assert.equal(requests[0].options.headers["X-QD-Account"], undefined);
  assert.match(
    f.host.querySelector('[role="status"]').textContent,
    /如果用户名和绑定邮箱匹配/,
  );
  assert.ok(
    [...f.host.querySelectorAll("button")].some(
      (item) => item.disabled && /60/.test(item.textContent),
    ),
  );
  await fill(f.host, "验证码", "123456");
  await fill(f.host, "新密码", "new-long-password");
  await fill(f.host, "确认新密码", "different-password");
  await submit(f.host);
  assert.equal(requests.length, 1);
  assert.match(f.host.querySelector('[role="alert"]').textContent, /不一致/);
  await fill(f.host, "确认新密码", "new-long-password");
  await submit(f.host);
  assert.deepEqual(requests[1].body, {
    username: "alice",
    email: "alice@example.com",
    code: "123456",
    challengeId: "reset-one",
    password: "new-long-password",
  });
  assert.equal(requests[1].url, "/api/auth/password-reset/confirm");
  assert.match(
    f.host.querySelector('[role="status"]').textContent,
    /密码已重置.*登录/,
  );
  assert.equal(input(f.host, "密码").value, "");
  assert.equal(input(f.host, "用户名").value, "alice");
  assert.equal(location.href, url);
  assert.equal(authenticated.length, 0);
});

test("邮件服务未启用时保留找回输入并显示原因，可返回登录", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    response({ error: "邮件验证服务尚未启用，请联系管理员。" }, 503),
  );
  const f = await mount(t);
  await startRecovery(f.host);
  assert.match(f.host.querySelector('[role="alert"]').textContent, /尚未启用/);
  assert.equal(input(f.host, "绑定邮箱").value, "alice@example.com");
  assert.equal(
    f.host.querySelector('input[autocomplete="one-time-code"]'),
    null,
  );
  await click(button(f.host, "返回登录"));
  assert.ok(input(f.host, "密码"));
});

test("找回请求期间禁用操作，卸载后的确认结果不会触发成功回调", async (t) => {
  const pending = deferred(),
    completed = [];
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    requests++;
    return url.endsWith("/request")
      ? response(
          {
            challengeId: "pending-reset",
            retryAfter: 60,
            message: "如果用户名和绑定邮箱匹配，验证码将发送至该邮箱。",
          },
          202,
        )
      : pending.promise;
  });
  const f = await mount(t, ForgotPassword, {
    initialUsername: "alice",
    onSuccess: (value) => completed.push(value),
    onBack() {},
  });
  await fill(f.host, "绑定邮箱", "alice@example.com");
  await submit(f.host);
  await fill(f.host, "验证码", "123456");
  await fill(f.host, "新密码", "new-long-password");
  await fill(f.host, "确认新密码", "new-long-password");
  await submit(f.host);
  for (const element of f.host.querySelectorAll("input, button")) {
    assert.equal(
      element.matches(":disabled"),
      true,
      `等待结果期间禁用 ${element.textContent || element.type}`,
    );
  }
  await submit(f.host);
  assert.equal(requests, 2, "重复提交不会重复请求");
  await f.unmount();
  await act(async () => pending.resolve(response({ ok: true })));
  assert.equal(completed.length, 0);
});

test("找回验证码错误可重试，倒计时按实际时间结束后重发并提交最新凭证", async (t) => {
  let now = Date.now(),
    issued = 0;
  t.mock.method(Date, "now", () => now);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith("/request"))
      return response(
        {
          challengeId: `reset-${++issued}`,
          retryAfter: 60,
          message: "如果用户名和绑定邮箱匹配，验证码将发送至该邮箱。",
        },
        202,
      );
    return issued === 1
      ? response({ error: "验证码无效或已过期，请重新获取。" }, 400)
      : response({ ok: true });
  });
  const f = await mount(t);
  await startRecovery(f.host);
  await fill(f.host, "验证码", "000001");
  await fill(f.host, "新密码", "new-long-password");
  await fill(f.host, "确认新密码", "new-long-password");
  await submit(f.host);
  assert.match(
    f.host.querySelector('[role="alert"]').textContent,
    /无效或已过期/,
  );
  assert.equal(input(f.host, "新密码").value, "new-long-password");
  const resend = [...f.host.querySelectorAll("button")].find((item) =>
    /秒后可重新发送/.test(item.textContent),
  );
  await click(resend);
  assert.equal(issued, 1, "冷却期间不发送请求");
  now += 61000;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1050)));
  await click(button(f.host, "重新发送验证码"));
  assert.equal(input(f.host, "验证码").value, "");
  assert.equal(f.host.querySelector('[role="alert"]'), null);
  await fill(f.host, "验证码", "000002");
  await submit(f.host);
  assert.equal(requests.at(-1).body.challengeId, "reset-2");
  assert.equal(requests.at(-1).body.code, "000002");
  assert.match(
    f.host.querySelector('[role="status"]').textContent,
    /密码已重置/,
  );
});

test("找回修改用户名或邮箱会清除旧验证码与密码，同时保留发送冷却", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return response(
      {
        challengeId: "old-identity",
        retryAfter: 60,
        message: "如果用户名和绑定邮箱匹配，验证码将发送至该邮箱。",
      },
      202,
    );
  });
  const f = await mount(t);
  await startRecovery(f.host);
  await fill(f.host, "新密码", "sensitive-password");
  await click(button(f.host, "修改用户名或邮箱"));
  assert.equal(input(f.host, "绑定邮箱").value, "alice@example.com");
  assert.equal(
    f.host.querySelector('input[autocomplete="one-time-code"]'),
    null,
  );
  assert.equal(f.host.querySelector('input[type="password"]'), null);
  await fill(f.host, "用户名", "bob");
  await fill(f.host, "绑定邮箱", "bob@example.com");
  await submit(f.host);
  assert.equal(requests, 1, "改写邮箱不能绕过发送冷却");
  await click(button(f.host, "返回登录"));
  assert.equal(input(f.host, "用户名").value, "bob");
  assert.equal(input(f.host, "密码").value, "");
});

const alice = { id: "alice-id", username: "alice", name: "小张" };
const bob = { id: "bob-id", username: "bob", name: "小李" };
async function expandEmail(host) {
  const details = host.querySelector("details");
  assert.ok(details, "应提供默认折叠的邮箱设置");
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}
async function requestBinding(host, email = "new@example.com") {
  await fill(host, "邮箱", email);
  await fill(host, "当前密码", "current-password");
  await submit(host);
}

test("邮箱设置展开才加载本人邮箱，绑定发送要求当前密码并确认后显示已绑定", async (t) => {
  const requests = [],
    pending = deferred();
  setActiveAccount("different-active-account");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({
      url,
      options,
      body: options.body && JSON.parse(options.body),
    });
    if (url.endsWith("/request")) return pending.promise;
    return response(
      url.endsWith("/confirm")
        ? { email: "new@example.com" }
        : { email: null, available: true },
    );
  });
  const f = await mount(t, EmailSettings, { user: alice });
  assert.equal(requests.length, 0);
  assert.ok(f.host.querySelector("details"), "应提供默认折叠的邮箱设置");
  assert.equal(f.host.querySelector("details").open, false);
  await expandEmail(f.host);
  assert.equal(requests[0].url, "/api/profile/email");
  await requestBinding(f.host);
  assert.equal(requests[1].url, "/api/profile/email/request");
  assert.deepEqual(requests[1].body, {
    email: "new@example.com",
    currentPassword: "current-password",
  });
  for (const element of f.host.querySelectorAll("input, button"))
    assert.equal(element.matches(":disabled"), true);
  await submit(f.host);
  assert.equal(requests.length, 2, "发送期间禁止重复提交");
  await act(async () =>
    pending.resolve(response({ challengeId: "bind-one", retryAfter: 60 })),
  );
  await fill(f.host, "验证码", "123456");
  await submit(f.host);
  assert.equal(requests[2].url, "/api/profile/email/confirm");
  assert.deepEqual(requests[2].body, {
    email: "new@example.com",
    code: "123456",
    challengeId: "bind-one",
  });
  for (const request of requests)
    assert.equal(request.options.headers["X-QD-Account"], alice.id);
  assert.equal(
    f.host.querySelector('[aria-label="已绑定邮箱"] strong').textContent,
    "new@example.com",
  );
  assert.match(f.host.querySelector('[role="status"]').textContent, /绑定/);
  assert.equal(f.host.querySelector('input[type="password"]'), null);
  assert.ok(button(f.host, "更换邮箱"));
});

test("改绑失败保留原邮箱和验证码表单，重试成功才替换已验证邮箱", async (t) => {
  let confirms = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/request"))
      return response({ challengeId: "replacement", retryAfter: 60 });
    if (url.endsWith("/confirm"))
      return ++confirms === 1
        ? response({ error: "这个邮箱暂时无法绑定，请使用其他邮箱。" }, 409)
        : response({ email: "new@example.com" });
    return response({ email: "old@example.com", available: true });
  });
  const f = await mount(t, EmailSettings, { user: alice });
  await expandEmail(f.host);
  await click(button(f.host, "更换邮箱"));
  await requestBinding(f.host);
  assert.equal(
    f.host.querySelector('[aria-label="已绑定邮箱"] strong').textContent,
    "old@example.com",
  );
  await fill(f.host, "验证码", "654321");
  await submit(f.host);
  assert.match(f.host.querySelector('[role="alert"]').textContent, /无法绑定/);
  assert.equal(
    f.host.querySelector('[aria-label="已绑定邮箱"] strong').textContent,
    "old@example.com",
  );
  assert.equal(input(f.host, "验证码").value, "654321");
  await fill(f.host, "验证码", "123456");
  await submit(f.host);
  assert.equal(
    f.host.querySelector('[aria-label="已绑定邮箱"] strong').textContent,
    "new@example.com",
  );
});

test("未配置发信时仍可查看原邮箱，禁用绑定并说明原因", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return response({ email: "old@example.com", available: false });
  });
  const f = await mount(t, EmailSettings, { user: alice });
  await expandEmail(f.host);
  assert.equal(
    f.host.querySelector('[aria-label="已绑定邮箱"] strong').textContent,
    "old@example.com",
  );
  assert.match(f.host.textContent, /邮件验证服务尚未启用/);
  assert.equal(f.host.querySelector("form"), null);
  assert.equal(requests, 1);
});

test("加载邮箱失败后可以重试，失败不会伪装成未绑定", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++reads === 1
      ? response({ error: "暂时无法加载邮箱。" }, 503)
      : response({ email: "existing@example.com", available: true }),
  );
  const f = await mount(t, EmailSettings, { user: alice });
  await expandEmail(f.host);
  assert.match(f.host.querySelector('[role="alert"]').textContent, /无法加载/);
  assert.equal(f.host.querySelector("form"), null);
  await click(button(f.host, "重新加载"));
  assert.equal(
    f.host.querySelector('[aria-label="已绑定邮箱"] strong').textContent,
    "existing@example.com",
  );
});

test("切换账号丢弃迟到的邮箱读取结果，新账号仍默认折叠且按本人身份加载", async (t) => {
  const pending = deferred(),
    identities = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    identities.push(options.headers["X-QD-Account"]);
    return identities.length === 1
      ? pending.promise
      : response({ email: "bob@example.com", available: true });
  });
  const f = await mount(t, EmailSettings, { user: alice });
  await expandEmail(f.host);
  await f.render({ user: bob });
  await act(async () =>
    pending.resolve(
      response({ email: "private-alice@example.com", available: true }),
    ),
  );
  assert.equal(f.host.querySelector("details").open, false);
  assert.equal(f.host.textContent.includes("private-alice"), false);
  await expandEmail(f.host);
  assert.deepEqual(identities, [alice.id, bob.id]);
  assert.equal(
    f.host.querySelector('[aria-label="已绑定邮箱"] strong').textContent,
    "bob@example.com",
  );
});

for (const stage of ["request", "confirm"]) {
  test(`账号切换后旧邮箱${stage === "request" ? "发送失败" : "确认成功"}不会污染新账号`, async (t) => {
    const pending = deferred();
    t.mock.method(globalThis, "fetch", async (url) => {
      if (url.endsWith(`/${stage}`)) return pending.promise;
      if (url.endsWith("/request"))
        return response({ challengeId: "old-account", retryAfter: 60 });
      return response({ email: null, available: true });
    });
    const f = await mount(t, EmailSettings, { user: alice });
    await expandEmail(f.host);
    await requestBinding(f.host);
    if (stage === "confirm") {
      await fill(f.host, "验证码", "123456");
      await submit(f.host);
    }
    await f.render({ user: bob });
    await expandEmail(f.host);
    await act(async () =>
      pending.resolve(
        stage === "request"
          ? response({ error: "旧账号的发送失败" }, 503)
          : response({ email: "private-alice@example.com" }),
      ),
    );
    assert.equal(f.host.querySelector('[role="alert"]'), null);
    assert.equal(f.host.querySelector('[role="status"]'), null);
    assert.equal(f.host.textContent.includes("private-alice"), false);
    assert.equal(input(f.host, "邮箱").value, "");
    assert.equal(input(f.host, "当前密码").value, "");
  });
}

test("绑定重发使用最新验证码凭证，修改邮箱或取消不会丢失原绑定", async (t) => {
  let now = Date.now(),
    issued = 0;
  const requests = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, body: options.body && JSON.parse(options.body) });
    if (url.endsWith("/request"))
      return response({ challengeId: `bind-${++issued}`, retryAfter: 60 });
    if (url.endsWith("/confirm"))
      return response({ error: "验证码无效或已过期，请重新获取。" }, 400);
    return response({ email: "old@example.com", available: true });
  });
  const f = await mount(t, EmailSettings, { user: alice });
  await expandEmail(f.host);
  await click(button(f.host, "更换邮箱"));
  await requestBinding(f.host);
  await fill(f.host, "验证码", "111111");
  now += 61000;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1050)));
  await click(button(f.host, "重新发送验证码"));
  assert.equal(input(f.host, "验证码").value, "");
  assert.equal(requests.at(-1).body.currentPassword, "current-password");
  await fill(f.host, "验证码", "222222");
  await submit(f.host);
  assert.equal(requests.at(-1).body.challengeId, "bind-2");
  assert.match(
    f.host.querySelector('[role="alert"]').textContent,
    /无效或已过期/,
  );
  await click(button(f.host, "修改邮箱"));
  assert.equal(input(f.host, "邮箱").value, "new@example.com");
  assert.equal(input(f.host, "当前密码").value, "");
  await requestBinding(f.host, "other@example.com");
  assert.equal(issued, 2, "修改邮箱保留发送冷却");
  await click(button(f.host, "取消更换"));
  assert.equal(
    f.host.querySelector('[aria-label="已绑定邮箱"] strong').textContent,
    "old@example.com",
  );
  assert.equal(f.host.querySelector("form"), null);
});
