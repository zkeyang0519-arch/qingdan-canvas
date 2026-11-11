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
  let failLists = false;
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:51234/#token=" + "a".repeat(64),
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    d = w.document;
  w.setInterval = () => 0;
  w.fetch = async (route, options) => {
    const url = new URL(route, w.location.href);
    calls.push({ url, options });
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
