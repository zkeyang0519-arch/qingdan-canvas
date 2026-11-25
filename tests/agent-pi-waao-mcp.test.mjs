import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { McpConnections } from "../scripts/pi-local/mcp-connections.mjs";
import { webWaao } from "../scripts/pi-local/waao.mjs";
import { openPiChat } from "../scripts/pi-local/rpc-chat.mjs";
import { chatInput } from "../scripts/pi-local/chat-input.mjs";
import {
  waaoIssuer,
  waaoMcpId,
  waaoMcpUrl,
  waaoProjectsUrl,
  waaoScopes,
} from "../shared/agent/waao-endpoint.mjs";
import { waaoFixture, webEnv } from "./fixtures/waao-web-mcp.mjs";
import {
  openResponsesFixture,
  callItem,
  textItem,
} from "./fixtures/pi-local-responses.mjs";

const scope = {
  accountId: "pi-local",
  bindingId: "pi-local-binding",
  chatId: "test-chat",
  userMessageId: "u1",
  visible: [],
};
const queryName = "mcp__waao__project_list";
const read = AbortSignal.timeout;

test("轻单复用 Codex 的 WAAO 注册，限定来源和工具，查询与短片共用授权且失败不会跨账号重发", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "waao-native-grant-"));
  const mod = path.join(dir, "waao-connector.mjs");
  await build({
    entryPoints: ["scripts/pi-local/waao-codex.mjs"],
    outfile: mod,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
  });
  const { codexWaaoMcp } = await import(pathToFileURL(mod));
  const registration = {
    name: "waao",
    origin: new URL(waaoMcpUrl).origin,
    entry: {
      enabled: true,
      url: waaoMcpUrl,
      environment_id: "local",
      enabled_tools: ["project_list", "node_generate"],
      disabled_tools: ["node_generate"],
    },
  };
  const config = path.join(dir, "waao-registration.json");
  await writeFile(config, JSON.stringify(registration));
  const upstream = codexWaaoMcp(dir, {
    command: process.execPath,
    args: [path.resolve("tests/fixtures/codex-mcp-app-server.mjs"), dir],
  });
  let webCalls = 0,
    requestsForToken = 0;
  const legacyLogin = {
    status: () => ({ connected: true }),
    token: async () => {
      requestsForToken++;
      return "unused-fixture";
    },
  };
  const waao = webWaao(
    legacyLogin,
    {},
    async () => {
      webCalls++;
      throw Error("unexpected direct HTTP request");
    },
    upstream,
  );
  const manager = new McpConnections(dir, { waaoService: waao });
  t.after(async () => {
    await manager.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  await manager.initialCheck;
  const [row] = manager.list(scope.bindingId);
  assert.equal(row.status, "ready", row.diagnostic);
  assert.equal(row.connectionSource, "codex");
  assert.deepEqual(
    row.tools.map((item) => item.name),
    ["project_list"],
  );
  await manager.action(scope.bindingId, {
    id: waaoMcpId,
    action: "enable",
    tools: ["project_list"],
  });
  assert.deepEqual(
    manager.turn({ ...scope, bindingId: "project-b" }).specs,
    [],
  );
  const turn = manager.turn(scope);
  try {
    assert.equal(
      (await turn.execute(queryName, {}, randomUUID(), read(18000))).isError,
      false,
    );
    const [trace] = manager.decorate({
      role: "assistant",
      replyTo: scope.userMessageId,
      chatId: scope.chatId,
      bindingId: scope.bindingId,
    }).mcpCalls;
    assert.equal(trace.connectionSource, "codex");
    assert.deepEqual(await waao.targets({}, read(15000), turn.waaoAccess), {
      projects: [],
      truncated: undefined,
    });
    await writeFile(
      config,
      JSON.stringify({ ...registration, rejectCall: true }),
    );
    await assert.rejects(
      turn.execute(queryName, {}, randomUUID(), read(10000)),
      /未取得/,
    );
    manager.setSelection(scope.bindingId, waaoMcpId, []);
    await assert.rejects(
      turn.execute(queryName, {}, randomUUID(), read(8000)),
      /停用/,
    );
  } finally {
    await turn.close();
  }
  await writeFile(
    config,
    JSON.stringify({ ...registration, origin: "https://unrelated.example" }),
  );
  assert.equal(
    (await manager.action(scope.bindingId, { id: waaoMcpId, action: "test" }))
      .status,
    "offline",
  );
  const events = (await readFile(path.join(dir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    events.some((e) => e.method === "turn/start"),
    false,
  );
  assert.deepEqual(
    events.filter((e) => e.method === "mcpServer/tool/call").map((e) => e.tool),
    ["project_list", "project_list", "project_list"],
  );
  assert.equal(webCalls, 0);
  assert.equal(requestsForToken, 0);
});

test("官网 OAuth 使用固定回调和 PKCE，过期令牌只刷新一次，重启不会重新采用已失效的环境凭据", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "waao-login-test-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const file = path.join(dir, "login.mjs");
  await build({
    entryPoints: ["scripts/pi-local/waao-login.mjs"],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  const { waaoLogin } = await import(pathToFileURL(file));
  const origin = "http://127.0.0.1:8797",
    callback = origin + "/local/waao/callback";
  let saved = {},
    refreshes = 0;
  const store = {
    load: async () => structuredClone(saved),
    save: async (data) => {
      saved = structuredClone(data);
    },
  };
  async function fetchImpl(url, init = {}) {
    const dest = new URL(url);
    assert.equal(init.redirect, "error");
    if (
      dest.href ===
      "https://www.waao.studio/.well-known/oauth-protected-resource/api/mcp"
    )
      return Response.json({
        resource: waaoMcpUrl,
        authorization_servers: [waaoIssuer],
        scopes_supported: waaoScopes.split(" "),
      });
    assert.equal(dest.origin, waaoIssuer);
    if (dest.pathname === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: waaoIssuer,
        authorization_endpoint: waaoIssuer + "/authorize",
        token_endpoint: waaoIssuer + "/token",
        registration_endpoint: waaoIssuer + "/register",
        grant_types_supported: ["authorization_code", "refresh_token"],
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
    if (dest.pathname === "/register") {
      const data = JSON.parse(init.body);
      assert.deepEqual(data.redirect_uris, [callback]);
      return Response.json(
        { ...data, client_id: "fixture-client" },
        { status: 201 },
      );
    }
    assert.equal(dest.pathname, "/token");
    const data = new URLSearchParams(init.body);
    if (data.get("grant_type") === "refresh_token") {
      refreshes++;
      assert.equal(data.get("refresh_token"), "fixture-refresh");
      return Response.json({
        access_token: "fixture-renewed",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "fixture-rotated",
      });
    }
    assert.equal(data.get("grant_type"), "authorization_code");
    assert.equal(data.get("redirect_uri"), callback);
    assert.ok(data.get("code_verifier"));
    assert.equal(data.get("resource"), waaoMcpUrl);
    return Response.json({
      access_token: "fixture-grant",
      token_type: "Bearer",
      expires_in: 1,
      refresh_token: "fixture-refresh",
    });
  }
  const login = await waaoLogin(dir, origin, "old-fixture", {
    store,
    fetchImpl,
  });
  login.rejected("old-fixture");
  const { url } = await login.begin();
  const page = new URL(url);
  assert.equal(page.origin, waaoIssuer);
  assert.equal(page.searchParams.get("scope"), waaoScopes);
  assert.equal(page.searchParams.get("code_challenge_method"), "S256");
  const returned = new URLSearchParams({
    state: page.searchParams.get("state"),
    code: "fixture-code",
    iss: waaoIssuer,
  });
  await assert.rejects(
    login.finish(new URLSearchParams({ state: "wrong", code: "fixture-code" })),
    /过期/,
  );
  await login.finish(returned);
  assert.deepEqual(await Promise.all([login.token(), login.token()]), [
    "fixture-renewed",
    "fixture-renewed",
  ]);
  assert.equal(refreshes, 1);
  const reopened = await waaoLogin(dir, origin, "old-fixture", {
    store,
    fetchImpl,
  });
  assert.equal(await reopened.token(), "fixture-renewed");
  await assert.rejects(reopened.finish(returned), /过期/);
});

async function setup(t, signedIn = false) {
  const base = path.resolve(".tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "waao-project-tools-"));
  const remote = waaoFixture();
  let granted = signedIn,
    challenge = "",
    failure;
  const login = {
    token: async () => (granted ? "fixture" : null),
    rejected: () => {
      granted = false;
    },
    begin: async () => {
      challenge = randomUUID();
      return { url: waaoIssuer + "/authorize?state=" + challenge };
    },
    finish: async (params) => {
      if (!challenge || params.get("state") !== challenge)
        throw Error("WAAO 登录请求已过期。");
      granted = true;
      challenge = "";
    },
  };
  const waao = webWaao(login, webEnv, async (url, init) => {
    assert.equal(String(url), waaoMcpUrl);
    const packet = init.method === "POST" ? JSON.parse(init.body) : {};
    if (failure && packet.method === "tools/call")
      return new Response(null, { status: failure });
    return remote.http(url, init);
  });
  const create = () => new McpConnections(dir, { waaoService: waao });
  let manager = create();
  await manager.initialCheck;
  t.after(async () => {
    await manager.close();
    assert.equal(path.dirname(dir), base);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    dir,
    remote,
    waao,
    get manager() {
      return manager;
    },
    fail(code) {
      failure = code;
    },
    async restart() {
      await manager.close();
      manager = create();
      await manager.initialCheck;
    },
  };
}

test("WAAO 是固定的官网 MCP 服务，沿用原授权、读取全部分页，项目链接定位同一卡片", async (t) => {
  const app = await setup(t);
  const { manager } = app;
  let [row] = manager.list(scope.bindingId);
  assert.equal(row.kind, "waao");
  assert.equal(row.url, waaoMcpUrl);
  assert.equal(row.status, "authorization");
  assert.deepEqual(row.tools, []);
  for (const url of [waaoProjectsUrl, waaoMcpUrl]) {
    assert.equal((await manager.add({ name: "WAAO", url })).id, waaoMcpId);
  }
  assert.equal(manager.list(scope.bindingId).length, 1);
  const login = await manager.action(scope.bindingId, {
    id: waaoMcpId,
    action: "login",
  });
  assert.equal(new URL(login.url).origin, waaoIssuer);
  const params = new URL(login.url).searchParams;
  assert.equal((await manager.finish(waaoMcpId, params)).status, "ready");
  await assert.rejects(manager.finish(waaoMcpId, params), /过期/);
  [row] = manager.list(scope.bindingId);
  assert.ok(row.tools.some((t) => t.name === "project_list"));
  assert.ok(row.tools.some((t) => t.name === "task_get"));
  assert.deepEqual(row.selected, []);
  await assert.rejects(
    manager.action(scope.bindingId, { id: waaoMcpId, action: "remove" }),
    /内置/,
  );
  manager.setSelection(scope.bindingId, waaoMcpId, ["project_list"]);
  await app.restart();
  assert.deepEqual(app.manager.list(scope.bindingId)[0].selected, [
    "project_list",
  ]);
  assert.equal(
    app.manager.turn({ ...scope, bindingId: "another" }).specs.length,
    0,
  );
  assert.equal(app.remote.calls.length, 0);
});

test("真实 Pi 调用已选 WAAO 项目查询，模型和回执均收到官网协议结果", async (t) => {
  const app = await setup(t, true),
    manager = app.manager;
  manager.setSelection(scope.bindingId, waaoMcpId, ["project_list"]);
  const responses = await openResponsesFixture((req, index) => {
    const names = req.body.tools.map((t) => t.name);
    assert.ok(names.includes(queryName));
    assert.ok(!names.includes("mcp__waao__node_generate"));
    if (index === 1) return callItem(queryName, {}, "call_read_project");
    assert.match(JSON.stringify(req.body.input), /试映/);
    return textItem("已找到试映项目。");
  });
  t.after(() => responses.close());
  const pi = await openPiChat({
    directory: app.dir,
    settings: responses.settings,
    tools: { references: () => [] },
    mcp: manager,
  });
  try {
    const answer = await pi.fetch(
      new Request("https://pi.internal/turn", {
        method: "POST",
        body: JSON.stringify({
          jobId: randomUUID(),
          sessionId: randomUUID(),
          scope,
          input: chatInput("列出 WAAO 项目", {
            recentMessages: [],
            memories: [],
          }),
        }),
      }),
    );
    const data = await answer.json();
    assert.equal(answer.status, 200, JSON.stringify(data));
    assert.match(data.text, /试映/);
  } finally {
    await pi.close();
  }
  assert.deepEqual(app.remote.calls, ["project_list"]);
  assert.equal(app.remote.submitted, 0);
  const [receipt] = manager.decorate({
    role: "assistant",
    bindingId: scope.bindingId,
    chatId: scope.chatId,
    replyTo: scope.userMessageId,
  }).mcpCalls;
  assert.equal(receipt.service, "WAAO");
  assert.equal(receipt.tool, "project_list");
  assert.equal(receipt.status, "done");
});

test("撤销项目勾选对已开启轮次和短片助手同时生效，工具权限不足和账户过期可区分", async (t) => {
  const app = await setup(t, true),
    manager = app.manager;
  manager.setSelection(scope.bindingId, waaoMcpId, ["project_list"]);
  const turn = manager.turn(scope);
  try {
    await assert.rejects(
      app.waao.targets({ project: "private" }, read(5000), turn.waaoAccess),
      /未提供工具/,
    );
    assert.deepEqual(app.remote.calls, []);
    const projects = await app.waao.targets({}, read(5000), turn.waaoAccess);
    assert.equal(projects.projects[0].name, "试映");
    app.fail(403);
    const denied = await turn.execute(queryName, {}, randomUUID(), read(5000));
    assert.equal(denied.isError, true);
    assert.equal(manager.list(scope.bindingId)[0].status, "ready");
    manager.setSelection(scope.bindingId, waaoMcpId, []);
    await assert.rejects(
      app.waao.targets({}, read(5000), turn.waaoAccess),
      /停用/,
    );
    await assert.rejects(
      turn.execute(queryName, {}, randomUUID(), read(5000)),
      /停用/,
    );
    assert.deepEqual(app.remote.calls, ["project_list"]);
    manager.setSelection(scope.bindingId, waaoMcpId, ["project_list"]);
    app.fail(401);
    await assert.rejects(
      turn.execute(queryName, {}, randomUUID(), read(5000)),
      /连接 WAAO/,
    );
    assert.equal(manager.list(scope.bindingId)[0].status, "authorization");
  } finally {
    await turn.close();
  }
});

test("服务面板只有一张 WAAO 卡片，显示官网授权、项目入口及本项目可筛选的勾选项", async (t) => {
  const app = await setup(t);
  const pathToUi = path.join(app.dir, "panel.mjs");
  await build({
    entryPoints: ["src/agent/McpToolsPanel.jsx"],
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    loader: { ".css": "empty" },
    outfile: pathToUi,
  });
  const dom = new JSDOM('<main id="app"></main>', {
    url: "http://127.0.0.1:8797/",
  });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"],
    previous = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client"),
    { default: Panel } = await import(pathToFileURL(pathToUi));
  const root = createRoot(document.getElementById("app"));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    keys.forEach((k, i) => {
      if (previous[i]) Object.defineProperty(globalThis, k, previous[i]);
      else delete globalThis[k];
    });
  });
  const call = async (_url, opts = {}) => {
    const changed = opts.body
      ? await app.manager.action(scope.bindingId, opts.body)
      : {};
    return { ...changed, servers: app.manager.list(scope.bindingId) };
  };
  const render = (key) =>
    act(async () =>
      root.render(
        React.createElement(Panel, {
          key,
          bindingId: scope.bindingId,
          call,
          initialServer: waaoMcpId,
          onClose: () => {},
        }),
      ),
    );
  const button = (name) =>
    [...document.querySelectorAll("button")].find(
      (el) => el.textContent.trim() === name,
    );
  await render("signed-out");
  assert.equal(document.querySelectorAll(".qd-mcp-service").length, 1);
  assert.ok(button("连接 WAAO"));
  assert.equal(document.querySelector("a").href, waaoProjectsUrl);
  assert.match(document.querySelector(".qd-mcp-row").textContent, /需要授权/);
  const { url } = await app.manager.action(scope.bindingId, {
    action: "login",
    id: waaoMcpId,
  });
  await app.manager.finish(waaoMcpId, new URL(url).searchParams);
  await render("signed-in");
  assert.equal(button("连接 WAAO"), undefined);
  await act(async () => button("选用项目查询工具").click());
  assert.ok(document.querySelector("input[value=project_list]").checked);
  assert.ok(!document.querySelector("input[value=node_generate]").checked);
  const filter = document.querySelector('input[aria-label="搜索工具"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    ).set.call(filter, "TASK_GET");
    filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.deepEqual(
    [...document.querySelectorAll("input[type=checkbox]")].map(
      (el) => el.value,
    ),
    ["task_get"],
  );
  assert.deepEqual(app.manager.list("another")[0].selected, []);
});
