import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { openModelSettings } from "./model-settings.mjs";
import { ModelCatalog } from "./model-catalog.mjs";
import { openPiChat } from "./rpc-chat.mjs";
import { McpConnections } from "./mcp-connections.mjs";
import { codexMcpId, localCodexMcp } from "./codex-mcp.mjs";
import { waaoMcpId } from "../../shared/agent/waao-endpoint.mjs";
import {
  createLocalProject,
  hasLocalBinding,
  localProjects,
} from "./projects.mjs";
import { ConnectorMaintenance } from "./connector-maintenance.mjs";
import { createMaintenanceProposer } from "./maintenance-pi.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = path.join(root, "scripts", "pi-local");
const sample = process.argv.includes("--sample-assets");
let dir, port, origin;
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  path.join(root, "node_modules/wrangler/package.json"),
)("miniflare");
const session = randomBytes(32).toString("hex");
const ticket = randomBytes(32).toString("hex");
const sessionHash = createHash("sha256").update(session).digest("hex");
const accountId = "pi-local";
const cookie = "qd_session=" + session;
let runtime,
  tools,
  webLogin,
  waao,
  modelSettings,
  catalog,
  piChat,
  mcp,
  maintenance,
  ready = false;

async function initDb() {
  const db = await runtime.getD1Database("DB");
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS pi_local_migrations(filename TEXT PRIMARY KEY)",
    )
    .run();
  for (const name of (await readdir(path.join(root, "migrations")))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (
      await db
        .prepare("SELECT filename FROM pi_local_migrations WHERE filename=?")
        .bind(name)
        .first()
    )
      continue;
    const sql = await readFile(path.join(root, "migrations", name), "utf8");
    const statements = sql
      .replace(/^--.*$/gm, "")
      .split(";")
      .filter((s) => s.trim())
      .map((s) => db.prepare(s));
    await db.batch([
      ...statements,
      db.prepare("INSERT INTO pi_local_migrations VALUES(?)").bind(name),
    ]);
  }
  const workspace = [
    {
      workspaceId: "pi-preview",
      name: "本机验证",
      displayPath: "本机试用项目",
      revision: 1,
      checks: [],
    },
  ];
  await db.batch([
    db.prepare(
      "INSERT OR IGNORE INTO accounts(id,username,name,password_hash,created_at) VALUES('pi-local','pi-local','本机试用','disabled','2026')",
    ),
    db
      .prepare(
        "DELETE FROM account_sessions WHERE account_id=? AND expires_at<=?",
      )
      .bind(accountId, Date.now()),
    db
      .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
      .bind(sessionHash, accountId, Date.now() + 24 * 3600000),
    db.prepare(
      "INSERT OR IGNORE INTO rooms VALUES('pi-local-room','本机试用','pi-local','local-invite','2026')",
    ),
    db.prepare(
      "INSERT OR IGNORE INTO members VALUES('pi-local-room','pi-local','owner','2026')",
    ),
    db
      .prepare(
        "INSERT OR IGNORE INTO agent_devices(runner_id,owner_id,device_name,secret_hash,workspaces_json) VALUES('pi-local-runner','pi-local','本机试用','disabled',?)",
      )
      .bind(JSON.stringify(workspace)),
    db.prepare(
      "INSERT OR IGNORE INTO agent_bindings VALUES('pi-local-binding','pi-local','pi-local-room','pi-preview','pi-local-runner','pi-preview',1,1)",
    ),
  ]);
}

function reply(res, status, data, mime = "application/json") {
  res.setHeader("Content-Type", mime);
  res.writeHead(status);
  res.end(mime === "application/json" ? JSON.stringify(data) : data);
}
function harnessScope(data) {
  return {
    accountId,
    bindingId: data.thread?.bindingId,
    chatId: data.thread?.id,
    memoryEpoch: data.memoryEpoch,
    authorizedMessages: data.harnessMessageIds,
    visible: (data.messages || [])
      .filter((message) => !message.invalidated)
      .flatMap((message) =>
        message.role === "user"
          ? [message.id]
          : message.replyTo
            ? [message.replyTo]
            : [],
      ),
  };
}
async function readHarnessChat(bindingId, chatId) {
  const response = await runtime.dispatchFetch(
    "https://pi-local.test/api/agent/chat/state?" +
      new URLSearchParams({ bindingId, chatId }),
    {
      headers: {
        Origin: "https://pi-local.test",
        Cookie: cookie,
        "X-QD-Account": accountId,
      },
    },
  );
  if (!response.ok) throw Error("任务所在对话已不可访问。");
  return response.json();
}
async function handle(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  if (
    req.headers.host !== "127.0.0.1:" + port ||
    (req.method !== "GET" && req.headers.origin !== origin)
  )
    return reply(res, 403, { error: "请从本机试用页面发起操作。" });
  const url = new URL(req.url, origin);
  const pathname = url.pathname;
  if (!ready) return reply(res, 503, { error: "本机服务正在启动。" });
  if (pathname === "/" && req.method === "GET")
    return reply(
      res,
      200,
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>轻单 · 本机 Pi 试用</title><link rel="stylesheet" href="/app.css"><body><main id="root" class="app-shell cloud-canvas agent-mode"></main><script src="/app.js"></script></body></html>',
      "text/html; charset=utf-8",
    );
  const files = { "/app.js": "text/javascript", "/app.css": "text/css" };
  if (files[pathname] && req.method === "GET")
    return reply(
      res,
      200,
      await readFile(path.join(dir, pathname.slice(1))),
      files[pathname],
    );
  if (
    /^\/fonts\/[\w-]+\/[\w.-]+\.woff2$/.test(pathname) &&
    req.method === "GET"
  )
    return reply(
      res,
      200,
      await readFile(path.join(root, "public", pathname.slice(1))),
      "font/woff2",
    );
  let body;
  if (req.method !== "GET") {
    if (
      req.method !== "POST" ||
      !req.headers["content-type"]?.startsWith("application/json")
    )
      return reply(res, 415, {});
    const parts = [];
    let length = 0;
    for await (const part of req) {
      length += part.length;
      if (length > 160000) return reply(res, 413, {});
      parts.push(part);
    }
    try {
      body = JSON.parse(Buffer.concat(parts).toString());
    } catch {
      return reply(res, 400, {});
    }
  }
  if (
    pathname === "/local/session" &&
    req.method === "POST" &&
    body?.ticket === ticket
  ) {
    res.setHeader("Set-Cookie", cookie + "; HttpOnly; SameSite=Strict; Path=/");
    return reply(res, 200, { ok: true });
  }
  if (pathname === "/local/waao/callback" && req.method === "GET") {
    try {
      await mcp.finish(waaoMcpId, url.searchParams);
    } catch {
      return reply(
        res,
        400,
        "WAAO 网页授权未完成。请回到轻单的「工具」，点击「连接 WAAO」重试。",
        "text/plain; charset=utf-8",
      );
    }
    res.setHeader("Set-Cookie", cookie + "; HttpOnly; SameSite=Strict; Path=/");
    res.writeHead(303, { Location: "/#mcp=waao" });
    return res.end();
  }
  const callback = pathname.match(/^\/local\/mcp\/callback\/([a-f0-9-]{36})$/);
  if (callback && req.method === "GET") {
    try {
      await mcp.finish(callback[1], url.searchParams);
    } catch {
      return reply(
        res,
        400,
        "授权未完成，请回到轻单的「工具」重新连接。",
        "text/plain; charset=utf-8",
      );
    }
    res.writeHead(303, { Location: "/" });
    return res.end();
  }
  const presented = (req.headers.cookie || "")
    .split(/;\s*/)
    .find((part) => /^qd_session=[a-f0-9]{64}$/.test(part));
  if (!presented)
    return reply(res, 401, {
      error: "请打开本机生成的「打开轻单.html」进入测试账号。",
    });
  if (presented !== cookie) {
    const db = await runtime.getD1Database("DB");
    const allowed = await db
      .prepare(
        "SELECT 1 FROM account_sessions WHERE token_hash=? AND account_id=? AND expires_at>?",
      )
      .bind(
        createHash("sha256")
          .update(presented.slice("qd_session=".length))
          .digest("hex"),
        accountId,
        Date.now(),
      )
      .first();
    if (!allowed)
      return reply(res, 401, { error: "请重新打开本机的「打开轻单.html」。" });
  }
  if (pathname === "/local/models" || pathname === "/api/agent/chat/models") {
    try {
      let added;
      if (req.method === "POST") {
        if (body?.action === "add") added = await catalog.add(body);
        else if (body?.action === "default") catalog.setDefault(body.id);
        else return reply(res, 400, { error: "未知的模型设置操作。" });
      }
      return reply(res, 200, {
        ...(await catalog.list()),
        ...(added ? { added } : {}),
      });
    } catch (error) {
      return reply(res, 400, {
        error: /[\u3400-\u9fff]/.test(error.message)
          ? error.message
          : "模型连接保存失败，请检查地址和本机凭据存储。",
      });
    }
  }
  if (pathname === "/local/status")
    return reply(res, 200, {
      sample,
      ...(await catalog.status()),
      waao: waao.statusOfConnection(),
      projects: await localProjects(await runtime.getD1Database("DB"), sample),
    });
  if (pathname === "/local/projects" && req.method === "POST") {
    try {
      return reply(
        res,
        200,
        await createLocalProject(await runtime.getD1Database("DB"), body),
      );
    } catch {
      return reply(res, 400, { error: "本机项目创建失败，请检查名称并重试。" });
    }
  }
  if (pathname === "/local/connector-questions") {
    const binding = url.searchParams.get("bindingId");
    if (!(await hasLocalBinding(await runtime.getD1Database("DB"), binding)))
      return reply(res, 403, { error: "请先选择当前项目。" });
    try {
      const value =
        req.method === "POST"
          ? await mcp.answerQuestion(binding, body)
          : url.searchParams.has("requestId")
            ? mcp.questionReceipt(binding, url.searchParams.get("requestId"))
            : { questions: mcp.questions(binding) };
      return reply(res, 200, value);
    } catch (error) {
      return reply(res, 400, {
        error: /[\u3400-\u9fff]/.test(error.message)
          ? error.message
          : "暂时无法处理这次回答。",
      });
    }
  }
  if (pathname === "/local/task/stop" && req.method === "POST") {
    if (
      !body ||
      typeof body.bindingId !== "string" ||
      typeof body.chatId !== "string" ||
      typeof body.taskId !== "string"
    )
      return reply(res, 400, { error: "无效的任务停止请求。" });
    try {
      const data = await readHarnessChat(body.bindingId, body.chatId);
      const scope = harnessScope(data);
      await piChat.stopTask(scope, body.taskId);
      return reply(res, 200, { task: piChat.task(scope) });
    } catch (error) {
      return reply(res, 409, { error: error.message });
    }
  }
  if (pathname === "/local/mcp") {
    const binding = url.searchParams.get("bindingId");
    if (!(await hasLocalBinding(await runtime.getD1Database("DB"), binding)))
      return reply(res, 403, { error: "请先选择当前账号的本机项目。" });
    try {
      if (req.method === "GET") {
        const pending =
          url.searchParams.get("waitForService") ||
          (url.searchParams.get("waitForCodex") === "1" ? codexMcpId : null);
        if (pending) await mcp.checks.get(pending);
      }
      const result =
        req.method === "POST" ? await mcp.action(binding, body) : {};
      return reply(res, 200, { ...result, servers: mcp.list(binding) });
    } catch (error) {
      const message = /[\u3400-\u9fff]/.test(error.message)
        ? error.message
        : "MCP 连接操作失败，请重试。";
      return reply(res, 400, { error: message });
    }
  }
  if (pathname === "/local/waao/capabilities" && req.method === "GET") {
    await mcp.checks.get(waaoMcpId);
    if (!waao.statusOfConnection().connected)
      return reply(res, 401, { error: "请先连接 WAAO。" });
    try {
      return reply(
        res,
        200,
        await waao.capabilities(AbortSignal.timeout(30000)),
      );
    } catch {
      return reply(res, 502, { error: "暂时无法读取 WAAO 的授权工具。" });
    }
  }
  if (pathname === "/local/waao/connect" && req.method === "POST") {
    try {
      const result = await mcp.action(null, { id: waaoMcpId, action: "login" });
      return reply(res, 200, {
        ...result,
        connected: result.status === "ready",
      });
    } catch {
      return reply(res, 502, {
        error: "暂时无法打开 WAAO 官方授权，请检查网络后重试。",
      });
    }
  }
  const task = pathname.match(/^\/local\/waao\/tasks\/([\w-]{1,160})$/);
  if (task && req.method === "GET") {
    try {
      const value = await tools.taskStatus(
        task[1],
        url.searchParams.get("chat"),
        AbortSignal.timeout(30000),
      );
      return value
        ? reply(res, 200, { status: value.status, playable: !!value.playable })
        : reply(res, 404, {});
    } catch {
      return reply(res, 502, { error: "暂时无法读取 WAAO 任务进度。" });
    }
  }
  const media = pathname.match(/^\/api\/agent\/chat\/media\/([a-f0-9-]{36})$/);
  if (media && req.method === "GET") {
    const image = await tools.image(media[1]);
    return image
      ? reply(res, 200, image.bytes, image.mime)
      : reply(res, 404, {});
  }
  const video = pathname.match(/^\/api\/agent\/chat\/video\/([\w-]{1,160})$/);
  if (video && req.method === "GET") {
    const location = await tools.video(video[1], AbortSignal.timeout(30000));
    if (!location) return reply(res, 404, {});
    res.writeHead(307, { Location: location });
    return res.end();
  }
  if (pathname === "/api/agent/execution/checklist" && body?.action === "list")
    return reply(res, 200, {
      canvasId: "pi-local-room",
      sectionId: body.sectionId || "pi-preview",
      tasks: [],
      runs: [],
    });
  if (pathname === "/api/agent/execution/intents" && req.method === "GET")
    return reply(res, 200, { intents: [] });
  if (pathname === "/api/agent/execution/runs" && req.method === "GET")
    return reply(res, 200, { runs: [] });
  if (
    pathname === "/api/agent/execution/tools" &&
    body?.name === "codex_list_runs"
  )
    return reply(res, 200, { result: { runs: [] } });
  const chatRead =
    /^\/api\/agent\/chat\/(state|request)$/.test(pathname) &&
    req.method === "GET";
  const chatWrite =
    /^\/api\/agent\/chat\/(send|new|cancel|select-model)$/.test(pathname) &&
    req.method === "POST";
  const projectRead =
    [
      "/api/agent/bindings",
      "/api/agent/devices",
      "/api/agent/films",
      "/api/agent/films/capabilities",
    ].includes(pathname) && req.method === "GET";
  if (!(chatRead || chatWrite || projectRead))
    return reply(res, 404, { error: "此入口不属于本机对话试用范围。" });
  if (
    chatWrite &&
    ["send", "new", "select-model"].includes(pathname.split("/").at(-1))
  ) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return reply(res, 400, { error: "无效的聊天请求。" });
    if (!pathname.endsWith("select-model"))
      body.defaultProfileId = catalog.defaultId;
    if (body.modelProfileId || (pathname.endsWith("/send") && !body.chatId)) {
      const { profiles } = await catalog.list();
      const selected = profiles.find(
        (p) => p.id === (body.modelProfileId ?? catalog.defaultId),
      );
      if (!selected)
        return reply(res, 400, { error: "找不到所选模型连接，请重新选择。" });
      if (!selected.configured)
        return reply(res, 503, { error: modelSettings.setupHint });
    }
  }
  const worker = await runtime.dispatchFetch(
    "https://pi-local.test" + pathname + url.search,
    {
      method: req.method,
      headers: {
        Origin: "https://pi-local.test",
        Cookie: cookie,
        "X-QD-Account": accountId,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const data = await worker.json();
  if (
    pathname === "/api/agent/chat/cancel" &&
    worker.ok &&
    data.job?.status === "cancelled"
  )
    piChat.cancel(data.job.id);
  if (data.provider)
    data.provider = await catalog.status(
      data.thread ? (data.thread.modelProfileId ?? "xingchi") : undefined,
    );
  if (data.job?.status === "failed")
    data.job.diagnostic = catalog.diagnostic(data.job.id);
  if (Array.isArray(data.messages)) {
    const profiles = new Map(data.provider.profiles.map((p) => [p.id, p]));
    data.messages = data.messages.map((message) => {
      const used = profiles.get(message.modelProfileId);
      if (used) message.modelLabel = used.model + " · " + used.service;
      if (message.previousAttempt)
        message.previousAttempt.diagnostic = catalog.diagnostic(
          message.previousAttempt.id,
        );
      return mcp.decorate(tools.decorate(message));
    });
    data.mcpAvailable = true;
    const bindingId =
      data.thread?.bindingId || url.searchParams.get("bindingId");
    if (bindingId) data.connectorQuestions = mcp.questions(bindingId);
    if (bindingId && data.thread?.id) {
      data.harnessTask = piChat.task(harnessScope(data));
      delete data.harnessMessageIds;
    }
    data.waaoConnection = waao.statusOfConnection();
  }
  return reply(res, worker.status, data);
}

const server = createServer((req, res) =>
  handle(req, res).catch(() =>
    reply(res, 500, { error: "本机服务处理失败。" }),
  ),
);
export async function stop() {
  ready = false;
  await piChat?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await runtime?.dispose();
  maintenance?.cancel();
  await mcp?.close();
  await maintenance?.close();
  catalog?.close();
  tools?.close();
}
export async function start({
  directory,
  listenPort,
  settings,
  modelCredentialFile,
  environment,
  connectorServices,
} = {}) {
  dir =
    directory ??
    path.join(root, ".tmp", "pi-local", sample ? "sample" : "live");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort ?? (sample ? 8798 : 8797), "127.0.0.1", resolve);
  });
  port = server.address().port;
  origin = "http://127.0.0.1:" + port;
  const vars = environment ?? {
    ...parseEnv(
      await readFile(path.join(root, ".dev.vars"), "utf8").catch(() => ""),
    ),
    ...process.env,
  };
  modelSettings =
    settings ?? (await openModelSettings(path.join(root, ".dev.vars.pi")));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const baseBuild = { bundle: true, logLevel: "silent", absWorkingDir: root };
  await Promise.all([
    build({
      ...baseBuild,
      entryPoints: [path.join(source, "ui.jsx")],
      outfile: path.join(dir, "app.js"),
      external: ["/fonts/*"],
      loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"' },
    }),
    build({
      ...baseBuild,
      entryPoints: [path.join(source, "worker.mjs")],
      outfile: path.join(dir, "worker.mjs"),
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "browser", "import"],
      external: ["node:*", "cloudflare:*"],
    }),
    build({
      ...baseBuild,
      entryPoints: [path.join(source, "tools.mjs")],
      outfile: path.join(dir, "tools.mjs"),
      format: "esm",
      platform: "node",
      packages: "external",
    }),
    build({
      ...baseBuild,
      entryPoints: [path.join(source, "codex-mcp-server.mjs")],
      outfile: path.join(dir, "codex-mcp-server.mjs"),
      format: "esm",
      platform: "node",
      packages: "external",
    }),
  ]);
  let stylesDir = path.join(root, "dist", "assets");
  const findStyles = async () =>
    (await readdir(stylesDir).catch(() => [])).find((name) =>
      /^index-.*\.css$/.test(name),
    );
  let styles = await findStyles();
  if (!styles) {
    const { build: buildWeb } = await import("vite");
    const outDir = path.join(dir, "web");
    await buildWeb({ root, build: { outDir }, logLevel: "error" });
    stylesDir = path.join(outDir, "assets");
    styles = await findStyles();
  }
  const cssFile = path.join(dir, "app.css");
  const agentStyles = (await readdir(stylesDir))
    .filter((name) => /^(index|AgentWorkspace)-.*\.css$/.test(name))
    .sort(
      (a, b) => Number(b.startsWith("index-")) - Number(a.startsWith("index-")),
    );
  const compiledStyles = await Promise.all(
    agentStyles.map((name) => readFile(path.join(stylesDir, name), "utf8")),
  );
  await writeFile(
    cssFile,
    compiledStyles.join("\n") +
      "\n" +
      (await readFile(path.join(source, "preview.css"), "utf8")),
  );
  await copyFile(
    path.join(root, "runner", "credential-helper.ps1"),
    path.join(dir, "credential-helper.ps1"),
  );
  const toolModule = await import(pathToFileURL(path.join(dir, "tools.mjs")));
  catalog = new ModelCatalog(
    dir,
    modelSettings,
    modelCredentialFile ??
      ((id, url) => toolModule.mcpCredentialFile(dir, id, url, "model")),
  );
  webLogin = await toolModule.waaoLogin(
    dir,
    origin,
    vars.QINGDAN_WAAO_MCP_TOKEN,
  );
  maintenance = new ConnectorMaintenance(dir, {
    propose: createMaintenanceProposer(dir, catalog),
  });
  const nativeOptions = {
    command: vars.QINGDAN_CODEX_BIN,
    env: process.env,
    maintenance,
  };
  waao = toolModule.webWaao(
    webLogin,
    vars,
    fetch,
    toolModule.codexWaaoMcp(dir, nativeOptions),
  );
  tools = toolModule.openTools(dir, sample, waao);
  mcp = new McpConnections(dir, {
    origin,
    credentialFile: (id, url) => toolModule.mcpCredentialFile(dir, id, url),
    codexService: connectorServices?.codex ?? localCodexMcp(dir, nativeOptions),
    waaoService: connectorServices?.waao ?? waao,
  });
  piChat = await openPiChat({
    directory: dir,
    settings: modelSettings,
    catalog,
    tools,
    sample,
    mcp,
    taskHarness: true,
    authorizeTask: async (envelope) => {
      const data = await readHarnessChat(
        envelope.scope.bindingId,
        envelope.scope.chatId,
      );
      const current = harnessScope(data);
      return (
        current.memoryEpoch === envelope.scope.memoryEpoch &&
        [...envelope.scope.visible, envelope.scope.userMessageId].every((id) =>
          (current.authorizedMessages || current.visible).includes(id),
        )
      );
    },
    isBinding: async (id) =>
      hasLocalBinding(await runtime.getD1Database("DB"), id),
  });
  const options = convertV4MiniflareOptions({
    name: "pi-local",
    port: 0,
    inspectorPort: 0,
    cf: false,
    modules: true,
    scriptPath: path.join(dir, "worker.mjs"),
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    log: new Log(LogLevel.ERROR),
    d1Databases: ["DB"],
    durableObjects: {
      AGENT_CHATS: { className: "Chat", useSQLite: true },
      RUNNER_HUBS: { className: "Project", useSQLite: true },
    },
    bindings: {
      APP_ENV: "test",
      CHAT_ENABLED: "true",
      RUNNER_ENABLED: "true",
      PROJECT_SUMMARY_ENABLED: "true",
      EXECUTION_ENABLED: "true",
      ROUTER_BASE_URL: modelSettings.baseUrl,
      ROUTER_API_FORMAT: "responses",
      ROUTER_MODEL: modelSettings.model,
      ROUTER_API_KEY: "local-pi-rpc",
    },
    serviceBindings: { PI_CHAT: (request) => piChat.fetch(request) },
    outboundService: () => new Response(null, { status: 403 }),
  });
  Object.assign(options, {
    isolatedResourcePersistencePath: path.join(dir, "isolated"),
    resourcePersistencePath: path.join(dir, "state"),
    unsafeEnableSharedStorage: true,
    unsafeDevRegistryPath: path.join(dir, "registry"),
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    runtime = new Miniflare(options);
    try {
      await initDb();
      break;
    } catch (error) {
      if (
        attempt === 3 ||
        !String(error.message).includes("Network connection lost")
      )
        throw error;
      await runtime.dispose();
      await delay(900 * attempt);
    }
  }
  const launcher = path.join(dir, "打开轻单.html");
  await writeFile(
    launcher,
    '<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>轻单本机试用</title><a id="open">打开本机轻单</a><script>const url=' +
      JSON.stringify(origin + "/#ticket=" + ticket) +
      ';document.getElementById("open").href=url;location.replace(url)</script>',
    { mode: 0o600 },
  );
  ready = true;
  console.log(
    "本机 Pi RPC 1.5.2 已启动",
    origin,
    modelSettings.model,
    sample ? "样例色卡" : "真实 Codex",
    "WAAO 网页 MCP",
  );
  console.log("打开", launcher);
  return { origin, launcher };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await start();
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  } catch (error) {
    console.error(error.message);
    await stop();
    process.exitCode = 1;
  }
}
