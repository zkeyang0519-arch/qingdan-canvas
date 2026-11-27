// Real NSIS + electron-updater acceptance. Never run against a user's desktop.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { createObject, makeBlock } from "../src/canvas/model.js";
import { digest } from "../runner/harness/task-store.mjs";

const root = process.cwd();
if (
  process.platform !== "win32" ||
  process.env.CI !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  !process.env.RUNNER_TEMP
)
  throw Error(
    "This installs software: use a disposable GitHub-hosted Windows runner only.",
  );
const require = createRequire(import.meta.url);
const { _electron, chromium } = require(
  process.env.QINGDAN_QA_PLAYWRIGHT || "playwright",
);
const [firstOutput, secondOutput] = process.argv
  .slice(2)
  .map((p) => path.resolve(p));
if (!firstOutput || !secondOutput)
  throw Error("Provide the two packaged beta output directories.");
const installerAt = async (output) => {
  const names = (await fs.readdir(output)).filter((name) =>
    /^Qingdao-Beta-Setup-\d+\.\d+\.\d+-beta\.\d+-x64\.exe$/.test(name),
  );
  assert.equal(names.length, 1);
  return path.join(output, names[0]);
};
const firstInstaller = await installerAt(firstOutput),
  secondInstaller = await installerAt(secondOutput);
const firstVersion = path.basename(firstInstaller).match(/Setup-(.*)-x64/)[1],
  secondVersion = path.basename(secondInstaller).match(/Setup-(.*)-x64/)[1];
assert.notEqual(firstVersion, secondVersion);
const evidence = await fs.mkdtemp(
  path.join(process.env.RUNNER_TEMP, "qingdao-update-"),
);
const installDir = path.join(evidence, "installed"),
  profile = path.join(evidence, "profile");
const reportDir = path.resolve("output/desktop-update-evidence");
await fs.mkdir(reportDir, { recursive: true });
const executable = path.join(installDir, "QingdaoBeta.exe");
const installedResources = path.join(installDir, "resources");
const run = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: "pipe",
      ...options,
    });
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data;
    });
    child.stderr?.on("data", (data) => {
      output += data;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            Error(
              `${path.basename(file)} failed (${code}): ${output.slice(-2000)}`,
            ),
          ),
    );
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 90000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error.message;
    }
    await delay(300);
  }
  throw Error(`Timed out: ${label}${last ? ": " + last : ""}`);
}
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
await run("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "if (Test-Path -LiteralPath 'HKCU:\\Software\\Classes\\qingdao-beta') { throw 'Beta installation already exists; refusing to overwrite.' }",
]);
await run(firstInstaller, ["/S", "/D=" + installDir]);
await fs.access(executable);

const room = {
  id: "qa-update-room",
  name: "独立升级验收",
  role: "owner",
  createdAt: new Date().toISOString(),
};
const user = { id: "qa-update-user", name: "隔离验收账号" };
const note = {
  ...createObject(room.id, "note"),
  id: "qa-note",
  noteKind: "checklist",
  blocks: [makeBlock("原有待办：升级后仍保留")],
};
const rows = [{ id: note.id, revision: 1, deleted: false, data: note }];
let issueSession = true,
  authenticatedReads = 0,
  generateCalls = 0;
let baseUrl;
const progress = [],
  commitIds = new Set(),
  errors = [];
const json = (res, value, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/updates/")) {
      const name = decodeURIComponent(url.pathname.slice(9));
      if (
        ![
          "beta.yml",
          path.basename(secondInstaller),
          path.basename(secondInstaller) + ".blockmap",
        ].includes(name)
      )
        return res.writeHead(404).end();
      const file = path.join(secondOutput, name),
        bytes = await fs.readFile(file);
      res.writeHead(200, {
        "Content-Length": bytes.length,
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      });
      // A bounded stream makes real progress observable even on loopback.
      for (
        let offset = 0;
        offset < bytes.length && !res.destroyed;
        offset += 1024 * 1024
      ) {
        res.write(bytes.subarray(offset, offset + 1024 * 1024));
        await delay(10);
      }
      return res.end();
    }
    if (url.pathname === "/mcp") {
      if (req.method !== "POST") return res.writeHead(405).end();
      let raw = "";
      for await (const bytes of req) raw += bytes;
      const packet = JSON.parse(raw);
      if (packet.method === "notifications/initialized")
        return res.writeHead(202).end();
      const result =
        packet.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "isolated-remote-generation", version: "1" },
            }
          : packet.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "submit_generation",
                    description: "隔离生成服务，返回原任务回执",
                    inputSchema: {
                      type: "object",
                      properties: { prompt: { type: "string" } },
                      required: ["prompt"],
                    },
                  },
                ],
              }
            : packet.method === "tools/call"
              ? (generateCalls++,
                {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        taskId: "original-remote-receipt",
                        state: "submitted",
                      }),
                    },
                  ],
                })
              : null;
      return json(res, { jsonrpc: "2.0", id: packet.id, result });
    }
    if (url.pathname === "/api/session") {
      if (!req.headers.cookie?.includes("qd_session=isolated-update-session"))
        return json(res, { error: "not signed in" }, 401);
      authenticatedReads++;
      return json(res, { user });
    }
    if (url.pathname === "/api/rooms") return json(res, { rooms: [room] });
    if (url.pathname === "/api/rooms/" + room.id) return json(res, { room });
    if (url.pathname.startsWith("/api/"))
      return json(
        res,
        { error: "isolated fixture has no such operation" },
        404,
      );
    if (url.pathname === "/app" && issueSession) {
      res.setHeader(
        "Set-Cookie",
        "qd_session=isolated-update-session; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600",
      );
      issueSession = false;
    }
    const relative =
      url.pathname === "/app"
        ? "index.html"
        : decodeURIComponent(url.pathname.slice(1));
    const webRoot = path.join(installedResources, "web"),
      file = path.resolve(webRoot, relative);
    if (!file.startsWith(webRoot + path.sep)) return res.writeHead(404).end();
    const types = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".woff2": "font/woff2",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".json": "application/json",
    };
    res.setHeader(
      "Content-Type",
      types[path.extname(file)] || "application/octet-stream",
    );
    res.setHeader("Cache-Control", "no-store");
    res.end(await fs.readFile(file));
  } catch (error) {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "snapshot", rows }));
  socket.on("message", (bytes) => {
    if (String(bytes) === "ping") return socket.send("pong");
    const message = JSON.parse(String(bytes));
    // Keep a real unacknowledged operation across replacement of the installer.
    if (message.type === "commit") commitIds.add(message.opId);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
baseUrl = "http://127.0.0.1:" + server.address().port;
const debugPort = await freePort();
const env = {
  ...process.env,
  QINGDAO_UPDATE_QA: "1",
  QINGDAO_QA_FEED: baseUrl + "/updates/",
  QINGDAO_QA_DEBUG_PORT: String(debugPort),
  QINGDAN_DESKTOP_PROFILE: profile,
  QINGDAN_DESKTOP_URL: baseUrl + "/app?room=" + room.id,
};
delete env.ELECTRON_RUN_AS_NODE;
let instance, browser, page, remoteManager;
const draft = async (page) =>
  page.evaluate(async () => {
    const request = indexedDB.open("qingdan-canvas", 1);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction("drafts")
          .objectStore("drafts")
          .get("qa-update-user/qa-update-room/desktop-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
try {
  instance = await _electron.launch({
    executablePath: executable,
    args: [],
    env,
    timeout: 60000,
  });
  page = await instance.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".island-desktop-header", { timeout: 60000 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.dataset.qingdanBuildVersion,
    ),
    firstVersion,
  );
  await instance.evaluate(({ shell }) => {
    globalThis.qaOpened = [];
    shell.openExternal = async (url) => {
      globalThis.qaOpened.push(url);
    };
  });
  await page.evaluate(() => {
    window.qaUpdateStates = [];
    window.qingdanDesktop.onUpdateState((state) =>
      window.qaUpdateStates.push({
        status: state.status,
        progress: state.progress,
      }),
    );
  });
  await page.getByRole("button", { name: "展开轻岛", exact: true }).click();
  const input = page.getByRole("textbox", { name: "新增待办", exact: true });
  await input.fill("升级验收新增待办");
  await input.press("Enter");
  await input.fill("未提交输入第一行\n第二行也要保留");
  const before = await until(async () => {
    const state = await draft(page);
    return (
      state?.replica?.flight &&
      JSON.stringify(state).includes("升级验收新增待办") &&
      state
    );
  }, "durable todo");
  await page.getByRole("button", { name: "轻岛设置", exact: true }).click();
  await page.getByRole("button", { name: "色块流动", exact: true }).click();
  await page
    .getByRole("combobox", { name: "轻岛配色组合" })
    .selectOption("sage");
  await page.getByRole("button", { name: "添加本地服务", exact: true }).click();
  await until(
    async () =>
      (await page.evaluate(() => window.qingdanDesktop.getLocalService()))
        .status === "online",
    "owned local service startup",
  );
  await page.getByRole("button", { name: "打开工作区", exact: true }).click();
  const localEntry = await until(
    () =>
      instance.evaluate(() =>
        globalThis.qaOpened.find((url) =>
          url.includes("/local/desktop-signin?"),
        ),
      ),
    "one-use native login ticket",
  );
  const ticket = await fetch(localEntry, { redirect: "manual" });
  assert.equal(ticket.status, 303);
  const localCookie = ticket.headers.get("set-cookie").split(";")[0],
    localOrigin = new URL(localEntry).origin;
  const localSession = await (
    await fetch(localOrigin + "/api/session", {
      headers: { Cookie: localCookie },
    })
  ).json();
  assert.ok(localSession.user.id);
  const auth = {
    "X-Qingdan-Local": "1",
    Cookie: localCookie,
    Origin: localOrigin,
    "X-QD-Account": localSession.user.id,
    "Content-Type": "application/json",
  };
  const api = async (route, body) => {
    const response = await fetch(localOrigin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: auth,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.ok(response.ok, route + ": " + JSON.stringify(value));
    return value;
  };
  const models = await api("/api/agent/chat/models", {
    action: "add",
    service: "验收模型",
    model: "qa-model",
    baseUrl: "https://models.example.com/v1",
    apiKey: "not-a-real-key",
    apiFormat: "responses",
  });
  const model = models.profiles.find((item) => item.model === "qa-model");
  await api("/api/agent/chat/models", { action: "default", id: model.id });
  const pairing = await api("/api/agent/devices/pairings", {});
  await api("/api/local-runner/pair", {
    pairingCode: pairing.pairingCode,
    deviceName: "隔离升级验收设备",
  });
  const workspaceRoot = path.join(evidence, "workspace");
  await fs.mkdir(workspaceRoot);
  const registered = await api("/api/local-runner/workspaces", {
    root: workspaceRoot,
    name: "隔离升级项目",
  });
  const localRoom = (await api("/api/rooms", { name: "隔离升级项目" })).room;
  const devices = await until(async () => {
    const value = await api("/api/agent/devices");
    return (
      value.devices.some(
        (d) => d.status === "online" && d.workspaces?.length,
      ) && value.devices
    );
  }, "registered device");
  const device = devices.find(
      (d) => d.status === "online" && d.workspaces?.length,
    ),
    workspace = device.workspaces.find((w) => w.name === "隔离升级项目");
  const binding = (
    await api("/api/agent/bindings", {
      canvasId: localRoom.id,
      sectionId: "ungrouped",
      runnerId: device.runnerId,
      workspaceId: workspace.workspaceId,
      expectedRevision: null,
    })
  ).binding;
  const ownerDir = path.join(
    profile,
    "local-service/data/.tmp/pi-main",
    digest(localSession.user.id).slice(0, 24),
  );
  // Use the inspected runtime's classes outside the installed tree so this
  // checker never locks files that NSIS needs to replace.
  const mcpModule = await import(
    pathToFileURL(
      path.join(
        path.join(firstOutput, "win-unpacked/resources"),
        "local-service/scripts/pi-local/mcp-connections.mjs",
      ),
    )
  );
  const credentialFile = () => ({
    load: async () => ({}),
    save: async () => {},
    clear: async () => {},
  });
  remoteManager = new mcpModule.McpConnections(ownerDir, {
    origin: localOrigin,
    credentialFile,
  });
  const connector = await remoteManager.add({
    name: "验收远端生成",
    url: baseUrl + "/mcp",
    authMode: "auto",
  });
  remoteManager.setSelection(binding.bindingId, connector.id, [
    "submit_generation",
  ]);
  const scope = {
    bindingId: binding.bindingId,
    chatId: "qa-chat",
    userMessageId: "qa-message",
  };
  const turn = remoteManager.turn(scope);
  const result = await turn.execute(
    turn.specs[0].name,
    { prompt: "isolated fixture" },
    "original-call",
    AbortSignal.timeout(10000),
  );
  assert.match(JSON.stringify(result), /original-remote-receipt/);
  await turn.close();
  await remoteManager.close();
  remoteManager = null;
  const taskModule = await import(
    pathToFileURL(
      path.join(
        path.join(firstOutput, "win-unpacked/resources"),
        "local-service/runner/harness/task-store.mjs",
      ),
    )
  );
  const tasks = new taskModule.TaskStore(ownerDir),
    taskScope = { ...scope, accountId: localSession.user.id, memoryEpoch: 0 };
  tasks.claim(taskScope, "qa-checkpoint");
  const task = tasks.create(taskScope, "qa-checkpoint", "保存原远端回执", {
    maxRequests: 1,
  });
  tasks.putEffect(taskScope, "qa-checkpoint", task.id, "generation", {
    taskId: "original-remote-receipt",
    delivery: "received",
  });
  task.status = "interrupted";
  tasks.save(taskScope, "qa-checkpoint", task, "checkpoint");
  tasks.release(taskScope, "qa-checkpoint");
  tasks.close();
  await until(
    async () => {
      const state = await page.evaluate(() =>
        window.qingdanDesktop.getUpdateState(),
      );
      if (state.status === "error") throw Error(state.error);
      return state.status === "downloaded";
    },
    "real installer download",
    180000,
  );
  progress.push(...(await page.evaluate(() => window.qaUpdateStates)));
  assert.ok(
    progress.some(
      (state) =>
        state.status === "downloading" && Number.isFinite(state.progress),
    ),
    "must show real download progress",
  );
  await page.screenshot({ path: path.join(reportDir, "before-update.png") });
  // Remove the initial URL: the relaunched binary must read the saved project.
  await instance.evaluate(() => {
    delete process.env.QINGDAN_DESKTOP_URL;
  });
  const child = instance.process(),
    originalPid = child.pid;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await page
    .getByRole("button", { name: "重启并更新", exact: true })
    .first()
    .click();
  await Promise.race([
    exited,
    delay(120000).then(() => {
      throw Error("v1 did not exit after update click");
    }),
  ]);
  instance = null;
  // No second launch here. Attach only to the process auto-started by NSIS.
  browser = await until(
    async () => {
      const b = await chromium.connectOverCDP("http://127.0.0.1:" + debugPort, {
        timeout: 2000,
      });
      const p = b
        .contexts()[0]
        ?.pages()
        .find((page) => page.url().includes("/app"));
      if (
        !p ||
        (await p
          .evaluate(() => document.documentElement.dataset.qingdanBuildVersion)
          .catch(() => null)) !== secondVersion
      ) {
        await b.close();
        return false;
      }
      page = p;
      return b;
    },
    "NSIS automatic restart",
    180000,
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".island-desktop-header");
  assert.equal(
    (await page.evaluate(() => window.qingdanDesktop.getUpdateState()))
      .currentVersion,
    secondVersion,
  );
  assert.equal(new URL(page.url()).searchParams.get("room"), room.id);
  const cookie = (await browser.contexts()[0].cookies()).find(
    (cookie) =>
      cookie.name === "qd_session" &&
      cookie.value === "isolated-update-session",
  );
  assert.ok(cookie?.httpOnly && cookie.expires > Date.now() / 1000);
  await page.getByRole("button", { name: "展开轻岛", exact: true }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "新增待办", exact: true })
      .inputValue(),
    "未提交输入第一行\n第二行也要保留",
  );
  const after = await until(async () => {
    const state = await draft(page);
    return state?.replica?.flight && state;
  }, "restored replica");
  assert.equal(after.replica.flight.opId, before.replica.flight.opId);
  assert.match(JSON.stringify(after), /升级验收新增待办/);
  await page.getByRole("button", { name: "轻岛设置", exact: true }).click();
  assert.equal(
    await page.getByRole("combobox", { name: "轻岛配色组合" }).inputValue(),
    "sage",
  );
  await until(async () => {
    const state = await page.evaluate(() =>
      window.qingdanDesktop.getLocalService(),
    );
    return state.status === "online" && state.version === secondVersion;
  }, "matching local service restart");
  assert.equal((await api("/api/session")).user.id, localSession.user.id);
  assert.equal((await api("/api/agent/chat/models")).defaultId, model.id);
  const restoredDevices = await until(async () => {
    const data = await api("/api/agent/devices");
    return data.devices.find(
      (d) => d.runnerId === device.runnerId && d.status === "online",
    );
  }, "same device reconnect");
  assert.equal(restoredDevices.runnerId, device.runnerId);
  assert.equal(
    (
      await api(
        `/api/agent/bindings?canvasId=${localRoom.id}&sectionId=ungrouped`,
      )
    ).binding.bindingId,
    binding.bindingId,
  );
  remoteManager = new mcpModule.McpConnections(ownerDir, {
    origin: localOrigin,
    credentialFile,
  });
  await remoteManager.initialCheck;
  const retryTurn = remoteManager.turn({ ...scope, retry: true });
  const cached = await retryTurn.execute(
    retryTurn.specs[0].name,
    { prompt: "isolated fixture" },
    "new-call",
    AbortSignal.timeout(10000),
  );
  assert.match(JSON.stringify(cached), /original-remote-receipt/);
  assert.equal(generateCalls, 1);
  await retryTurn.close();
  await remoteManager.close();
  remoteManager = null;
  const restoredTasks = new taskModule.TaskStore(ownerDir);
  assert.equal(restoredTasks.get(task.id).status, "interrupted");
  assert.equal(
    restoredTasks.effect(task.id, "generation").taskId,
    "original-remote-receipt",
  );
  restoredTasks.close();
  assert.ok(authenticatedReads >= 2);
  assert.equal(commitIds.size, 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(reportDir, "after-update.png") });
  const report = {
    firstVersion,
    secondVersion,
    realInstallers: true,
    oneClick: true,
    automaticRestart: true,
    originalPid,
    sessionRestored: true,
    todoRestored: true,
    multilineDraftRestored: true,
    projectRestored: true,
    appearanceRestored: true,
    modelRestored: true,
    sameDeviceReconnected: true,
    bindingRestored: true,
    mcpRestored: true,
    originalReceiptRestored: true,
    generationCalls: generateCalls,
    checkpointRestored: true,
    matchingServiceVersion: true,
    progress,
    errors,
    signing: "unsigned acceptance only",
    externalProviders: "isolated fixtures; no paid model or WAAO requests",
  };
  await fs.writeFile(
    path.join(reportDir, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await fs.writeFile(
    path.join(reportDir, "failure.json"),
    JSON.stringify(
      { message: error.message, stack: error.stack, errors, evidence },
      null,
      2,
    ),
  );
  await page
    ?.screenshot({ path: path.join(reportDir, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await remoteManager?.close().catch(() => {});
  if (page && !page.isClosed())
    await page
      .evaluate(() => window.qingdanDesktop.stopLocalService())
      .catch(() => {});
  if (instance) await instance.close().catch(() => {});
  // The disposable runner cleans up the relaunched app; do not kill by process name.
  await browser?.close().catch(() => {});
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
