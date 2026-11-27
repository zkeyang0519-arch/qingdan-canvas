import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { build } from "esbuild";
import { openPiChat } from "../pi-local/rpc-chat.mjs";
import { McpConnections } from "../pi-local/mcp-connections.mjs";
import { localCodexMcp } from "../pi-local/codex-mcp.mjs";
import { ConnectorMaintenance } from "../pi-local/connector-maintenance.mjs";
import { createMaintenanceProposer } from "../pi-local/maintenance-pi.mjs";
import { inheritMcpConfiguration } from "./migrate-mcp.mjs";
import { digest } from "../../runner/harness/task-store.mjs";

const validId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const fail = (message, status = 400) =>
  Object.assign(Error(message), { status });

export function waaoAuthDirectory(directory, origin) {
  return path.join(
    directory,
    "waao-auth",
    digest(new URL(origin).origin).slice(0, 24),
  );
}

export async function openMainPi({
  root,
  profile,
  upstream = "http://127.0.0.1:8788",
  origin = "http://127.0.0.1:8790",
  secret = randomBytes(32).toString("hex"),
  services,
  toolModule: suppliedTools,
  fetchImpl = fetch,
  environment,
  validateContext,
  onError = () => {},
  stateRoot = path.join(root, ".tmp"),
} = {}) {
  if (
    !validId(profile?.ownerId) ||
    !Array.isArray(profile.mappings) ||
    profile.mappings.some((m) => !validId(m.from) || !validId(m.to))
  )
    throw Error("主聊天 Pi 账号或项目映射无效。");
  const ownerId = profile.ownerId;
  const directory = path.join(
    stateRoot,
    "pi-main",
    digest(ownerId).slice(0, 24),
  );
  const legacy = path.join(stateRoot, "pi-local", "live");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const exec = promisify(execFile);
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { windowsHide: true },
    );
    const sid = stdout.trim();
    if (!/^S-1-[0-9-]+$/.test(sid))
      throw Error("无法核对本机 Pi 状态目录的拥有者。");
    await exec(
      "icacls.exe",
      [
        directory,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ],
      { windowsHide: true },
    );
  }
  const inherited = inheritMcpConfiguration(
    legacy,
    directory,
    profile.mappings,
  );
  let toolModule = suppliedTools;
  if (!toolModule) {
    for (const [source, filename] of [
      ["scripts/pi-local/tools.mjs", "tools.mjs"],
      ["scripts/pi-local/codex-mcp-server.mjs", "codex-mcp-server.mjs"],
    ])
      await build({
        entryPoints: [path.join(root, source)],
        bundle: true,
        packages: "external",
        platform: "node",
        format: "esm",
        outfile: path.join(directory, filename),
        logLevel: "silent",
      });
    await copyFile(
      path.join(root, "runner/credential-helper.ps1"),
      path.join(directory, "credential-helper.ps1"),
    );
    toolModule = await import(pathToFileURL(path.join(directory, "tools.mjs")));
  }
  const vars = environment ?? {
    ...parseEnv(
      await readFile(path.join(root, ".dev.vars"), "utf8").catch(() => ""),
    ),
    ...process.env,
  };
  const models = new Map(),
    bindings = new Set(profile.mappings.map((m) => m.to));
  let defaultModel = "xingchi";
  function remember(payload) {
    if (
      (payload.accountId !== undefined && payload.accountId !== ownerId) ||
      (payload.scope?.accountId !== undefined &&
        payload.scope.accountId !== ownerId) ||
      (payload.accountId !== ownerId && payload.scope?.accountId !== ownerId)
    )
      throw fail("Pi 账号不匹配。", 403);
    if (payload.scope?.bindingId) {
      if (!validId(payload.scope.bindingId)) throw fail("项目编号无效。");
      bindings.add(payload.scope.bindingId);
    }
    const model = payload.model;
    if (model) {
      if (!validId(payload.modelProfileId)) throw fail("模型连接编号无效。");
      if (!model.model || !model.apiKey) {
        models.delete(payload.modelProfileId);
        return;
      }
      const url = new URL(model.baseUrl);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && url.hostname === "127.0.0.1")
        )
      )
        throw fail("模型地址无效。");
      if (!["responses", "chat_completions"].includes(model.apiFormat))
        throw fail("不支持当前模型接口格式。");
      models.set(payload.modelProfileId, {
        ...model,
        baseUrl: url.href.replace(/\/+$/, ""),
        apiKey: async () => model.apiKey,
        service: model.service || "当前聊天模型",
        setupHint: "请检查当前聊天选择的模型连接。",
      });
      defaultModel = payload.modelProfileId;
    }
  }
  async function current(scope) {
    if (scope.accountId !== ownerId || !validId(scope.grantJobId))
      throw fail("缺少原聊天的执行授权。", 403);
    let value;
    if (validateContext) value = await validateContext(scope.grantJobId);
    else {
      const response = await fetchImpl(
        new URL("/api/internal/pi/context", upstream),
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + secret,
          },
          body: JSON.stringify({ jobId: scope.grantJobId }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok)
        throw fail("原聊天任务的账号、项目或上下文授权已失效。", 409);
      value = await response.json();
    }
    if (
      ["accountId", "bindingId", "chatId", "userMessageId", "memoryEpoch"].some(
        (key) => value.scope?.[key] !== scope[key],
      ) ||
      digest(value.scope.projectSource ?? null) !==
        digest(scope.projectSource ?? null)
    )
      throw fail("任务上下文已变化。", 409);
    remember(value);
    return value;
  }
  const catalog = {
    get defaultId() {
      return defaultModel;
    },
    connection(id) {
      const model = models.get(id);
      if (!model) throw Error("尚未收到原聊天的模型连接。");
      return model;
    },
  };
  const maintenance = new ConnectorMaintenance(legacy, {
    propose: createMaintenanceProposer(directory, catalog),
  });
  const nativeOptions = {
    command: vars.QINGDAN_CODEX_BIN,
    env: process.env,
    maintenance,
  };
  // The main app and standalone pilot have different OAuth redirect URIs.
  // Never share their registration, PKCE verifier, pending state or tokens.
  const authDirectory = waaoAuthDirectory(directory, origin);
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  const webLogin =
    services?.login ??
    (await toolModule
      .waaoLogin(authDirectory, origin, vars.QINGDAN_WAAO_MCP_TOKEN, {
        credentialOrigin: new URL(origin).origin,
        clientName: "轻单",
      })
      .catch(() => ({
        token: async () => null,
        status: () => ({ connected: false, kind: "web-mcp" }),
        begin: async () => {
          throw Error(
            "当前入口的 WAAO 授权暂时无法读取，请在工具设置检查连接。其他工具仍可使用。",
          );
        },
        finish: async () => {
          throw Error("请先从工具设置开始 WAAO 授权。");
        },
      })));
  const waao = services?.waao ?? toolModule.webWaao(webLogin, vars, fetchImpl);
  const tools = toolModule.openTools(directory, false, waao, {
    accountId: ownerId,
    isBinding: (id) => bindings.has(id),
  });
  const mcp = new McpConnections(directory, {
    origin,
    credentialFile: (id, url) =>
      toolModule.mcpCredentialFile(
        inherited.has(id) ? legacy : directory,
        id,
        url,
      ),
    codexService: services?.codex ?? localCodexMcp(directory, nativeOptions),
    waaoService: waao,
  });
  const pi = await openPiChat({
    directory,
    accountId: ownerId,
    tools,
    mcp,
    taskHarness: true,
    requirePlanConfirmation: true,
    preloadSelected: true,
    onTaskCompleted: async (report) => {
      if (validateContext) return; // Isolated embedded fixtures have no cloud callback.
      const response = await fetchImpl(
        new URL("/api/internal/pi/retention", upstream),
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + secret,
          },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok && ![401, 403, 409].includes(response.status))
        throw Error("任务沉淀回执尚未送达。");
    },
    isBinding: (id) => bindings.has(id),
    resolveConnection: async (id, scope) => {
      await current(scope);
      return catalog.connection(id);
    },
    beforeExecute: async (scope, name) => {
      await current(scope);
      if (name === "codex") {
        const remote = mcp.turn(scope);
        try {
          remote.authorize("mcp__codex__codex");
        } finally {
          await remote.close();
        }
      }
    },
    filterLocalTools: (specs, scope) =>
      specs.filter(
        (spec) =>
          spec.name !== "codex" ||
          mcp
            .list(scope.bindingId)
            .some(
              (server) =>
                server.kind === "codex" && server.selected.includes("codex"),
            ),
      ),
    authorizeTask: async (envelope) => {
      try {
        await current(envelope.scope);
        return true;
      } catch {
        return false;
      }
    },
  });
  let closing = false;
  async function dispatch(action, payload, signal) {
    remember(payload);
    const scope = payload.scope;
    if (action === "turn") {
      await current(scope);
      const { model, ...turn } = payload;
      return pi.fetch(
        new Request("https://pi.internal/turn", {
          method: "POST",
          body: JSON.stringify(turn),
          signal,
        }),
      );
    }
    if (action === "cancel") {
      pi.cancel(payload.jobId);
      return { ok: true };
    }
    if (action === "retention-activity")
      return { busy: pi.retentionBusy(payload.memoryEpoch) };
    if (action === "state")
      return {
        messages: payload.messages.map((message) =>
          pi.decorate(mcp.decorate(tools.decorate(message)), scope),
        ),
        harnessTask: scope.chatId ? pi.task(scope) : null,
        mcpAvailable: true,
        connectorQuestions: mcp.questions(scope.bindingId),
        waaoConnection: waao.statusOfConnection?.(),
      };
    if (action === "mcp") {
      const result =
        payload.method === "POST"
          ? await mcp.action(scope.bindingId, payload.input)
          : {};
      if (payload.query.waitForService)
        await mcp.checks.get(payload.query.waitForService);
      return { ...result, servers: mcp.list(scope.bindingId) };
    }
    if (action === "questions")
      return payload.method === "POST"
        ? mcp.answerQuestion(scope.bindingId, payload.input)
        : payload.query.requestId
          ? mcp.questionReceipt(scope.bindingId, payload.query.requestId)
          : { questions: mcp.questions(scope.bindingId) };
    if (action === "task-stop") {
      await pi.stopTask(scope, payload.input.taskId);
      return { task: pi.task(scope) };
    }
    if (action === "task-reply") return pi.queueAnswer(scope, payload.input);
    if (action === "mcp-callback") {
      return mcp.finish(payload.id, new URLSearchParams(payload.query));
    }
    if (action === "waao-callback") {
      return mcp.finish("builtin-waao", new URLSearchParams(payload.query));
    }
    if (action === "waao-capabilities") return waao.capabilities(signal);
    if (action === "waao-task") {
      const value = await tools.taskStatus(payload.id, scope.chatId, signal);
      if (!value) throw fail("此会话中没有该回执。", 404);
      return value;
    }
    if (action === "image") {
      const value = await tools.image(payload.id);
      if (!value) throw fail("图片不存在。", 404);
      return new Response(value.bytes, {
        headers: { "Content-Type": value.mime },
      });
    }
    if (action === "video") {
      const url = await tools.video(payload.id, signal);
      if (!url || new URL(url).protocol !== "https:")
        throw fail("成片尚未就绪。", 404);
      return new Response(null, { status: 302, headers: { Location: url } });
    }
    throw fail("Pi 操作不存在。", 404);
  }
  const server = createServer(async (req, res) => {
    try {
      const presented = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from("Bearer " + secret);
      if (
        closing ||
        req.method !== "POST" ||
        req.headers.host !== `127.0.0.1:${server.address().port}` ||
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected)
      )
        throw fail("本机 Pi 控制身份无效。", 403);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw fail("请求过大。", 413);
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks));
      const controller = new AbortController();
      res.once("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      const output = await dispatch(
        new URL(req.url, "http://localhost").pathname.slice(1),
        payload,
        controller.signal,
      );
      if (output instanceof Response) {
        res.writeHead(output.status, Object.fromEntries(output.headers));
        res.end(Buffer.from(await output.arrayBuffer()));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(output));
      }
    } catch (error) {
      onError(error);
      if (!res.destroyed) {
        res.writeHead(error.status || 502, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            error: /[\u3400-\u9fff]/.test(error.message)
              ? error.message.slice(0, 400)
              : "Pi 本机执行端暂时不可用。",
          }),
        );
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const envFile = path.join(directory, "bridge.env");
  await writeFile(
    envFile,
    `LOCAL_PI_URL=${url}\nLOCAL_PI_SECRET=${secret}\nLOCAL_PI_OWNER=${ownerId}\n`,
    { mode: 0o600 },
  );
  let closePromise;
  return {
    url,
    envFile,
    directory,
    ownerId,
    secret,
    get activeCount() {
      return pi.activeCount;
    },
    pauseAdmissions: () => pi.pauseAdmissions(),
    resumeAdmissions: () => pi.resumeAdmissions(),
    updateActivity: () => pi.updateActivity(),
    close() {
      return (closePromise ??= (async () => {
        closing = true;
        await pi.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await mcp.close();
        maintenance.cancel();
        await maintenance.close();
        tools.close();
        models.clear();
      })());
    },
  };
}

export async function startConfiguredPi(root, options = {}) {
  const file = path.join(
    options.stateRoot || path.join(root, ".tmp"),
    "pi-main/profile.json",
  );
  const profile = await readFile(file, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  return profile ? openMainPi({ root, profile, ...options }) : null;
}
