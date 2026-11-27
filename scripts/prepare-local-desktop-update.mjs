// Local counterpart of the disposable CI test. UI steps are performed in the
// native Beta window; this helper only prepares isolated data and an update feed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { createObject, makeBlock } from "../src/canvas/model.js";
import { createManagedLocalService } from "../desktop/local-service.cjs";
import { saveResume } from "../desktop/resume-state.cjs";
import { digest } from "../runner/harness/task-store.mjs";

if (process.platform !== "win32" || !process.argv.includes("--isolated-local"))
  throw Error(
    "Explicit --isolated-local is required for the authorized Windows Beta test.",
  );
const outputs = process.argv
  .slice(2)
  .filter((x) => x !== "--isolated-local")
  .map((x) => path.resolve(x));
assert.equal(outputs.length, 2);
const installerAt = async (output) => {
  const names = (await fs.readdir(output)).filter((name) =>
    /^Qingdao-Beta-Setup-\d+\.\d+\.\d+-beta\.\d+-x64\.exe$/.test(name),
  );
  assert.equal(names.length, 1);
  return path.join(output, names[0]);
};
const firstInstaller = await installerAt(outputs[0]),
  secondInstaller = await installerAt(outputs[1]);
const firstVersion = path.basename(firstInstaller).match(/Setup-(.*)-x64/)[1],
  secondVersion = path.basename(secondInstaller).match(/Setup-(.*)-x64/)[1];
assert.notEqual(firstVersion, secondVersion);
const run = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: "pipe",
      ...options,
    });
    let output = "";
    child.stdout?.on("data", (data) => (output += data));
    child.stderr?.on("data", (data) => (output += data));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            Error(
              path.basename(file) +
                " exited " +
                code +
                ": " +
                output.slice(-1000),
            ),
          ),
    );
  });
const readStableProtocol = () =>
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\qingdao\\shell\\open\\command'); if($k){$v=$k.GetValue('');$k.Close();$v}",
  ]);
const stableProtocolBefore = await readStableProtocol();
const { UUID } = createRequire(import.meta.url)("builder-util-runtime");
const betaGuid = UUID.v5(
  "cn.zky.qingdao.beta",
  UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"),
);
await run("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "if ((Test-Path -LiteralPath 'HKCU:\\Software\\Classes\\qingdao-beta') -or (Test-Path -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" +
    betaGuid +
    "')) { throw 'An existing Beta application is registered. Do not replace it for testing.' }",
]);
for (const port of [8793, 8794, 8795])
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(Error("Test port is in use: " + port)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
const id = randomUUID(),
  directory = path.resolve(".tmp", "qingdao-update-local-" + id);
await fs.mkdir(directory);
const profile = path.join(directory, "profile"),
  installDir = path.join(directory, "installed");
await fs.mkdir(profile);
const logFile = path.join(directory, "evidence.json"),
  requestFile = path.resolve(".tmp/local-desktop-update-current.json");
let baseUrl, service, localCookie, localSession, binding, device, model, taskId;
let issued = false,
  sessionReads = 0,
  generationCalls = 0,
  appLoads = [];
const commits = new Set(),
  room = {
    id: "qa-update-local-room",
    name: "本地隔离升级验收",
    role: "owner",
    createdAt: new Date().toISOString(),
  },
  user = { id: "qa-update-local-user", name: "升级验收测试账号" };
const note = {
  ...createObject(room.id, "note"),
  id: "qa-note",
  noteKind: "checklist",
  blocks: [makeBlock("原有待办：更新后保留")],
};
const rows = [{ id: note.id, revision: 1, deleted: false, data: note }];
const resources = path.join(installDir, "resources"),
  localOrigin = "http://localhost:8794";
const localApi = async (route, body) => {
  const response = await fetch(localOrigin + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: localCookie,
      Origin: localOrigin,
      "X-QD-Account": localSession.user.id,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  assert.ok(response.ok, route + ": " + JSON.stringify(value));
  return value;
};
const json = (res, value, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/qa/status")
      return json(res, {
        firstVersion,
        secondVersion,
        appLoads,
        sessionReads,
        commits: [...commits],
        generationCalls,
        directory,
      });
    if (url.pathname === "/qa/verify") return json(res, await verify());
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
      const bytes = await fs.readFile(path.join(outputs[1], name));
      res.writeHead(200, {
        "Content-Length": bytes.length,
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      });
      for (
        let offset = 0;
        offset < bytes.length && !res.destroyed;
        offset += 1024 * 1024
      ) {
        res.write(bytes.subarray(offset, offset + 1024 * 1024));
        await new Promise((resolve) => setTimeout(resolve, 15));
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
              serverInfo: { name: "local-qa-remote", version: "1" },
            }
          : packet.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "submit_generation",
                    description: "本地模拟生成回执",
                    inputSchema: {
                      type: "object",
                      properties: { prompt: { type: "string" } },
                      required: ["prompt"],
                    },
                  },
                ],
              }
            : packet.method === "tools/call"
              ? (generationCalls++,
                {
                  content: [
                    {
                      type: "text",
                      text: '{"taskId":"original-remote-task","state":"submitted"}',
                    },
                  ],
                })
              : null;
      return json(res, { jsonrpc: "2.0", id: packet.id, result });
    }
    if (url.pathname === "/api/session") {
      if (!req.headers.cookie?.includes("qd_session=isolated-local-update"))
        return json(res, { error: "No fixture session" }, 401);
      sessionReads++;
      return json(res, { user });
    }
    if (url.pathname === "/api/rooms") return json(res, { rooms: [room] });
    if (url.pathname === "/api/rooms/" + room.id) return json(res, { room });
    if (url.pathname.startsWith("/api/"))
      return json(res, { error: "No fixture endpoint" }, 404);
    const webRoot = path.join(resources, "web"),
      file = path.resolve(
        webRoot,
        url.pathname === "/app"
          ? "index.html"
          : decodeURIComponent(url.pathname.slice(1)),
      );
    if (!file.startsWith(webRoot + path.sep)) return res.writeHead(404).end();
    if (url.pathname === "/app") {
      if (!issued) {
        res.setHeader(
          "Set-Cookie",
          "qd_session=isolated-local-update; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400",
        );
        issued = true;
      }
      const html = await fs.readFile(file, "utf8");
      appLoads.push(
        html.match(/name="qingdan-build-version" content="([^"]+)"/)?.[1],
      );
    }
    const types = {
      ".html": "text/html; charset=utf-8",
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
    if (!res.headersSent) return json(res, { error: error.message }, 500);
    res.end();
  }
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "snapshot", rows }));
  socket.on("message", (bytes) => {
    if (String(bytes) === "ping") return socket.send("pong");
    const message = JSON.parse(String(bytes));
    if (message.type === "commit") commits.add(message.opId);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
baseUrl = "http://127.0.0.1:" + server.address().port;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(path|pathext|systemroot|windir|comspec|tmp|temp|userprofile|appdata|localappdata|systemdrive|node_extra_ca_certs|ssl_cert_file|https?_proxy|no_proxy)$/i.test(
      key,
    ),
  ),
);
const scope = {
  bindingId: "",
  chatId: "qa-local-chat",
  userMessageId: "qa-local-message",
};
let ownerDir, McpConnections, TaskStore;
const credentialFile = () => ({
  load: async () => ({}),
  save: async () => {},
  clear: async () => {},
});
try {
  await run(firstInstaller, ["/S", "/D=" + installDir]);
  assert.equal(
    await readStableProtocol(),
    stableProtocolBefore,
    "Beta installation must not change the stable protocol",
  );
  const serviceRoot = path.join(resources, "local-service");
  // Helper imports live outside the installed tree, so the checker cannot keep
  // runtime files open while NSIS replaces them. These are the inspected bytes.
  const helperRuntime = path.join(
    outputs[0],
    "win-unpacked/resources/local-service",
  );
  service = createManagedLocalService({
    root: serviceRoot,
    dataDir: path.join(profile, "local-service"),
    version: firstVersion,
    ports: { app: 8794, web: 8793 },
    publicHost: "localhost",
    environment,
  });
  assert.equal((await service.start()).status, "online");
  const entry = await service.openWorkspace({
    origin: baseUrl,
    accountId: user.id,
    name: user.name,
    expiresAt: Date.now() + 86400000,
  });
  const ticket = await fetch(entry.url, { redirect: "manual" });
  assert.equal(ticket.status, 303);
  localCookie = ticket.headers.get("set-cookie").split(";")[0];
  localSession = await (
    await fetch(localOrigin + "/api/session", {
      headers: { Cookie: localCookie },
    })
  ).json();
  const models = await localApi("/api/agent/chat/models", {
    action: "add",
    service: "原有验收模型",
    model: "existing-qa-model",
    baseUrl: "https://example.com/v1",
    apiKey: "synthetic-fixture-key",
    apiFormat: "responses",
  });
  model = models.profiles.find((item) => item.model === "existing-qa-model");
  await localApi("/api/agent/chat/models", { action: "default", id: model.id });
  const { RunnerDeviceController } = await import(
    pathToFileURL(path.join(helperRuntime, "runner/dist/index.js"))
  );
  const controller = new RunnerDeviceController({
    stateDir: path.join(profile, "local-service/data/.tmp/runner-device"),
    serverOrigin: "http://127.0.0.1:8793",
    executionEnabled: false,
  });
  await controller.start();
  try {
    const pairing = await localApi("/api/agent/devices/pairings", {});
    await controller.pair({
      ownerId: localSession.user.id,
      pairingCode: pairing.pairingCode,
      deviceName: "本地隔离验收设备",
    });
    const workspaceRoot = path.join(directory, "workspace");
    await fs.mkdir(workspaceRoot);
    await controller.registerWorkspace(localSession.user.id, {
      root: workspaceRoot,
      name: "验收项目",
    });
    for (let n = 0; n < 100; n++) {
      const state = await localApi("/api/agent/devices");
      device = state.devices.find(
        (d) => d.status === "online" && d.workspaces?.length,
      );
      if (device) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(device, "isolated device must register");
    const localRoom = (await localApi("/api/rooms", { name: "本地隔离验收" }))
      .room;
    binding = (
      await localApi("/api/agent/bindings", {
        canvasId: localRoom.id,
        sectionId: "ungrouped",
        runnerId: device.runnerId,
        workspaceId: device.workspaces[0].workspaceId,
        expectedRevision: null,
      })
    ).binding;
    binding.canvasId = localRoom.id;
    scope.bindingId = binding.bindingId;
  } finally {
    await controller.close();
  }
  ownerDir = path.join(
    profile,
    "local-service/data/.tmp/pi-main",
    digest(localSession.user.id).slice(0, 24),
  );
  await fs.mkdir(ownerDir, { recursive: true });
  ({ McpConnections } = await import(
    pathToFileURL(
      path.join(helperRuntime, "scripts/pi-local/mcp-connections.mjs"),
    )
  ));
  ({ TaskStore } = await import(
    pathToFileURL(path.join(helperRuntime, "runner/harness/task-store.mjs"))
  ));
  const mcp = new McpConnections(ownerDir, {
    origin: localOrigin,
    credentialFile,
  });
  try {
    const added = await mcp.add({
      name: "原有 MCP 验收连接",
      url: baseUrl + "/mcp",
      authMode: "auto",
    });
    mcp.setSelection(scope.bindingId, added.id, ["submit_generation"]);
    const turn = mcp.turn(scope);
    try {
      const result = await turn.execute(
        turn.specs[0].name,
        { prompt: "fixture" },
        "original-call",
        AbortSignal.timeout(10000),
      );
      assert.match(JSON.stringify(result), /original-remote-task/);
    } finally {
      await turn.close();
    }
  } finally {
    await mcp.close();
  }
  const tasks = new TaskStore(ownerDir),
    taskScope = { ...scope, accountId: localSession.user.id, memoryEpoch: 0 };
  tasks.claim(taskScope, "fixture");
  const task = tasks.create(taskScope, "fixture", "原任务检查点", {});
  taskId = task.id;
  tasks.putEffect(taskScope, "fixture", task.id, "remote", {
    taskId: "original-remote-task",
    delivery: "received",
  });
  task.status = "interrupted";
  tasks.save(taskScope, "fixture", task, "checkpoint");
  tasks.release(taskScope, "fixture");
  tasks.close();
  await service.pause();
  await service.checkpoint();
  await service.stop();
  await fs.writeFile(
    path.join(directory, "qa-run.json"),
    JSON.stringify({ schema: 1, id, feed: baseUrl + "/updates/" }),
  );
  saveResume(profile, baseUrl + "/app?room=" + room.id);
  const child = spawn(path.join(installDir, "QingdaoBeta.exe"), [], {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
    env: {
      ...environment,
      QINGDAO_UPDATE_QA: "local",
      QINGDAO_LOCAL_QA_ROOT: directory,
      QINGDAO_LOCAL_QA_ID: id,
      QINGDAO_QA_FEED: baseUrl + "/updates/",
      QINGDAN_DESKTOP_PROFILE: profile,
    },
  });
  child.unref();
  const state = {
    directory,
    profile,
    installDir,
    baseUrl,
    firstVersion,
    secondVersion,
    pid: child.pid,
  };
  await fs.writeFile(requestFile, JSON.stringify(state, null, 2));
  console.log(
    JSON.stringify({
      ...state,
      next: "Use the Beta window to add todo/draft, set appearance, and click restart/update once. GET /qa/verify checks the original backend data after automatic restart.",
    }),
  );
} catch (error) {
  await service?.pause().catch(() => {});
  await service?.stop().catch(() => {});
  for (const socket of sockets.clients) socket.terminate();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  throw error;
}
async function verify() {
  assert.equal(
    await readStableProtocol(),
    stableProtocolBefore,
    "Beta update must leave the original stable protocol unchanged",
  );
  assert.ok(
    appLoads.includes(firstVersion) && appLoads.includes(secondVersion),
    "both actual installed web versions must be observed",
  );
  assert.ok(
    sessionReads >= 2,
    "same fixture cookie must authenticate after restart",
  );
  assert.equal(
    commits.size,
    1,
    "original unacknowledged operation must keep its id",
  );
  const version = await (
    await fetch(localOrigin + "/api/local-service/version", {
      headers: { Origin: localOrigin },
    })
  ).json();
  assert.equal(version.version, secondVersion);
  assert.equal((await localApi("/api/session")).user.id, localSession.user.id);
  assert.equal((await localApi("/api/agent/chat/models")).defaultId, model.id);
  const devices = (await localApi("/api/agent/devices")).devices;
  assert.ok(
    devices.some(
      (d) => d.runnerId === device.runnerId && d.status === "online",
    ),
  );
  assert.equal(
    (
      await localApi(
        `/api/agent/bindings?canvasId=${binding.canvasId}&sectionId=ungrouped`,
      )
    ).binding.bindingId,
    binding.bindingId,
  );
  const mcp = new McpConnections(ownerDir, {
    origin: localOrigin,
    credentialFile,
  });
  try {
    await mcp.initialCheck;
    const turn = mcp.turn({ ...scope, retry: true });
    try {
      const result = await turn.execute(
        turn.specs[0].name,
        { prompt: "fixture" },
        "after-update",
        AbortSignal.timeout(10000),
      );
      assert.match(JSON.stringify(result), /original-remote-task/);
    } finally {
      await turn.close();
    }
  } finally {
    await mcp.close();
  }
  assert.equal(generationCalls, 1);
  const tasks = new TaskStore(ownerDir);
  try {
    assert.equal(tasks.get(taskId).status, "interrupted");
    assert.equal(tasks.effect(taskId, "remote").taskId, "original-remote-task");
  } finally {
    tasks.close();
  }
  const report = {
    firstVersion,
    secondVersion,
    appLoads,
    sessionReads,
    pendingOperationIds: [...commits],
    modelRestored: true,
    deviceRestored: true,
    bindingRestored: true,
    mcpRestored: true,
    checkpointRestored: true,
    remoteReceiptRestored: true,
    remoteSubmissions: generationCalls,
    serviceVersion: version.version,
    uiValidation: "Recorded separately through native computer-use",
    signing: "unsigned",
    stableProtocolPreserved: true,
  };
  await fs.writeFile(logFile, JSON.stringify(report, null, 2));
  return report;
}
