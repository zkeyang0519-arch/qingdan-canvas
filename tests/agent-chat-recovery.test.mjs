import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { browserLocks } from "./fixtures/browser-locks.mjs";
import { chatRecoveryServer } from "./fixtures/chat-recovery-server.mjs";

const dom = new JSDOM('<div id="root"></div>', {
  url: "http://127.0.0.1:8788",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const { createRoot } = await import("react-dom/client");
await mkdir(resolve(".tmp"), { recursive: true });
const dir = await mkdtemp(resolve(".tmp/chat-recovery-ui-"));
await build({
  entryPoints: ["src/agent/ChatPanel.jsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  loader: { ".css": "empty" },
  outfile: resolve(dir, "ui.mjs"),
  logLevel: "silent",
});
let mounted,
  generation = 0;
const storageSetItem = window.Storage.prototype.setItem;
test.beforeEach(() => {
  localReset();
  navigator.locks = browserLocks();
});
test.afterEach(async () => {
  window.Storage.prototype.setItem = storageSetItem;
  if (mounted) {
    await act(async () => mounted.unmount());
    mounted = null;
  }
});
test.after(async () => {
  dom.window.close();
  await rm(dir, { recursive: true, force: true });
});
function localReset() {
  window.localStorage.clear();
  window.sessionStorage.clear();
}
const field = (label) => document.querySelector(`[aria-label="${label}"]`);
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (b) =>
      b.textContent.trim() === label ||
      b.getAttribute("aria-label") === label ||
      (label === "发送" && b.getAttribute("aria-label") === "开始"),
  );
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 150; i++) {
    let value;
    await act(async () => {
      value = await check();
      await pause(20);
    });
    if (value) return value;
  }
  assert.fail(
    "expected chat recovery state did not arrive: " + document.body.textContent,
  );
}
async function click(label) {
  const b = button(label);
  assert.ok(b, label);
  assert.equal(b.disabled, false, label);
  await act(async () => b.click());
}
async function edit(label, text) {
  const el = field(label);
  assert.ok(el, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      el.tagName === "INPUT"
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(el, text);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function chooseChat(id) {
  const select = field("聊天历史");
  assert.ok(select, "聊天历史");
  assert.equal(select.disabled, false);
  await act(async () => {
    select.value = id;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await until(() => button("刷新聊天与记忆")?.disabled === false);
}
async function mount(f, extra = {}) {
  const { default: ChatPanel } = await import(
    pathToFileURL(resolve(dir, "ui.mjs")).href + "?fresh=" + ++generation
  );
  mounted = createRoot(document.getElementById("root"));
  const props = {
    roomId: "canvas",
    userId: "alice",
    pages: [{ id: "ungrouped", title: "Fixture" }],
    requestCloud: f.requestCloud,
    ...extra,
  };
  await act(async () => mounted.render(React.createElement(ChatPanel, props)));
  return async (next) =>
    act(async () =>
      mounted.render(React.createElement(ChatPanel, { ...props, ...next })),
    );
}
async function reopen(f, extra) {
  await act(async () => mounted.unmount());
  mounted = null;
  window.sessionStorage.clear();
  return mount(f, extra);
}
const sendPosts = (f) =>
  f.requests.filter(
    (r) => r.path === "/api/agent/chat/send" && r.method === "POST",
  );
const bound = (fields) => ({
  bindingId: "binding",
  bindingRevision: 1,
  ...fields,
});
const state = (f, id) =>
  f.call(
    "/api/agent/chat/state?bindingId=binding" + (id ? "&chatId=" + id : ""),
  );
const lookup = (f, requestId, extra = "") =>
  f.call(
    "/api/agent/chat/request?bindingId=binding&bindingRevision=1&requestId=" +
      requestId +
      extra,
  );
const draftStorageKey = (chat) =>
  "qingdan.agent-draft:" +
  JSON.stringify([
    ["alice", "canvas", "ungrouped"],
    JSON.stringify(["binding", 1, "runner", "workspace"]),
    chat || "new",
    "chat",
  ]);
const pendingRequests = () =>
  Object.keys(window.localStorage)
    .filter((key) => key.startsWith("qingdan.agent-requests:"))
    .flatMap((key) => JSON.parse(window.localStorage.getItem(key)).records);

for (const destination of ["history", "new"])
  test(`standalone ${destination} navigation preserves the departing durable draft after reopening`, async (t) => {
    const f = await chatRecoveryServer(t);
    dom.reconfigure({ url: f.origin });
    const a = await f.call(
      "/api/agent/chat/new",
      bound({ requestId: "draft-a" }),
    );
    const b = await f.call(
      "/api/agent/chat/new",
      bound({ requestId: "draft-b" }),
    );
    await mount(f);
    await until(() => field("聊天消息")?.disabled === false);
    await chooseChat(a.id);
    await edit("聊天消息", "unsent draft belongs to A");
    if (destination === "history") await chooseChat(b.id);
    else {
      await click("新聊天");
      await until(() => button("刷新聊天与记忆")?.disabled === false);
    }
    assert.equal(
      JSON.parse(window.localStorage.getItem(draftStorageKey(a.id))).value,
      "unsent draft belongs to A",
    );
    await chooseChat(a.id);
    assert.equal(field("聊天消息").value, "unsent draft belongs to A");
    await reopen(f);
    await until(() => field("聊天消息")?.disabled === false);
    await chooseChat(a.id);
    assert.equal(field("聊天消息").value, "unsent draft belongs to A");
    assert.equal(sendPosts(f).length, 0);
  });

for (const embedded of [false, true])
  test(`committed HTTP send with lost ACK is recovered by GET after fresh UI (${embedded ? "embedded" : "standalone"})`, async (t) => {
    const f = await chatRecoveryServer(t);
    dom.reconfigure({ url: f.origin });
    await mount(f, { embedded });
    await until(() => field("聊天消息")?.disabled === false);
    f.dropSend("after");
    await edit("聊天消息", "one paid model call");
    await click("发送");
    await until(() => button("刷新聊天与记忆")?.disabled === false);
    const original = sendPosts(f)[0].body;
    const committed = await until(async () => {
      const s = await state(f);
      return s.job?.status === "succeeded" && s;
    });
    await reopen(f, { embedded });
    await until(() =>
      document.body.textContent.includes("fixture assistant reply"),
    );
    assert.ok(
      f.requests.some(
        (r) =>
          r.method === "GET" &&
          r.path.startsWith("/api/agent/chat/request?") &&
          r.path.includes(original.requestId),
      ),
      "fresh UI must look up the original request, not guess from latest history",
    );
    assert.equal(sendPosts(f).length, 1);
    assert.equal((await f.call("/fixture/chat/count")).count, 1);
    assert.equal(
      (await lookup(f, original.requestId)).job.id,
      committed.job.id,
    );
    await until(() => field("聊天消息")?.value === "");
  });

test("explicit unknown-send retry after reload keeps exact payload and a newer draft", async (t) => {
  const f = await chatRecoveryServer(t);
  dom.reconfigure({ url: f.origin });
  await f.call("/api/agent/chat/new", bound({ requestId: "existing-chat" }));
  await mount(f);
  await until(() => field("聊天消息")?.disabled === false);
  f.dropSend("before");
  await edit("聊天消息", "original request text");
  await click("发送");
  await until(() => button("刷新聊天与记忆")?.disabled === false);
  await edit("聊天消息", "new draft must survive");
  const original = sendPosts(f)[0].body;
  await reopen(f);
  await until(
    () => button("重试原操作") && field("聊天消息")?.disabled === false,
  );
  assert.equal(field("聊天消息").value, "new draft must survive");
  assert.equal(sendPosts(f).length, 1);
  await click("重试原操作");
  await until(async () => (await f.call("/fixture/chat/count")).count === 1);
  assert.deepEqual(sendPosts(f)[1].body, original);
  assert.equal(field("聊天消息").value, "new draft must survive");
});

test("first-send lost ACK carries a newer null-chat draft into the recovered chat", async (t) => {
  const f = await chatRecoveryServer(t);
  dom.reconfigure({ url: f.origin });
  await mount(f, { embedded: true });
  await until(() => field("聊天消息")?.disabled === false);
  f.dropSend("after");
  await edit("聊天消息", "original first send");
  await click("发送");
  await until(() => button("刷新聊天与记忆")?.disabled === false);
  await edit("聊天消息", "new draft after the uncertain first send");
  await until(async () => (await state(f)).job?.status === "succeeded");
  await reopen(f, { embedded: true });
  await until(() =>
    document.body.textContent.includes("fixture assistant reply"),
  );
  assert.equal(
    field("聊天消息").value,
    "new draft after the uncertain first send",
  );
  await reopen(f, { embedded: true });
  await until(() =>
    document.body.textContent.includes("fixture assistant reply"),
  );
  assert.equal(
    field("聊天消息").value,
    "new draft after the uncertain first send",
  );
  assert.equal(sendPosts(f).length, 1);
  assert.equal((await f.call("/fixture/chat/count")).count, 1);
});

test("draft handoff keeps an existing newer target draft and offers an explicit choice", async (t) => {
  const f = await chatRecoveryServer(t);
  dom.reconfigure({ url: f.origin });
  await mount(f);
  await until(() => field("聊天消息")?.disabled === false);
  f.dropSend("after");
  await edit("聊天消息", "first request");
  await click("发送");
  await until(() => button("刷新聊天与记忆")?.disabled === false);
  await edit("聊天消息", "unsent null-chat draft");
  const committed = await until(async () => {
    const s = await state(f);
    return s.job?.status === "succeeded" && s;
  });
  window.localStorage.setItem(
    draftStorageKey(committed.thread.id),
    JSON.stringify({
      version: 1,
      value: "newer draft already saved for this chat",
    }),
  );
  await reopen(f);
  await until(() =>
    document.body.textContent.includes("fixture assistant reply"),
  );
  assert.equal(
    field("聊天消息").value,
    "newer draft already saved for this chat",
  );
  assert.ok(
    button("保留当前草稿"),
    "a conflict must have a manual recovery exit",
  );
  await click("保留当前草稿");
  await until(() => !button("保留当前草稿"));
  assert.equal(
    field("聊天消息").value,
    "newer draft already saved for this chat",
  );
  assert.equal(sendPosts(f).length, 1);
});

async function conflictingHandoff(t, extra = {}) {
  const f = await chatRecoveryServer(t);
  dom.reconfigure({ url: f.origin });
  await mount(f);
  await until(() => field("聊天消息")?.disabled === false);
  f.dropSend("after");
  await edit("聊天消息", "first request for A");
  await click("发送");
  await until(() => button("刷新聊天与记忆")?.disabled === false);
  await edit("聊天消息", "unsent source for A");
  const a = await until(async () => {
    const s = await state(f);
    return s.job?.status === "succeeded" && s.thread;
  });
  const b = await f.call(
    "/api/agent/chat/new",
    bound({ requestId: "unrelated-b" }),
  );
  for (const [id, value] of [
    [a.id, "existing draft for A"],
    [b.id, "unrelated draft for B"],
  ])
    window.localStorage.setItem(
      draftStorageKey(id),
      JSON.stringify({ version: 1, value }),
    );
  const render = await reopen(
    f,
    typeof extra === "function" ? extra(f) : extra,
  );
  await until(() => button("保留当前草稿"));
  return { f, a, b, render };
}

for (const choice of ["保留当前草稿", "使用此前草稿"])
  test(`handoff ${choice} remains bound to A when visiting B`, async (t) => {
    const { f, a, b } = await conflictingHandoff(t);
    await chooseChat(b.id);
    assert.equal(field("聊天消息").value, "unrelated draft for B");
    assert.ok(
      !button(choice),
      "a handoff choice must not act on the unrelated selected chat",
    );
    await click("返回待恢复聊天");
    await until(() => button("刷新聊天与记忆")?.disabled === false);
    assert.equal(field("聊天历史").value, a.id);
    assert.equal(field("聊天消息").value, "existing draft for A");
    await click(choice);
    await until(() => !button("保留当前草稿"));
    const expected =
      choice === "保留当前草稿"
        ? "existing draft for A"
        : "unsent source for A";
    assert.equal(field("聊天消息").value, expected);
    assert.equal(
      JSON.parse(window.localStorage.getItem(draftStorageKey(a.id))).value,
      expected,
    );
    assert.equal(
      JSON.parse(window.localStorage.getItem(draftStorageKey(b.id))).value,
      "unrelated draft for B",
    );
    await chooseChat(b.id);
    assert.equal(field("聊天消息").value, "unrelated draft for B");
    await reopen(f);
    await until(() => field("聊天消息")?.disabled === false);
    await chooseChat(a.id);
    assert.equal(field("聊天消息").value, expected);
    assert.equal(sendPosts(f).length, 1);
    assert.equal((await f.call("/fixture/chat/count")).count, 1);
  });

test("returning to a handoff target rechecks scope after an awaited GET", async (t) => {
  let target,
    hold = false,
    release;
  const { f, a, b, render } = await conflictingHandoff(t, (fixture) => ({
    requestCloud: async (route, options) => {
      const result = await fixture.requestCloud(route, options);
      if (hold && route.includes("/chat/state?") && route.includes(target))
        await new Promise((resolve) => (release = resolve));
      return result;
    },
  }));
  target = a.id;
  await chooseChat(b.id);
  hold = true;
  await click("返回待恢复聊天");
  await until(() => release);
  await render({ userId: "bob" });
  await act(async () => release());
  await until(
    () => field("聊天消息") && button("刷新聊天与记忆")?.disabled === false,
  );
  assert.equal(field("聊天消息")?.value, "");
  assert.equal(button("保留当前草稿"), undefined);
  assert.equal(button("使用此前草稿"), undefined);
  assert.equal(
    JSON.parse(window.localStorage.getItem(draftStorageKey(b.id))).value,
    "unrelated draft for B",
  );
  assert.equal(sendPosts(f).length, 1);
});

test("reopen between destination draft write and source cleanup recovers idempotently", async (t) => {
  const f = await chatRecoveryServer(t);
  dom.reconfigure({ url: f.origin });
  await mount(f);
  await until(() => field("聊天消息")?.disabled === false);
  f.dropSend("after");
  await edit("聊天消息", "first request");
  await click("发送");
  await until(() => button("刷新聊天与记忆")?.disabled === false);
  await edit("聊天消息", "survives interrupted handoff");
  const committed = await until(async () => {
    const s = await state(f);
    return s.job?.status === "succeeded" && s;
  });
  window.Storage.prototype.setItem = function (key, value) {
    if (key === draftStorageKey(null) && JSON.parse(value).value === "")
      throw Error("fixture source cleanup denied");
    return storageSetItem.call(this, key, value);
  };
  await reopen(f);
  await until(
    () =>
      document.body.textContent.includes("fixture assistant reply") &&
      field("聊天消息")?.value === "survives interrupted handoff",
  );
  assert.equal(
    JSON.parse(
      window.localStorage.getItem(draftStorageKey(committed.thread.id)),
    ).value,
    "survives interrupted handoff",
  );
  assert.equal(
    JSON.parse(window.localStorage.getItem(draftStorageKey(null))).value,
    "survives interrupted handoff",
  );
  assert.match(document.body.textContent, /浏览器无法保存恢复信息/);
  assert.ok(button("重试保存草稿"));
  window.Storage.prototype.setItem = storageSetItem;
  await reopen(f);
  await until(() =>
    document.body.textContent.includes("fixture assistant reply"),
  );
  assert.equal(field("聊天消息").value, "survives interrupted handoff");
  assert.equal(sendPosts(f).length, 1);
  assert.equal((await f.call("/fixture/chat/count")).count, 1);
});

test("a failed original-draft cleanup cannot discard its accepted request identity", async (t) => {
  const f = await chatRecoveryServer(t);
  dom.reconfigure({ url: f.origin });
  await mount(f);
  await until(() => field("聊天消息")?.disabled === false);
  f.dropSend("after");
  await edit("聊天消息", "original draft needs cleanup");
  await click("发送");
  await until(() => button("刷新聊天与记忆")?.disabled === false);
  const original = sendPosts(f)[0].body;
  await until(async () => (await state(f)).job?.status === "succeeded");
  window.Storage.prototype.setItem = function (key, value) {
    if (key === draftStorageKey(null) && JSON.parse(value).value === "")
      throw Error("fixture draft cleanup denied");
    return storageSetItem.call(this, key, value);
  };
  await reopen(f);
  await until(() =>
    document.body.textContent.includes("fixture assistant reply"),
  );
  const pending = Object.keys(window.localStorage)
    .filter((key) => key.startsWith("qingdan.agent-requests:"))
    .flatMap((key) => JSON.parse(window.localStorage.getItem(key)).records);
  assert.ok(
    pending.some((record) => record.requestId === original.requestId),
    "cannot discard the only receipt link while the old submitted draft is still durable",
  );
  assert.ok(button("重试保存草稿"));
  window.Storage.prototype.setItem = storageSetItem;
  await click("重试保存草稿");
  await reopen(f);
  await until(() =>
    document.body.textContent.includes("fixture assistant reply"),
  );
  assert.equal(field("聊天消息").value, "");
  assert.equal(sendPosts(f).length, 1);
});

for (const outcome of ["failed", "expired"])
  test(`accepted ${outcome} job keeps its identity until durable draft cleanup then allows explicit resend`, async (t) => {
    const f = await chatRecoveryServer(t);
    dom.reconfigure({ url: f.origin });
    await mount(f);
    await until(() => field("聊天消息")?.disabled === false);
    f.dropSend("after");
    await edit("聊天消息", "model failure");
    await click("发送");
    await until(() => button("刷新聊天与记忆")?.disabled === false);
    const original = sendPosts(f)[0].body;
    const committed = await until(async () => {
      const s = await state(f);
      return s.job?.status === "failed" && s;
    });
    if (outcome === "expired") {
      // Persist a claimed lease boundary in real SQL, restart the runtime and
      // let the production alarm produce its supported failed outcome.
      await f.call("/fixture/chat/expire", { jobId: committed.job.id });
      await f.restart();
      await f.call("/fixture/chat/alarm", {});
      const expired = await lookup(f, original.requestId);
      assert.equal(expired.job.status, "failed");
      assert.match(expired.job.error, /中断/);
    }
    window.Storage.prototype.setItem = function (key, value) {
      if (key === draftStorageKey(null) && JSON.parse(value).value === "")
        throw Error("fixture accepted send cleanup denied");
      return storageSetItem.call(this, key, value);
    };
    await reopen(f);
    await until(
      () => button("重试保存草稿") && field("聊天消息")?.disabled === false,
    );
    assert.ok(
      pendingRequests().some(
        (record) => record.requestId === original.requestId,
      ),
      "an accepted failed job must retain the original identity while source cleanup is not durable",
    );
    assert.equal(
      JSON.parse(window.localStorage.getItem(draftStorageKey(null))).value,
      "model failure",
    );
    assert.equal(sendPosts(f).length, 1);
    await act(async () => {
      assert.equal((await f.call("/fixture/chat/count")).count, 1);
    });
    window.Storage.prototype.setItem = storageSetItem;
    await click("重试保存草稿");
    await until(
      () =>
        !pendingRequests().some(
          (record) => record.requestId === original.requestId,
        ) && field("聊天消息")?.value === "model failure",
    );
    await reopen(f);
    await until(() => field("聊天消息")?.value === "model failure");
    assert.equal(
      JSON.parse(window.localStorage.getItem(draftStorageKey(null))).value,
      "",
    );
    await edit("聊天消息", "explicit retry after durable recovery");
    await click("发送");
    await until(async () => (await state(f)).job?.status === "succeeded");
    assert.equal(sendPosts(f).length, 2);
    assert.notEqual(sendPosts(f)[1].body.requestId, original.requestId);
    assert.equal(sendPosts(f)[1].body.chatId, committed.thread.id);
    await act(async () => {
      assert.equal((await f.call("/fixture/chat/count")).count, 2);
    });
  });

test("personal memory remains readable and writable on initial Hub503", async (t) => {
  const f = await chatRecoveryServer(t);
  dom.reconfigure({ url: f.origin });
  await f.call("/api/agent/chat/memory", {
    action: "save",
    requestId: "seed-memory",
    scope: "personal",
    key: "saved preference",
    value: "short",
  });
  await f.call("/fixture/summary", { fail: true });
  await mount(f, { embedded: true, memoryOpen: true });
  await until(() =>
    document.body.textContent.includes("fixture summary unavailable"),
  );
  assert.ok(
    field("管理记忆"),
    "memory editor must not wait for the failed bound state",
  );
  assert.match(document.body.textContent, /saved preference/);
  await click("新增记忆");
  await edit("记忆名称", "independent");
  await edit("记忆内容", "works during summary failure");
  await click("保存记忆");
  await until(() => button("删除记忆：independent")?.disabled === false);
  await click("删除记忆：independent");
  await until(
    () =>
      !button("删除记忆：independent") &&
      button("刷新聊天与记忆")?.disabled === false,
  );
  assert.equal((await f.call("/api/agent/chat/state")).memories.length, 1);
  assert.equal((await f.call("/fixture/chat/count")).count, 0);
});

test("receipt GET survives worker restart and summary failure, fences wrong action/account/binding", async (t) => {
  const f = await chatRecoveryServer(t);
  const sent = await f.call(
    "/api/agent/chat/send",
    bound({ requestId: "recover-original", text: "read receipt" }),
  );
  assert.equal(sent.http, 202);
  await until(async () => (await state(f)).job?.status === "succeeded");
  await f.call("/fixture/summary", { fail: true });
  await f.restart();
  const recovered = await lookup(f, "recover-original");
  assert.equal(recovered.http, 200);
  assert.equal(recovered.found, true);
  assert.equal(recovered.job.id, sent.job.id);
  assert.equal(recovered.thread.id, sent.thread.id);
  assert.equal((await f.call("/fixture/chat/count")).count, 1);
  assert.equal((await lookup(f, "never-sent")).found, false);
  const other = await f.call(
    "/api/agent/chat/request?bindingId=other-binding&bindingRevision=1&requestId=recover-original",
  );
  assert.ok([403, 404, 409].includes(other.http));
  assert.equal(
    (
      await f.call(
        "/api/agent/chat/request?bindingId=binding&bindingRevision=1&requestId=recover-original",
        undefined,
        "bob",
      )
    ).http,
    403,
  );
  await f.call("/api/agent/chat/memory", {
    action: "save",
    requestId: "memory-not-send",
    scope: "personal",
    key: "safe",
    value: "memory",
  });
  assert.equal((await lookup(f, "memory-not-send")).http, 409);
  await f.rebind();
  assert.equal((await lookup(f, "recover-original")).http, 409);
  assert.equal(
    (
      await f.call(
        "/api/agent/chat/request?bindingId=binding&bindingRevision=2&requestId=recover-original",
      )
    ).http,
    409,
  );
});

test("failed and expired jobs remain acknowledged sends; only explicit new requests invoke a model", async (t) => {
  const f = await chatRecoveryServer(t);
  const body = bound({ requestId: "failed-send", text: "model failure" });
  const sent = await f.call("/api/agent/chat/send", body);
  await until(async () => (await state(f)).job?.status === "failed");
  await f.restart();
  const found = await lookup(f, body.requestId);
  assert.equal(found.found, true);
  assert.equal(found.job.status, "failed");
  assert.equal(
    (await f.call("/api/agent/chat/send", body)).job.id,
    sent.job.id,
  );
  assert.equal((await f.call("/fixture/chat/count")).count, 1);
  // Seed the persisted boundary after a claim, then recreate the runtime and
  // exercise the real alarm. No test-only storage transaction implementation.
  await f.call("/fixture/chat/expire", { jobId: sent.job.id });
  await f.restart();
  await f.call("/fixture/chat/alarm", {});
  const expired = await lookup(f, body.requestId);
  assert.equal(expired.job.status, "failed");
  assert.match(expired.job.error, /中断/);
  assert.equal((await f.call("/fixture/chat/count")).count, 1);
  const resent = await f.call(
    "/api/agent/chat/send",
    bound({
      requestId: "explicit-new-send",
      chatId: sent.thread.id,
      text: "explicit retry after known failure",
    }),
  );
  assert.notEqual(resent.job.id, sent.job.id);
  await until(async () => (await state(f)).job?.status === "succeeded");
  assert.equal((await f.call("/fixture/chat/count")).count, 2);
});

test("chat refuses a normal write without Web Locks while read controls remain usable", async (t) => {
  const f = await chatRecoveryServer(t);
  dom.reconfigure({ url: f.origin });
  navigator.locks = undefined;
  await mount(f);
  await until(() => field("聊天消息")?.disabled === false);
  await edit("聊天消息", "must not dispatch");
  await click("发送");
  await until(() => button("刷新聊天与记忆")?.disabled === false);
  assert.equal(sendPosts(f).length, 0);
  assert.match(document.body.textContent, /Web Locks/);
  await click("刷新聊天与记忆");
});

test("account switch while prepare awaits a browser lock cannot dispatch the old send", async (t) => {
  const f = await chatRecoveryServer(t);
  dom.reconfigure({ url: f.origin });
  const render = await mount(f);
  await until(() => field("聊天消息")?.disabled === false);
  let release;
  navigator.locks = {
    request: async (_key, fn) => {
      await new Promise((r) => (release = r));
      return fn();
    },
  };
  await edit("聊天消息", "alice only");
  await click("发送");
  await until(() => release);
  await render({ userId: "bob" });
  await act(async () => release());
  await until(() => field("聊天消息"));
  assert.equal(sendPosts(f).length, 0);
  assert.equal(field("聊天消息").value, "");
});
