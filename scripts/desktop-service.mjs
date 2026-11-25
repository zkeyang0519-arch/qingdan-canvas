import { createRequire } from "node:module";
import path from "node:path";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createExperienceServer } from "./lib/agent-experience-server.mjs";
import { ExperienceService } from "./lib/agent-experience-service.mjs";
import { createLocalRunnerApi } from "./lib/local-runner-api.mjs";
import { createLocalDesktopApi } from "./lib/local-desktop-api.mjs";
import {
  prepareExecutionTrial,
  listExecutionProjects,
} from "./lib/execution-trial.mjs";
import { startConfiguredPi, openMainPi } from "./pi-main/server.mjs";
const nativeHandoffs = new Map();
function requestParentHandoff(descriptor) {
  if (!process.connected) throw Error("轻岛窗口尚未连接，请先打开应用。");
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativeHandoffs.delete(id);
      reject(Error("轻岛窗口未确认交接，请重试。"));
    }, 30000);
    nativeHandoffs.set(id, { resolve, reject, timer });
    process.send({ type: "handoff", id, descriptor }, (error) => {
      if (error && nativeHandoffs.has(id)) {
        clearTimeout(timer);
        nativeHandoffs.delete(id);
        reject(Error("轻岛窗口连接已断开。"));
      }
    });
  });
}

const stableJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  const { atomicJson } = createRequire(import.meta.url)(
    "../desktop/local-service.cjs",
  );
  await atomicJson(file, value);
};
export async function startManagedRuntime({
  root,
  dataDir,
  version,
  send = (value) => process.send?.(value),
}) {
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
    path.join(root, "node_modules/wrangler/package.json"),
  )("miniflare");
  const { RunnerDeviceController } = await import(
    new URL("../runner/dist/index.js", import.meta.url)
  );
  const stateRoot = path.join(dataDir, ".tmp");
  const appPort = Number(process.env.QINGDAN_SERVICE_APP_PORT || 8790),
    webPort = Number(process.env.QINGDAN_SERVICE_WEB_PORT || 8788);
  if (
    ![appPort, webPort].every(
      (port) => Number.isInteger(port) && port > 1024 && port <= 65535,
    ) ||
    appPort === webPort
  )
    throw Error("本地服务端口配置无效。");
  const publicHost = process.env.QINGDAN_SERVICE_PUBLIC_HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost"].includes(publicHost))
    throw Error("本地服务地址无效。");
  const upstream = "http://127.0.0.1:" + webPort,
    origin = "http://" + publicHost + ":" + appPort;
  const controlSecret = randomBytes(32).toString("hex");
  await mkdir(stateRoot, { recursive: true });
  let paused = process.env.QINGDAN_SERVICE_PAUSED === "1",
    closing = false,
    switching,
    pi,
    runtime,
    server,
    stopping;
  const loginTickets = new Map();
  const environment = {
    ...parseEnv(
      await readFile(path.join(dataDir, "service.env"), "utf8").catch(() => ""),
    ),
    ...process.env,
  };
  const controller = new RunnerDeviceController({
    stateDir: path.join(stateRoot, "runner-device"),
    serverOrigin: upstream,
    executionEnabled: true,
  });
  const service = new ExperienceService({
    projectRoot: root,
    stateDir: path.join(stateRoot, "agent-experience"),
  });
  const piOptions = { stateRoot, environment, upstream, origin };
  pi = await startConfiguredPi(root, piOptions);
  function options() {
    const value = convertV4MiniflareOptions({
      name: "qingdan-canvas",
      host: "127.0.0.1",
      port: webPort,
      inspectorPort: 0,
      cf: false,
      modules: true,
      scriptPath: path.join(root, "worker.mjs"),
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      log: new Log(LogLevel.ERROR),
      d1Databases: { DB: "10b38932-94ba-4f29-8b50-9ba2313db9c2" },
      r2Buckets: ["FILES"],
      kvNamespaces: ["OAUTH_KV"],
      durableObjects: {
        ROOMS: { className: "CanvasRoom", useSQLite: true },
        RUNNER_HUBS: { className: "RunnerHub", useSQLite: true },
        AGENT_CHATS: { className: "AgentChatRouter", useSQLite: true },
      },
      bindings: {
        ...Object.fromEntries(
          Object.entries(environment).filter(([key]) =>
            /^(ROUTER_|RESEND_|EMAIL_)/.test(key),
          ),
        ),
        RUNTIME_CONTROL_SECRET: controlSecret,
        APP_ENV: "local",
        MCP_ENABLED: "false",
        RUNNER_ENABLED: "true",
        EXECUTION_ENABLED: "true",
        CHAT_ENABLED: "true",
        PROJECT_SUMMARY_ENABLED: "true",
        BATCH_QUEUE_ENABLED: "true",
        ...(pi
          ? {
              LOCAL_PI_URL: pi.url,
              LOCAL_PI_SECRET: pi.secret,
              LOCAL_PI_OWNER: pi.ownerId,
            }
          : {}),
      },
      serviceBindings: {
        ASSETS: async (request) => {
          const url = new URL(request.url),
            pathname = decodeURIComponent(url.pathname);
          const file =
            /^\/(?:assets|fonts|animals|island|island-releases)\//.test(
              pathname,
            )
              ? path.resolve(root, "web", "." + pathname)
              : path.join(root, "web/index.html");
          if (
            !file.startsWith(path.join(root, "web") + path.sep) ||
            pathname.includes("\\")
          )
            return new Response(null, { status: 404 });
          try {
            const bytes = await readFile(file),
              ext = path.extname(file);
            const type =
              {
                ".js": "text/javascript",
                ".css": "text/css",
                ".html": "text/html; charset=utf-8",
                ".woff2": "font/woff2",
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".webp": "image/webp",
                ".jpg": "image/jpeg",
                ".json": "application/json",
              }[ext] || "application/octet-stream";
            return new Response(bytes, {
              headers: {
                "Content-Type": type,
                "Cache-Control":
                  ext === ".html" ? "no-store" : "public, max-age=3600",
              },
            });
          } catch {
            return new Response(null, { status: 404 });
          }
        },
      },
    });
    return {
      ...value,
      isolatedResourcePersistencePath: path.join(dataDir, "worker-isolated"),
      resourcePersistencePath: path.join(dataDir, "worker"),
      unsafeEnableSharedStorage: true,
      unsafeDevRegistryPath: path.join(dataDir, "registry"),
    };
  }
  const localActivity = () => {
    const native = controller.updateActivity(),
      agent = pi?.updateActivity() || { tasks: [], unknown: [] };
    const experience = [...service.children.keys()].map((id) => ({
      id,
      label: "本机连接验证",
      status: "running",
    }));
    return {
      tasks: [...native.tasks, ...agent.tasks, ...experience],
      unknown: [...native.unknown, ...agent.unknown],
      paused,
    };
  };
  async function workerControl(action) {
    const response = await runtime.dispatchFetch(
      upstream + "/api/internal/runtime",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + controlSecret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      },
    );
    const value = await response.json();
    if (!response.ok) throw Error(value.error || "后台维护状态未确认。");
    return value;
  }
  async function activity() {
    const local = localActivity();
    try {
      const backend = await workerControl("activity");
      return {
        ...local,
        tasks: [
          ...new Map(
            [...local.tasks, ...backend.tasks].map((task) => [task.id, task]),
          ).values(),
        ],
        unknown: [...local.unknown, ...backend.unknown],
      };
    } catch {
      return { ...local, unknown: [...local.unknown, "无法核实后台任务状态"] };
    }
  }
  async function configure(accountId) {
    if (closing || paused || pi?.ownerId === accountId)
      return { configured: pi?.ownerId === accountId };
    if (switching) return switching;
    switching = (async () => {
      const currentActivity = await activity();
      if (currentActivity.tasks.length || currentActivity.unknown.length)
        throw Error("还有运行中的任务，暂不切换本地账号。");
      const db = await runtime.getD1Database("DB");
      const account = await db
        .prepare(
          "SELECT account_id FROM account_sessions WHERE account_id=? AND expires_at>? LIMIT 1",
        )
        .bind(accountId, Date.now())
        .first();
      if (!account) return { configured: false };
      await pi?.close();
      const profile = { ownerId: accountId, mappings: [] };
      pi = await openMainPi({ root, profile, ...piOptions });
      await stableJson(path.join(stateRoot, "pi-main/profile.json"), profile);
      await runtime.setOptions(options());
      return { configured: true };
    })().finally(() => {
      switching = null;
    });
    return switching;
  }
  async function openWorkspace(identity) {
    if (closing || paused) throw Error("本地服务正在维护，请稍后打开工作区。");
    if (
      !identity ||
      typeof identity.accountId !== "string" ||
      identity.accountId.length > 128 ||
      typeof identity.origin !== "string" ||
      !Number.isSafeInteger(identity.expiresAt) ||
      identity.expiresAt <= Date.now()
    )
      throw Error("轻岛登录状态尚未核验。");
    const authority = new URL(identity.origin);
    if (
      authority.origin !== identity.origin ||
      !["https:", "http:"].includes(authority.protocol) ||
      (authority.protocol === "http:" &&
        !["127.0.0.1", "localhost", "[::1]"].includes(authority.hostname))
    )
      throw Error("登录来源无效。");
    const db = await runtime.getD1Database("DB");
    let accountId;
    if (identity.origin === origin) {
      const existing = await db
        .prepare("SELECT id FROM accounts WHERE id=?")
        .bind(identity.accountId)
        .first();
      if (!existing) throw Error("找不到当前本机账号。");
      accountId = existing.id;
    } else {
      const existing = await db
        .prepare(
          "SELECT local_id FROM native_account_links WHERE authority=? AND external_id=?",
        )
        .bind(identity.origin, identity.accountId)
        .first();
      accountId = existing?.local_id || randomUUID();
      if (!existing)
        await db.batch([
          db
            .prepare(
              "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES(?,?,?,?,?)",
            )
            .bind(
              accountId,
              "native_" + accountId.replaceAll("-", "").slice(0, 20),
              String(identity.name || "本机用户").slice(0, 80),
              "disabled",
              new Date().toISOString(),
            ),
          db
            .prepare(
              "INSERT INTO native_account_links(authority,external_id,local_id) VALUES(?,?,?)",
            )
            .bind(identity.origin, identity.accountId, accountId),
        ]);
    }
    const sessionToken = randomBytes(32).toString("hex"),
      hash = createHash("sha256").update(sessionToken).digest("hex");
    const expiresAt = Math.min(identity.expiresAt, Date.now() + 30 * 86400000);
    await db
      .prepare(
        "INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES(?,?,?)",
      )
      .bind(hash, accountId, expiresAt)
      .run();
    for (const [key, value] of loginTickets)
      if (value.deadline <= Date.now()) loginTickets.delete(key);
    const ticket = randomBytes(32).toString("hex");
    loginTickets.set(ticket, {
      sessionToken,
      expiresAt,
      deadline: Date.now() + 30000,
    });
    return { url: origin + "/local/desktop-signin?ticket=" + ticket };
  }
  async function localEntry(req, res, url) {
    if (req.method !== "GET") {
      res.writeHead(405);
      return res.end();
    }
    const ticket = url.searchParams.get("ticket"),
      login = loginTickets.get(ticket);
    if (!login || login.deadline <= Date.now()) {
      res.writeHead(401, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end("登录入口已过期，请从轻岛设置重新打开本地工作区。");
    }
    loginTickets.delete(ticket);
    res.writeHead(303, {
      Location: "/app",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie":
        "qd_session=" +
        login.sessionToken +
        "; Path=/; HttpOnly; SameSite=Lax; Expires=" +
        new Date(login.expiresAt).toUTCString(),
    });
    res.end();
  }
  async function pause() {
    paused = true;
    pi?.pauseAdmissions();
    await controller.pauseAdmissions();
    await workerControl("pause");
    return { paused: true };
  }
  async function resume() {
    if (closing)
      throw Error(
        "本地服务仍在退出，不能重新派发任务。请等待退出确认后恢复连接。",
      );
    await workerControl("resume");
    paused = false;
    controller.resumeAdmissions();
    pi?.resumeAdmissions();
    return { resumed: true };
  }
  async function checkpoint() {
    if (!paused) throw Error("尚未暂停接收新任务。");
    const current = await activity();
    if (current.tasks.length || current.unknown.length || switching)
      throw Error("还有运行中或结果待核对的任务，检查点保存未就绪。");
    service.save();
    await workerControl("checkpoint");
    await stableJson(path.join(dataDir, "checkpoint.json"), {
      version,
      protocol: 1,
      at: new Date().toISOString(),
      remoteReceipts: "preserved-in-journals",
    });
    return { ok: true };
  }
  async function stop() {
    if (stopping) return stopping;
    await checkpoint();
    closing = true;
    stopping = (async () => {
      await pi?.close();
      await controller.close();
      await service.close();
      server?.closeConnections();
      if (server) await new Promise((resolve) => server.close(resolve));
      await runtime?.dispose();
      return { stopped: true };
    })();
    return stopping;
  }
  try {
    runtime = new Miniflare(options());
    const db = await runtime.getD1Database("DB");
    await db
      .prepare(
        "CREATE TABLE IF NOT EXISTS qingdao_runtime_migrations(name TEXT PRIMARY KEY)",
      )
      .run();
    for (const name of (await readdir(path.join(root, "migrations")))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      if (
        await db
          .prepare("SELECT name FROM qingdao_runtime_migrations WHERE name=?")
          .bind(name)
          .first()
      )
        continue;
      const sql = await readFile(path.join(root, "migrations", name), "utf8");
      await db.batch([
        ...sql
          .replace(/^--.*$/gm, "")
          .split(";")
          .filter((s) => s.trim())
          .map((s) => db.prepare(s)),
        db
          .prepare("INSERT INTO qingdao_runtime_migrations VALUES(?)")
          .bind(name),
      ]);
    }
    await db
      .prepare(
        "CREATE TABLE IF NOT EXISTS runtime_maintenance(id INTEGER PRIMARY KEY,paused INTEGER NOT NULL)",
      )
      .run();
    await db
      .prepare(
        "CREATE TABLE IF NOT EXISTS native_account_links(authority TEXT NOT NULL,external_id TEXT NOT NULL,local_id TEXT NOT NULL REFERENCES accounts(id),PRIMARY KEY(authority,external_id))",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO runtime_maintenance VALUES(1,?) ON CONFLICT(id) DO UPDATE SET paused=excluded.paused",
      )
      .bind(paused ? 1 : 0)
      .run();
    await controller.start();
    if (paused) await pause();
    server = createExperienceServer({
      service,
      upstream,
      publicHost,
      localEntry,
      admissionsPaused: () => paused,
      runtimeVersion: { managed: true, protocol: 1, version },
      desktopApi: createLocalDesktopApi({
        upstream,
        launch: async (context) => {
          const { createDesktopHandoff } = createRequire(import.meta.url)(
            "../desktop/handoff-broker.cjs",
          );
          const broker = await createDesktopHandoff(context);
          try {
            const [receipt] = await Promise.all([
              broker.result,
              requestParentHandoff(broker.descriptor),
            ]);
            if (!receipt.applied)
              throw Error(receipt.error || "轻岛窗口未应用这次交接。");
            return { started: true, applied: true };
          } finally {
            await broker.close();
          }
        },
      }),
      runnerApi: createLocalRunnerApi({
        getController: () => controller,
        upstream,
        onAuthenticated: configure,
        getDiagnostics: async () => ({ version, protocol: 1, managed: true }),
        prepareTrial: (input) =>
          prepareExecutionTrial({ ...input, projectRoot: root }),
        listTrials: ({ ownerId, state }) =>
          listExecutionProjects({
            projectRoot: root,
            ownerId,
            workspaces: state.workspaces,
          }),
      }),
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(appPort, "127.0.0.1", resolve);
    });
    send({ type: "ready", protocol: 1, version });
    return {
      activity,
      pause,
      resume,
      checkpoint,
      stop,
      configure,
      openWorkspace,
    };
  } catch (error) {
    await pi?.close().catch(() => {});
    await controller.close().catch(() => {});
    await service.close().catch(() => {});
    await runtime?.dispose().catch(() => {});
    throw error;
  }
}

if (process.env.QINGDAN_SERVICE_DATA && process.send) {
  const ready = startManagedRuntime({
    root: process.env.QINGDAN_SERVICE_ROOT,
    dataDir: process.env.QINGDAN_SERVICE_DATA,
    version: process.env.QINGDAN_SERVICE_VERSION,
  });
  process.on("message", async (message) => {
    if (message?.type === "handoff-result" && nativeHandoffs.has(message.id)) {
      const pending = nativeHandoffs.get(message.id);
      nativeHandoffs.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Error(message.error));
      else pending.resolve();
      return;
    }
    if (
      !message ||
      typeof message.id !== "string" ||
      ![
        "activity",
        "pause",
        "resume",
        "checkpoint",
        "stop",
        "context",
        "open-workspace",
      ].includes(message.action)
    )
      return;
    try {
      const runtime = await ready;
      const result =
        message.action === "context"
          ? await runtime.configure(message.input?.accountId)
          : message.action === "open-workspace"
            ? await runtime.openWorkspace(message.input)
            : await runtime[message.action]();
      process.send({ id: message.id, result }, () => {
        if (message.action === "stop") process.exit(0);
      });
    } catch (error) {
      process.send?.({
        id: message.id,
        error: /[\u3400-\u9fff]/.test(error.message)
          ? error.message.slice(0, 400)
          : "本地服务操作未完成，请重试或修复。",
      });
    }
  });
  // A lost UI process is not permission to interrupt active commands. Leave the
  // service running until active work settles, then close its own processes.
  process.once("disconnect", () => {
    void ready
      .then(async (runtime) => {
        await runtime.pause();
        let reading = false;
        const timer = setInterval(async () => {
          if (reading) return;
          reading = true;
          try {
            const current = await runtime.activity();
            if (!current.tasks.length && !current.unknown.length) {
              clearInterval(timer);
              await runtime.stop();
              process.exit(0);
            }
          } finally {
            reading = false;
          }
        }, 1000);
      })
      .catch(() => process.exit(1));
  });
  ready.catch((error) => {
    process.send?.(
      {
        type: "startup-error",
        error: /[\u3400-\u9fff]/.test(error.message)
          ? error.message.slice(0, 400)
          : "本地服务启动失败，数据已保留。",
      },
      () => process.exit(1),
    );
  });
}
