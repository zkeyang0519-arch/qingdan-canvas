import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const html = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const script = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const ready = {
  status: "ready",
  checks: ["discovery", "protocol", "account", "sessions"].map((id) => ({
    id,
    label: id,
    state: "ok",
  })),
  auth: { status: "signed_in" },
  preferences: { manualPath: "" },
  connection: { instanceId: "fixture-instance-a", generation: 1 },
  install: { source: "fixture", path: "C:\\old\\codex.exe" },
  version: "0.167.0-alpha.3.2",
};
async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("UI state did not settle");
}
async function setup(t) {
  const calls = [];
  let failLists = false,
    respond,
    poll;
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:51234/#token=" + "a".repeat(64),
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    d = w.document;
  w.setInterval = (callback) => {
    poll = callback;
    return 0;
  };
  w.fetch = async (route, options) => {
    const url = new URL(route, w.location.href);
    calls.push({ url, options });
    const response = respond?.(url, options);
    if (response !== undefined) return response;
    let result = ready,
      ok = true;
    if (url.pathname === "/api/sessions") {
      const term = url.searchParams.get("search") || "initial";
      result = {
        sessions: [
          {
            threadId: term + (url.searchParams.has("cursor") ? "-2" : "-1"),
            title: term === "unsafe" ? "<img src=x onerror=alert(1)>" : term,
            cwd: "C:\\项目",
            updatedAt: 1790000000,
          },
        ],
        nextCursor: url.searchParams.has("cursor") ? null : "cursor-" + term,
      };
      if (failLists) {
        ok = false;
        result = { message: "连接已断开" };
      }
    }
    if (url.pathname === "/api/session")
      result = {
        threadId: url.searchParams.get("id"),
        title: "选中会话",
        cwd: "C:\\项目",
        directoryExists: true,
      };
    if (url.pathname === "/api/config" && JSON.parse(options.body).manualPath)
      result = {
        ...ready,
        status: "error",
        error: {
          code: "CODEX_PATH_INVALID",
          message: "程序路径无效",
          action: "恢复自动发现",
        },
      };
    return { ok, json: async () => result };
  };
  w.eval(script);
  await until(
    () =>
      d.querySelectorAll(".session").length === 1 &&
      !d.getElementById("searchButton").disabled,
  );
  const search = async (term) => {
    d.getElementById("search").value = term;
    d.getElementById("searchForm").dispatchEvent(
      new w.Event("submit", { bubbles: true, cancelable: true }),
    );
    await until(() => !d.getElementById("searchButton").disabled);
  };
  return {
    w,
    d,
    calls,
    search,
    poll: () => poll(),
    respond: (handler) => {
      respond = handler;
    },
    failLists: () => {
      failLists = true;
    },
  };
}
test("panel connects, removes URL credential and displays a selected project", async (t) => {
  const { d, w, calls } = await setup(t);
  assert.equal(d.getElementById("status").textContent, "Codex 已连接");
  assert.equal(w.location.hash, "");
  assert.ok(
    calls.every(
      (c) => c.options.headers.Authorization === "Bearer " + "a".repeat(64),
    ),
  );
  d.querySelector(".session").click();
  await until(() => !d.getElementById("project").hidden);
  assert.equal(d.getElementById("projectPath").textContent, "C:\\项目");
});
test("pagination stays with the submitted search when the input draft changes", async (t) => {
  const { d, calls, search } = await setup(t);
  await search("alpha");
  d.getElementById("search").value = "beta";
  d.getElementById("more").click();
  await until(() => !d.getElementById("more").disabled);
  const last = calls.filter((c) => c.url.pathname === "/api/sessions").at(-1);
  assert.equal(last.url.searchParams.get("search"), "alpha");
  assert.equal(last.url.searchParams.get("cursor"), "cursor-alpha");
  assert.equal(d.querySelectorAll(".session").length, 2);
});
test("session titles are treated as text and failed reads label retained results", async (t) => {
  const { d, search, failLists } = await setup(t);
  await search("unsafe");
  assert.equal(d.querySelectorAll("#sessions img").length, 0);
  assert.ok(d.getElementById("sessions").textContent.includes("<img"));
  failLists();
  await search("other");
  assert.match(d.getElementById("listMessage").textContent, /可能已过期/);
  assert.match(d.getElementById("notice").textContent, /连接已断开/);
});
test("invalid manual path has a working return to automatic discovery", async (t) => {
  const { d } = await setup(t);
  d.getElementById("manualPath").value = "Z:\\missing.exe";
  d.getElementById("savePath").click();
  await until(() => !d.getElementById("savePath").disabled);
  assert.equal(d.getElementById("status").textContent, "连接需要处理");
  d.getElementById("autoPath").click();
  await until(() => !d.getElementById("autoPath").disabled);
  assert.equal(d.getElementById("status").textContent, "Codex 已连接");
});

const response = (data, ok = true) => ({ ok, json: async () => data });
const newPage = {
  sessions: [
    {
      threadId: "new-thread",
      title: "新连接会话",
      cwd: "C:\\new",
      updatedAt: 1,
    },
  ],
  nextCursor: null,
};
const project = (name) => ({
  threadId: name + "-thread",
  title: name,
  cwd: "C:\\" + name,
  directoryExists: true,
});

test("manual reconnect hides the old project and ignores its late success", async (t) => {
  const { w, d, respond } = await setup(t);
  await w.eval('select("initial-1")');
  assert.equal(d.getElementById("project").hidden, false);
  const old = Promise.withResolvers();
  respond((url) => {
    if (url.pathname === "/api/session") return old.promise;
    if (url.pathname === "/api/connect")
      return response({
        ...ready,
        connection: { ...ready.connection, generation: 2 },
      });
    if (url.pathname === "/api/sessions") return response(newPage);
  });
  const pending = w.eval('select("initial-1")');
  d.getElementById("reconnect").click();
  assert.equal(d.getElementById("project").hidden, true);
  await until(() => !d.getElementById("reconnect").disabled);
  old.resolve(response(project("old")));
  await pending;
  assert.equal(d.getElementById("project").hidden, true);
  assert.match(d.getElementById("sessions").textContent, /新连接会话/);
  respond((url) =>
    url.pathname === "/api/session" ? response(project("new")) : undefined,
  );
  await w.eval('select("new-thread")');
  assert.equal(d.getElementById("projectPath").textContent, "C:\\new");
});

test("manual reconnect ignores an old project error after a new selection succeeds", async (t) => {
  const { w, d, respond } = await setup(t);
  const old = Promise.withResolvers();
  respond((url) => (url.pathname === "/api/session" ? old.promise : undefined));
  const pending = w.eval('select("initial-1")');
  d.getElementById("reconnect").click();
  await until(() => !d.getElementById("reconnect").disabled);
  respond((url) =>
    url.pathname === "/api/session" ? response(project("new")) : undefined,
  );
  await w.eval('select("new-thread")');
  old.resolve(response({ message: "旧连接读取失败" }, false));
  await pending;
  assert.equal(d.getElementById("notice").hidden, true);
  assert.equal(d.getElementById("projectPath").textContent, "C:\\new");
});

for (const [name, connection, install] of [
  [
    "automatic reconnect at the same path and timestamp",
    { instanceId: "fixture-instance-a", generation: 2 },
    ready.install,
  ],
  [
    "automatic recovery to another installation",
    { instanceId: "fixture-instance-a", generation: 2 },
    { source: "fixture", path: "C:\\new\\codex.exe" },
  ],
  [
    "restarted backend with the same generation counter",
    { instanceId: "fixture-instance-b", generation: 1 },
    ready.install,
  ],
]) {
  test(`${name} invalidates late selected-project responses`, async (t) => {
    const { w, d, respond, poll } = await setup(t);
    const old = Promise.withResolvers();
    respond((url) => {
      if (url.pathname === "/api/session") return old.promise;
      if (url.pathname === "/api/status")
        return response({ ...ready, connection, install });
      if (url.pathname === "/api/sessions") return response(newPage);
    });
    const pending = w.eval('select("initial-1")');
    await poll();
    old.resolve(response(project("old")));
    await pending;
    assert.equal(d.getElementById("project").hidden, true);
    assert.match(d.getElementById("sessions").textContent, /新连接会话/);
  });
}

test("a late status poll cannot overwrite a newer manual connection", async (t) => {
  const { d, respond, poll } = await setup(t);
  const old = Promise.withResolvers();
  respond((url) => {
    if (url.pathname === "/api/status") return old.promise;
    if (url.pathname === "/api/connect")
      return response({
        ...ready,
        connection: { ...ready.connection, generation: 2 },
        install: { source: "fixture", path: "C:\\new\\codex.exe" },
      });
  });
  const pending = poll();
  d.getElementById("reconnect").click();
  await until(() => !d.getElementById("reconnect").disabled);
  old.resolve(response(ready));
  await pending;
  assert.match(
    d.getElementById("installation").textContent,
    /C:\\new\\codex.exe/,
  );
});

test("successful status polling clears only the recovered transport warning", async (t) => {
  const { d, respond, poll } = await setup(t);
  respond((url) => {
    if (url.pathname === "/api/status")
      throw Error("synthetic transport fault");
  });
  await poll();
  assert.match(d.getElementById("notice").textContent, /可能已退出/);
  respond(() => undefined);
  await poll();
  assert.equal(d.getElementById("status").textContent, "Codex 已连接");
  assert.equal(d.getElementById("notice").hidden, true);
});

test("transport recovery preserves a business error from a failed user request", async (t) => {
  const { d, respond, poll, search } = await setup(t);
  respond((url) => {
    if (url.pathname === "/api/sessions")
      return response({ message: "搜索内容最多 200 字。" }, false);
  });
  await search("rejected");
  assert.match(d.getElementById("notice").textContent, /搜索内容最多/);
  respond((url) => {
    if (url.pathname === "/api/status")
      throw Error("synthetic transport fault");
  });
  await poll();
  respond(() => undefined);
  await poll();
  assert.equal(d.getElementById("notice").hidden, false);
  assert.match(d.getElementById("notice").textContent, /搜索内容最多/);
});

test("automatic connection recovery does not clear an unrelated business error", async (t) => {
  const { d, respond, poll, search } = await setup(t);
  respond((url) => {
    if (url.pathname === "/api/sessions")
      return response({ message: "搜索内容最多 200 字。" }, false);
  });
  await search("rejected");
  respond((url) => {
    if (url.pathname === "/api/status")
      return response({
        ...ready,
        status: "error",
        error: { message: "连接已断开", action: "重新连接" },
      });
  });
  await poll();
  respond((url) => {
    if (url.pathname === "/api/status")
      return response({
        ...ready,
        connection: { ...ready.connection, generation: 2 },
      });
  });
  await poll();
  assert.equal(d.getElementById("status").textContent, "Codex 已连接");
  assert.match(d.getElementById("notice").textContent, /搜索内容最多/);
});
