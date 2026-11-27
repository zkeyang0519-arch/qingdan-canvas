import test from "node:test";
import { DatabaseSync } from "node:sqlite";
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

test("移除 Codex 转接的 WAAO 卡片与工具权限，保留历史回执；自行添加后仅使用轻单授权", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "waao-direct-only-"));
  const legacy = new DatabaseSync(path.join(dir, "mcp-connections.sqlite"));
  legacy.exec(`
    CREATE TABLE servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,authMode TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offline',catalog TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE selections(binding TEXT NOT NULL,server TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,tools TEXT NOT NULL,PRIMARY KEY(binding,server));
    CREATE TABLE connector_preferences(server TEXT PRIMARY KEY,source TEXT NOT NULL);
    CREATE TABLE calls(binding TEXT NOT NULL,chat TEXT NOT NULL,message TEXT NOT NULL,callId TEXT NOT NULL,service TEXT NOT NULL,tool TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL,details TEXT NOT NULL,PRIMARY KEY(binding,chat,message,callId));
  `);
  legacy
    .prepare("INSERT INTO servers VALUES(?,?,?,?,?,?)")
    .run(
      waaoMcpId,
      "WAAO",
      waaoMcpUrl,
      "auto",
      "ready",
      JSON.stringify([
        { name: "project_list", inputSchema: { type: "object" } },
      ]),
    );
  legacy
    .prepare("INSERT INTO selections VALUES(?,?,?)")
    .run(scope.bindingId, waaoMcpId, '["project_list"]');
  legacy
    .prepare("INSERT INTO connector_preferences VALUES(?,?)")
    .run(waaoMcpId, "codex");
  legacy
    .prepare("INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,?)")
    .run(
      scope.bindingId,
      scope.chatId,
      "old-message",
      "old-call",
      "WAAO",
      "project_list",
      "done",
      "历史查询回执",
      JSON.stringify({ serverId: waaoMcpId, connectionSource: "codex" }),
    );
  legacy.close();
  const remote = waaoFixture();
  let delegated = 0,
    webCalls = 0,
    signedIn = false;
  const login = {
    status: () => ({ connected: signedIn }),
    token: async () => (signedIn ? "fixture" : null),
    begin: async () => ({ url: waaoIssuer + "/authorize?state=direct" }),
    finish: async () => {
      signedIn = true;
    },
  };
  // A legacy caller passing a delegated adapter must not re-enable it.
  const service = webWaao(
    login,
    webEnv,
    async (url, init) => {
      webCalls++;
      return remote.http(url, init);
    },
    {
      connect: async () => {
        delegated++;
        throw Error("must not delegate");
      },
    },
  );
  const codexService = {
    connect: async () => ({
      listTools: async () => [
        { name: "codex", inputSchema: { type: "object" } },
      ],
      close: async () => {},
    }),
  };
  const create = () =>
    new McpConnections(dir, { waaoService: service, codexService });
  let manager = create();
  t.after(async () => {
    await manager.close();
    assert.equal(path.dirname(dir), path.resolve(".tmp"));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  await manager.initialCheck;
  assert.deepEqual(
    manager.list(scope.bindingId).map((row) => row.kind),
    ["codex"],
  );
  assert.deepEqual(manager.turn(scope).specs, []);
  assert.equal(manager.turn(scope).waaoAccess.enabled, false);
  assert.equal(
    manager.db
      .prepare("SELECT count(*) AS n FROM selections WHERE server=?")
      .get(waaoMcpId).n,
    0,
  );
  assert.equal(
    manager.db
      .prepare("SELECT summary FROM calls WHERE callId='old-call'")
      .get().summary,
    "历史查询回执",
  );
  assert.equal(delegated, 0);
  assert.equal(webCalls, 0);
  await assert.rejects(
    manager.action(scope.bindingId, { id: waaoMcpId, action: "test" }),
    /已移除/,
  );
  await assert.rejects(
    manager.action(scope.bindingId, {
      id: waaoMcpId,
      action: "source",
      source: "codex",
    }),
    /轻单自己的授权/,
  );
  await manager.add({ name: "WAAO", url: waaoMcpUrl });
  let row = manager.list(scope.bindingId).find((row) => row.kind === "waao");
  assert.equal(row.status, "authorization");
  assert.deepEqual(row.tools, []);
  assert.deepEqual(row.selected, []);
  const auth = await manager.action(scope.bindingId, {
    id: waaoMcpId,
    action: "login",
  });
  await manager.finish(waaoMcpId, new URL(auth.url).searchParams);
  manager.setSelection(scope.bindingId, waaoMcpId, ["project_list"]);
  const turn = manager.turn(scope);
  try {
    assert.equal(
      (await turn.execute(queryName, {}, randomUUID(), read(5000))).isError,
      false,
    );
    assert.ok(remote.calls.includes("account_get"));
    assert.deepEqual(
      remote.calls.filter((name) => name !== "account_get"),
      ["project_list"],
    );
    assert.equal(
      manager.decorate({
        role: "assistant",
        replyTo: scope.userMessageId,
        chatId: scope.chatId,
        bindingId: scope.bindingId,
      }).mcpCalls[0].connectionSource,
      "web",
    );
  } finally {
    await turn.close();
  }
  const before = webCalls;
  manager.db
    .prepare(
      "UPDATE calls SET delivery='not_sent',status='error',requestHash=(SELECT requestHash FROM calls WHERE message=? LIMIT 1) WHERE callId='old-call'",
    )
    .run(scope.userMessageId);
  const retry = manager.turn({
    ...scope,
    userMessageId: "old-message",
    retry: true,
  });
  try {
    await assert.rejects(
      retry.execute(queryName, {}, randomUUID(), read(5000)),
      /已移除的转接连接/,
    );
  } finally {
    await retry.close();
  }
  await assert.rejects(
    service.status({ connectionSource: "codex" }, read(5000)),
    /历史任务/,
  );
  await assert.rejects(
    service.video({ connectionSource: "codex" }, read(5000)),
    /历史任务/,
  );
  assert.equal(webCalls, before);
  await manager.close();
  manager = create();
  await manager.initialCheck;
  row = manager.list(scope.bindingId).find((row) => row.kind === "waao");
  assert.equal(row.connectionSource, "web");
  assert.equal(row.enabled, true);
  assert.deepEqual(
    row.selected,
    row.tools.map((tool) => tool.name),
  );
  assert.equal(delegated, 0);
  // An account may have had both its own OAuth login and the old delegated
  // connection. Retain the former, but never inherit the latter's selections.
  manager.db
    .prepare("UPDATE connector_preferences SET source='codex' WHERE server=?")
    .run(waaoMcpId);
  await manager.close();
  manager = create();
  await manager.initialCheck;
  row = manager.list(scope.bindingId).find((row) => row.kind === "waao");
  assert.equal(row.status, "ready");
  assert.equal(row.connectionSource, "web");
  assert.deepEqual(row.selected, []);
  assert.equal(delegated, 0);
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
  const clientOnly = await waaoLogin(dir, origin, undefined, {
    store: {
      load: async () => ({ client: { client_id: "unfinished-registration" } }),
      save: async () => {
        throw Error("read-only inspection must not save");
      },
    },
  });
  assert.equal(clientOnly.status().configured, false);
  assert.equal(clientOnly.status().connected, false);
  const unconfigured = new McpConnections(dir, {
    waaoService: webWaao(clientOnly, {}, async () => {
      throw Error("an unfinished OAuth client must not be probed");
    }),
  });
  try {
    await unconfigured.initialCheck;
    assert.deepEqual(unconfigured.list(scope.bindingId), []);
  } finally {
    await unconfigured.close();
  }
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
  const { url } = await login.begin("/app?room=fixture-project");
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
  assert.deepEqual(await login.finish(returned), {
    returnTo: "/app?room=fixture-project#mcp=waao",
  });
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
    status: () => ({ configured: granted || !!challenge, connected: granted }),
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
  assert.deepEqual(manager.list(scope.bindingId), []);
  await manager.add({ name: "WAAO", url: waaoMcpUrl });
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
    /轻单自己的授权/,
  );
  manager.setServiceEnabled(scope.bindingId, waaoMcpId, true);
  await app.restart();
  const enabled = app.manager.list(scope.bindingId)[0];
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.selectionMode, "service");
  assert.deepEqual(
    enabled.selected,
    enabled.tools.map((tool) => tool.name),
  );
  assert.equal(
    app.manager.turn({ ...scope, bindingId: "another" }).specs.length,
    0,
  );
  assert.ok(app.remote.calls.includes("account_get"));
  assert.equal(
    app.remote.calls.filter((name) => name !== "account_get").length,
    0,
  );
  assert.equal(
    app.manager.list(scope.bindingId)[0].authorization.verified,
    true,
  );
});

test("真实 Pi 发现后直接调用 WAAO 项目查询，省去单独加载一轮且保留官网协议回执", async (t) => {
  const app = await setup(t, true),
    manager = app.manager;
  manager.setSelection(scope.bindingId, waaoMcpId, ["project_list"]);
  const responses = await openResponsesFixture((req, index) => {
    const names = req.body.tools.map((t) => t.name);
    if (index === 1) {
      assert.equal(
        names.filter((name) => name.startsWith("mcp__waao__")).length,
        0,
      );
      return callItem(
        "find_capabilities",
        { query: "WAAO project_list" },
        "find_projects",
      );
    }
    if (index === 2) {
      assert.match(JSON.stringify(req.body.input), /mcp__waao__project_list/);
      assert.ok(names.includes(queryName));
      assert.ok(
        names.filter((name) => name.startsWith("mcp__waao__")).length <= 4,
      );
      return callItem(queryName, {}, "call_read_project");
    }
    assert.ok(names.includes(queryName));
    assert.match(JSON.stringify(req.body.input), /试映/);
    return textItem("已找到试映项目。");
  });
  t.after(() => responses.close());
  const pi = await openPiChat({
    directory: app.dir,
    settings: responses.settings,
    tools: { references: () => [] },
    mcp: manager,
    taskHarness: true,
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
    assert.equal(responses.requests.length, 3);
  } finally {
    await pi.close();
  }
  assert.deepEqual(
    app.remote.calls.filter((name) => name !== "account_get"),
    ["project_list"],
  );
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

test("关闭项目服务对已开启轮次和短片助手同时生效，工具权限不足和账户过期可区分", async (t) => {
  const app = await setup(t, true),
    manager = app.manager;
  manager.setServiceEnabled(scope.bindingId, waaoMcpId, true);
  const turn = manager.turn(scope);
  try {
    const projects = await app.waao.targets({}, read(5000), turn.waaoAccess);
    assert.equal(projects.projects[0].name, "试映");
    app.fail(403);
    const denied = await turn.execute(queryName, {}, randomUUID(), read(5000));
    assert.equal(denied.isError, true);
    assert.equal(manager.list(scope.bindingId)[0].status, "ready");
    manager.setServiceEnabled(scope.bindingId, waaoMcpId, false);
    await assert.rejects(
      app.waao.targets({}, read(5000), turn.waaoAccess),
      /停用/,
    );
    await assert.rejects(
      turn.execute(queryName, {}, randomUUID(), read(5000)),
      /停用/,
    );
    assert.deepEqual(
      app.remote.calls.filter((name) => name !== "account_get"),
      ["project_list"],
    );
    manager.setServiceEnabled(scope.bindingId, waaoMcpId, true);
    await assert.rejects(
      turn.execute(queryName, {}, randomUUID(), read(5000)),
      /服务设置发生变更/,
    );
    app.fail(401);
    const fresh = manager.turn(scope);
    try {
      await assert.rejects(
        fresh.execute(queryName, {}, randomUUID(), read(5000)),
        /连接 WAAO/,
      );
    } finally {
      await fresh.close();
    }
    assert.equal(manager.list(scope.bindingId)[0].status, "authorization");
  } finally {
    await turn.close();
  }
  await app.restart();
  assert.equal(app.manager.list(scope.bindingId)[0].status, "authorization");
  assert.equal(app.manager.list(scope.bindingId)[0].connectionSource, "web");
});

test("服务面板仅显示自行添加的 WAAO，提供独立授权且没有转接来源选项", async (t) => {
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
      (el) =>
        el.textContent.trim() === name ||
        el.getAttribute("aria-label") === name,
    );
  await render("unconfigured");
  assert.equal(document.querySelectorAll(".qd-mcp-service").length, 0);
  assert.equal(button("连接 WAAO"), undefined);
  await app.manager.add({ name: "WAAO", url: waaoMcpUrl });
  await render("signed-out");
  assert.equal(document.querySelectorAll(".qd-mcp-service").length, 1);
  assert.match(
    document.querySelector(".qd-mcp-row").textContent,
    /轻单独立连接/,
  );
  assert.equal(document.querySelector('[aria-label="WAAO 连接来源"]'), null);
  assert.doesNotMatch(document.body.textContent, /托管连接|复用本机 Codex/);
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
  assert.match(document.body.textContent, /WAAO 服务端已确认授权 · 测试账号/);
  assert.equal(document.querySelectorAll('[role="switch"]').length, 1);
  assert.equal(
    button("在当前项目使用 WAAO").getAttribute("aria-checked"),
    "false",
  );
  await act(async () => button("在当前项目使用 WAAO").click());
  assert.equal(
    button("在当前项目使用 WAAO").getAttribute("aria-checked"),
    "true",
  );
  assert.equal(document.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(button("选用项目查询工具"), undefined);
  await act(async () => button("项目与画布").click());
  assert.ok(
    app.manager.list(scope.bindingId)[0].selected.includes("node_generate"),
  );
  const filter = document.querySelector('input[aria-label="搜索工具"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    ).set.call(filter, "TASK_GET");
    filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.deepEqual(
    [...document.querySelectorAll(".qd-mcp-choice strong")].map(
      (el) => el.textContent,
    ),
    ["task_get"],
  );
  assert.deepEqual(app.manager.list("another")[0].selected, []);
});
