import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createObject, makeBlock } from "../src/canvas/model.js";
import { requestDesktopExit } from "./lib/desktop-installation.mjs";

const require = createRequire(import.meta.url);
const { _electron } = require(
  process.env.QINGDAN_QA_PLAYWRIGHT || "playwright",
);
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const packaged = args.includes("--packaged");
const externalUpdateExit = args.includes("--external-update-exit");
const executable = args.includes("--electron")
  ? path.resolve(args[args.indexOf("--electron") + 1])
  : require("electron");
await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
const evidence = await fs.mkdtemp(path.join(root, ".tmp/desktop-restart-qa-"));
const profile = path.join(evidence, "isolated-profile");
await build({
  entryPoints: [path.join(root, "tests/fixtures/desktop-restart.jsx")],
  bundle: true,
  format: "esm",
  outfile: path.join(evidence, "fixture.js"),
});
const room = {
  id: "qa-restart-room",
  name: "隔离重启验收",
  role: "owner",
  createdAt: "2026-11-14T00:00:00.000Z",
};
const user = { id: "qa-restart-user", name: "隔离测试" };
const note = {
  ...createObject(room.id, "note"),
  id: "qa-note",
  noteKind: "checklist",
  blocks: [makeBlock("首要待办：确认更新保留内容"), makeBlock("第二条待办")],
};
const rows = [{ id: note.id, revision: 1, deleted: false, data: note }];
let issueSession = true,
  authenticatedReads = 0,
  commits = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (url.pathname === "/app") {
      if (issueSession) {
        res.setHeader(
          "Set-Cookie",
          "qa_desktop_session=synthetic-persistent-session; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600",
        );
        issueSession = false;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
      );
      return;
    }
    if (url.pathname === "/api/qa-session") {
      if (
        !req.headers.cookie?.includes(
          "qa_desktop_session=synthetic-persistent-session",
        )
      ) {
        res.writeHead(401).end();
        return;
      }
      authenticatedReads++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ user, room }));
      return;
    }
    const file = ["/fixture.js", "/fixture.css"].includes(url.pathname)
      ? path.join(evidence, url.pathname.slice(1))
      : /^\/animals\/runcat\/[a-z-]+\.png$/.test(url.pathname)
        ? path.join(root, "public", url.pathname.slice(1))
        : null;
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "image/png",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(500).end();
  }
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "snapshot", rows }));
  socket.on("message", (bytes) => {
    if (String(bytes) === "ping") {
      socket.send("pong");
      return;
    }
    const message = JSON.parse(String(bytes));
    if (message.type === "commit") commits++;
    // Deliberately withhold ack to test recovery of pending local operations.
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/app?room=${room.id}`;
const env = {
  ...process.env,
  QINGDAN_DESKTOP_PROFILE: profile,
  QINGDAN_DESKTOP_URL: url,
};
delete env.ELECTRON_RUN_AS_NODE;
let instance;
const errors = [];
const persisted = async (page, predicate) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const saved = await page.evaluate(async () => await window.qaReadDraft());
    if (predicate(saved)) return saved;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw Error("Timed out waiting for durable replica state");
};
const launch = async () => {
  instance = await _electron.launch({
    executablePath: executable,
    args: packaged ? [] : [path.join(root, "desktop/main.cjs")],
    env,
    cwd: root,
    timeout: 45000,
  });
  const page = await instance.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".island-desktop-header", { timeout: 20000 });
  await page.waitForFunction(() =>
    document
      .querySelector(".island-summary")
      ?.textContent?.includes("首要待办"),
  );
  await page.waitForFunction(() => innerWidth < 500 && innerHeight < 120);
  return page;
};
const quit = async () => {
  const child = instance.process();
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Native saved quit timed out")),
      15000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (externalUpdateExit) {
    const native = await instance.evaluate(({ app }) => ({ packaged: app.isPackaged, pid: process.pid, version: app.getVersion(), profile: app.getPath("userData") }));
    assert.equal(native.packaged, true, "External update QA must use a packaged application");
    assert.equal(path.resolve(native.profile), path.resolve(profile));
    await requestDesktopExit(profile, { running: [native.pid] });
  }
  else
    await instance.evaluate(({ app }) => {
      app.quit();
    });
  await exited;
  instance = null;
};
try {
  let page = await launch();
  const firstPid = instance.process().pid;
  assert.equal(
    await page.evaluate(() => document.cookie.includes("qa_desktop_session")),
    false,
  );
  await page.screenshot({
    path: path.join(evidence, "collapsed.png"),
    omitBackground: true,
  });
  await page.getByRole("button", { name: "展开轻岛", exact: true }).click();
  const input = page.getByRole("textbox", { name: "新增待办", exact: true });
  await input.fill("离线新增待办：重启后仍在");
  await input.press("Enter");
  await page.waitForFunction(
    () => document.querySelector("textarea")?.value === "",
  );
  await input.fill("未提交输入第一行\n第二行也要保留");
  const before = await persisted(page, (saved) => !!saved?.replica?.flight);
  assert.ok(
    before.replica.objects.some((item) =>
      JSON.stringify(item).includes("离线新增待办"),
    ),
  );
  const operationId = before.replica.flight.opId;
  await quit();
  page = await launch();
  const secondPid = instance.process().pid;
  assert.notEqual(firstPid, secondPid);
  assert.equal(authenticatedReads, 2);
  assert.equal(
    await page.evaluate(() => document.cookie.includes("qa_desktop_session")),
    false,
  );
  const cookies = await instance.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({
      name: "qa_desktop_session",
    }),
  );
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].session, false);
  await page.getByRole("button", { name: "展开轻岛", exact: true }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "新增待办", exact: true })
      .inputValue(),
    "未提交输入第一行\n第二行也要保留",
  );
  const restored = await persisted(
    page,
    (saved) => saved?.replica?.objects?.length === 2,
  );
  assert.equal(restored.replica.flight.opId, operationId);
  assert.ok(
    restored.replica.objects.some((item) =>
      JSON.stringify(item).includes("离线新增待办"),
    ),
  );
  await page.screenshot({
    path: path.join(evidence, "restored.png"),
    omitBackground: true,
  });
  await quit();
  assert.deepEqual(errors, []);
  const report = {
    packaged,
    executable,
    firstPid,
    secondPid,
    authenticatedReads,
    httpOnlyPersistentCookie: true,
    indexedDbPendingOperationRetained: true,
    unsentMultilineInputRetained: true,
    firstTodoCollapsed: true,
    nativeSavedQuit: true,
    externalUpdateExit,
    commits,
    errors,
    evidence,
    limitation:
      "Isolated synthetic session and WebSocket server; actual workspace renderer, sync hook, IndexedDB and native saved quit. Does not invoke a downloaded installer or production authentication.",
  };
  await fs.writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (instance) await instance.close().catch(() => {});
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
