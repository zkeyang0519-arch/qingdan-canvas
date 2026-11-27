import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { waaoAuthDirectory, openMainPi } from "../scripts/pi-main/server.mjs";
import { webWaao } from "../scripts/pi-local/waao.mjs";
import { McpConnections } from "../scripts/pi-local/mcp-connections.mjs";
import { waaoFixture } from "./fixtures/waao-web-mcp.mjs";
import {
  waaoIssuer,
  waaoMcpUrl,
  waaoScopes,
} from "../shared/agent/waao-endpoint.mjs";

async function scratch(t) {
  const root = path.resolve(".tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "waao-authorization-"));
  t.after(async () => {
    assert.equal(path.dirname(dir), root);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}

test("主入口的 WAAO 注册与 PKCE 状态按账号和回调入口隔离", () => {
  const base = path.resolve(".tmp/pi-main/account-a");
  const main = waaoAuthDirectory(base, "http://127.0.0.1:8790");
  assert.equal(main, waaoAuthDirectory(base, "http://127.0.0.1:8790/"));
  assert.notEqual(main, waaoAuthDirectory(base, "http://127.0.0.1:8797"));
  assert.notEqual(
    main,
    waaoAuthDirectory(
      path.resolve(".tmp/pi-main/account-b"),
      "http://127.0.0.1:8790",
    ),
  );
  assert.notEqual(main, path.resolve(".tmp/pi-local/live"));
});

test("原主聊天确实将独立目录和匹配回调交给 WAAO 登录器", async (t) => {
  const root = await scratch(t);
  let captured;
  const empty = {
    connect: async () => ({ listTools: async () => [], close: async () => {} }),
    statusOfConnection: () => ({ connected: false }),
  };
  const bridge = await openMainPi({
    root,
    environment: {},
    origin: "http://127.0.0.1:8790",
    profile: { ownerId: "account", mappings: [] },
    toolModule: {
      waaoLogin: async (...args) => {
        captured = args;
        return {};
      },
      openTools: () => ({
        references: () => [],
        context: () => [],
        decorate: (x) => x,
        close() {},
      }),
      mcpCredentialFile: () => ({ load: async () => ({}) }),
    },
    services: { codex: empty, waao: empty },
  });
  try {
    assert.ok(captured[0].startsWith(path.join(root, ".tmp", "pi-main")));
    assert.ok(captured[0].includes(path.sep + "waao-auth" + path.sep));
    assert.equal(captured[1], "http://127.0.0.1:8790");
    assert.equal(captured[3].credentialOrigin, captured[1]);
    assert.equal(captured[3].clientName, "轻单");
  } finally {
    await bridge.close();
  }
});

test("未完成的旧入口注册不会被用于主入口，新注册和兑换使用同一回调", async (t) => {
  const dir = await scratch(t),
    file = path.join(dir, "login.mjs");
  await build({
    entryPoints: ["scripts/pi-local/waao-login.mjs"],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const { waaoLogin } = await import(pathToFileURL(file));
  const mainCallback = "http://127.0.0.1:8790/local/waao/callback";
  let saved = {
    client: {
      client_id: "old-preview-client",
      redirect_uris: ["http://127.0.0.1:8797/local/waao/callback"],
    },
    pending: {
      nonce: "old",
      until: Date.now() + 600000,
      url:
        waaoIssuer +
        "/authorize?client_id=old-preview-client&redirect_uri=" +
        encodeURIComponent(mainCallback),
      verifier: "old",
    },
  };
  let registrations = 0,
    exchanges = 0;
  const store = {
    load: async () => structuredClone(saved),
    save: async (s) => {
      saved = structuredClone(s);
    },
  };
  const fetchImpl = async (url, options) => {
    const u = new URL(url);
    if (u.hostname === "www.waao.studio")
      return Response.json({
        resource: waaoMcpUrl,
        authorization_servers: [waaoIssuer],
        scopes_supported: waaoScopes.split(" "),
      });
    if (u.pathname === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: waaoIssuer,
        authorization_endpoint: waaoIssuer + "/authorize",
        token_endpoint: waaoIssuer + "/token",
        registration_endpoint: waaoIssuer + "/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
    if (u.pathname === "/register") {
      registrations++;
      const meta = JSON.parse(options.body);
      assert.deepEqual(meta.redirect_uris, [mainCallback]);
      assert.equal(meta.client_name, "轻单");
      return Response.json(
        { ...meta, client_id: "main-client" },
        { status: 201 },
      );
    }
    assert.equal(u.pathname, "/token");
    exchanges++;
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("client_id"), "main-client");
    assert.equal(body.get("redirect_uri"), mainCallback);
    assert.ok(body.get("code_verifier"));
    return Response.json({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    });
  };
  const login = await waaoLogin(dir, "http://127.0.0.1:8790", undefined, {
    store,
    fetchImpl,
    clientName: "轻单",
  });
  const request = new URL((await login.begin("/app?room=project")).url);
  assert.equal(request.searchParams.get("client_id"), "main-client");
  assert.equal(request.searchParams.get("redirect_uri"), mainCallback);
  assert.notEqual(request.searchParams.get("state"), "old");
  await login.finish(
    new URLSearchParams({
      state: request.searchParams.get("state"),
      code: "fixture-code",
      iss: waaoIssuer,
    }),
  );
  assert.equal(registrations, 1);
  assert.equal(exchanges, 1);
  assert.equal(login.clientId(), "main-client");
  assert.equal(login.status().connected, true);
});

test("WAAO 账号回执必须匹配当前 OAuth 客户端，目录成功不能替代授权核验", async () => {
  const service = webWaao({ clientId: () => "qingdan-client" }, {});
  const catalog = [{ name: "account_get" }];
  const client = (id) => ({
    callTool: async () => ({
      structuredContent: {
        user_id: "user",
        client_id: id,
        display_name: "测试账号",
        scopes: ["read"],
      },
      content: [],
    }),
  });
  await assert.rejects(
    service.verifyAuthorization(client("codex-client"), catalog),
    /客户端.*不一致/,
  );
  await assert.rejects(
    service.verifyAuthorization(client("qingdan-client"), []),
    /核验工具/,
  );
  await assert.rejects(
    service.verifyAuthorization(
      { callTool: async () => ({ isError: true, content: [] }) },
      catalog,
    ),
    /尚未确认/,
  );
  const verified = await service.verifyAuthorization(
    client("qingdan-client"),
    catalog,
  );
  assert.equal(verified.verified, true);
  assert.equal(verified.clientId, "qingdan-client");
  assert.equal(verified.accountLabel, "测试账号");
});

test("只有 WAAO 实际确认身份才标记可用，切换身份会使已加载工具失效", async (t) => {
  const dir = await scratch(t),
    remote = waaoFixture();
  let expected = "different-client";
  const service = webWaao(
    {
      token: async () => "fixture",
      clientId: () => expected,
      status: () => ({ connected: true }),
    },
    {},
    remote.http,
  );
  const manager = new McpConnections(dir, { waaoService: service });
  try {
    await manager.initialCheck;
    assert.equal(manager.list("project")[0].status, "authorization");
    assert.equal(manager.list("project")[0].authorization, null);
    expected = "fixture-client";
    await manager.action("project", { id: "builtin-waao", action: "test" });
    const info = manager.list("project")[0];
    assert.equal(info.status, "ready");
    assert.equal(info.authorization.verified, true);
    manager.setSelection("project", "builtin-waao", ["project_list"]);
    const turn = manager.turn({
      accountId: "test",
      bindingId: "project",
      chatId: "chat",
      userMessageId: "m1",
      visible: [],
    });
    expected = "changed-client";
    await manager.action("project", { id: "builtin-waao", action: "test" });
    assert.throws(() => turn.authorize("mcp__waao__project_list"), /停用|变更/);
    await turn.close();
  } finally {
    await manager.close();
  }
});
