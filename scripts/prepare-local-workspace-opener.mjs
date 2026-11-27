// Native UI acceptance fixture. Operate it through normal desktop clicks.
// Only external browser launch is redirected into a fresh, disposable profile.
import { build } from "esbuild";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";
import { createObject, makeBlock } from "../src/canvas/model.js";

if (!process.argv.includes("--isolated-local"))
  throw Error("Pass --isolated-local to prepare an isolated UI acceptance fixture.");
const root = process.cwd();
const directory = await fs.mkdtemp(path.resolve(".tmp/workspace-opener-qa-"));
const profile = path.join(directory, "profile");
const browserProfile = path.join(directory, "browser-profile");
const require = createRequire(import.meta.url);
const browser = [
  path.join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
  path.join(process.env.ProgramFiles || "C:/Program Files", "Microsoft/Edge/Application/msedge.exe"),
].find((file) => require("node:fs").existsSync(file));
if (!browser) throw Error("An installed Edge is required for this isolated browser fixture.");
await build({
  entryPoints: ["tests/fixtures/desktop-restart.jsx"],
  outfile: path.join(directory, "fixture.js"),
  bundle: true,
  format: "esm",
  external: ["/fonts/*", "/island/*"],
});
const room = { id: "qa-restart-room", name: "小舱网页复用验收", role: "owner", createdAt: new Date().toISOString() };
const user = { id: "qa-restart-user", name: "本地隔离验收" };
const note = { ...createObject(room.id, "note"), id: "qa-note", noteKind: "checklist", blocks: [makeBlock("保留设置，唤回已有轻单")] };
const rows = [{ id: note.id, revision: 1, deleted: false, data: note }];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/qa-session") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ user, room }));
    }
    if (url.pathname === "/app") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(req.headers["user-agent"]?.includes("Electron/")
        ? '<!doctype html><html><head><meta charset="utf-8"><title>轻单 · 小舱验收</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'
        : '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>轻单 · 小舱唤回验收</title></head><body style="font:18px system-ui;padding:40px"><h1>轻单 · 小舱唤回验收</h1><p>这是独立浏览器配置中的本地测试页。</p><label>保留当前页面输入 <textarea aria-label="保留当前页面输入" rows="3">这段输入不能因为点击小舱而丢失</textarea></label></body></html>');
    }
    const base = ["/fixture.js", "/fixture.css"].includes(url.pathname) ? directory : path.resolve("public");
    const file = path.resolve(base, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(base + path.sep)) return res.writeHead(404).end();
    const types = { ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "snapshot", rows }));
  socket.on("message", (bytes) => {
    if (String(bytes) === "ping") socket.send("pong");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/app?room=${room.id}`;
const main = path.join(directory, "main.cjs");
await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "qingdao-workspace-opener-qa", version: "0.3.12-beta.13", main: "main.cjs" }));
await fs.writeFile(main, `
const electron = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const expected = ${JSON.stringify(url)};
electron.shell.openExternal = async (value) => {
  if (value !== expected) throw Error('Fixture refused a non-test browser destination');
  fs.appendFileSync(${JSON.stringify(path.join(directory, "launches.jsonl"))}, JSON.stringify({at:Date.now()})+'\\n');
  const child = spawn(${JSON.stringify(browser)}, ['--user-data-dir='+${JSON.stringify(browserProfile)}, '--guest', '--disable-sync', '--no-first-run', '--no-default-browser-check', value], {windowsHide:true, detached:true, stdio:'ignore'});
  child.unref();
};
require(${JSON.stringify(path.resolve("desktop/main.cjs"))});
`);
const env = { ...process.env, QINGDAN_DESKTOP_PROFILE: profile, QINGDAN_DESKTOP_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
delete env.QINGDAO_UPDATE_QA;
const child = spawn(require("electron"), [directory], { cwd: root, env, windowsHide: true, stdio: "ignore" });
const metadata = { directory, profile, browserProfile, url, pid: child.pid };
await fs.writeFile(path.resolve(".tmp/workspace-opener-current.json"), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify(metadata));
child.once("exit", () => {
  for (const socket of sockets.clients) socket.terminate();
  server.closeAllConnections();
  server.close();
});
