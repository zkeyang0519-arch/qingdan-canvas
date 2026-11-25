import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { McpConnections } from "../scripts/pi-local/mcp-connections.mjs";
import { openPiChat } from "../scripts/pi-local/rpc-chat.mjs";
import { chatInput } from "../scripts/pi-local/chat-input.mjs";
import {
  callItem,
  openResponsesFixture,
  textItem,
} from "./fixtures/pi-local-responses.mjs";

const description = {
  name: "lookup",
  description: "按主题查找已发布文档",
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string" } },
    required: ["topic"],
  },
};
const json = (res, value, status = 200, extra = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(value));
};
async function serviceFixture(t) {
  const calls = [],
    issued = [];
  const access = "local-mcp-fixture-token";
  let origin;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (
      req.url === "/.well-known/oauth-protected-resource" ||
      req.url === "/resource"
    ) {
      return json(res, {
        resource: origin + "/oauth-mcp",
        authorization_servers: [origin],
        scopes_supported: ["docs.read"],
      });
    }
    if (req.url === "/.well-known/oauth-authorization-server")
      return json(res, {
        issuer: origin,
        authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token",
        registration_endpoint: origin + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
    if (req.url === "/register")
      return json(res, { ...JSON.parse(raw), client_id: "qingdan-test" }, 201);
    if (req.url === "/token") {
      issued.push(new URLSearchParams(raw));
      return json(res, {
        access_token: access,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "fixture-refresh",
      });
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }
    const packet = JSON.parse(raw);
    if (
      req.url !== "/public" &&
      req.headers.authorization !== "Bearer " + access
    )
      return json(res, {}, 401, {
        "WWW-Authenticate":
          'Bearer resource_metadata="' +
          origin +
          '/resource", scope="docs.read"',
      });
    if (packet.method === "notifications/initialized") {
      res.writeHead(202);
      return res.end();
    }
    let result;
    if (packet.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "test-kb", version: "1" },
      };
    if (packet.method === "tools/list")
      result = packet.params?.cursor
        ? { tools: [{ ...description, name: "other" }] }
        : { tools: [description], nextCursor: "2" };
    if (packet.method === "tools/call") {
      calls.push({
        ...packet.params,
        auth: req.headers.authorization,
        modelHeader: req.headers["x-qd-client"],
      });
      result = {
        content: [
          {
            type: "text",
            text: "竖屏交付要求 1080×1920。来源 https://docs.example/specs",
          },
        ],
      };
    }
    if (!result) return json(res, { error: "unsupported" }, 400);
    return json(res, { jsonrpc: "2.0", id: packet.id, result });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { origin, access, calls, issued };
}

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "qingdan-mcp-test-"));
  const secret = new Map();
  const opts = {
    origin: "http://127.0.0.1:9799",
    credentialFile: (id) => ({
      load: async () => structuredClone(secret.get(id) || {}),
      save: async (value) => {
        secret.set(id, structuredClone(value));
      },
      clear: async () => secret.delete(id),
    }),
  };
  let manager = new McpConnections(dir, opts);
  t.after(async () => {
    await manager.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    dir,
    get manager() {
      return manager;
    },
    async restart() {
      await manager.close();
      manager = new McpConnections(dir, opts);
    },
  };
}

test("项目所选工具由真实 Pi 调用，凭据隔离，回执与授权在重启后保留", async (t) => {
  const fixture = await serviceFixture(t),
    app = await setup(t);
  const { manager } = app;
  const project = "pi-local-binding";
  const added = await manager.add({
    name: "知识库",
    url: fixture.origin + "/private",
    authMode: "token",
    token: fixture.access,
  });
  assert.equal(added.status, "ready");
  assert.deepEqual(
    manager.list(project)[0].tools.map((t) => t.name),
    ["lookup", "other"],
  );
  assert.equal(manager.list(project)[0].selected.length, 0);
  manager.setSelection(project, added.id, ["lookup"]);
  const scope = {
    accountId: "pi-local",
    bindingId: project,
    chatId: "chat",
    userMessageId: "msg",
    visible: [],
  };
  const responses = await openResponsesFixture((request, index) => {
    const tools = request.body.tools.map((tool) => tool.name);
    const name = tools.find((tool) => tool.endsWith("__lookup"));
    assert.ok(name);
    assert.ok(!tools.some((tool) => tool.endsWith("__other")));
    assert.ok(!JSON.stringify(request).includes(fixture.access));
    if (index === 1) return callItem(name, { topic: "竖屏交付" });
    assert.match(JSON.stringify(request.body.input), /1080×1920/);
    return textItem("竖屏要求是 1080×1920。");
  });
  t.after(() => responses.close());
  const chat = await openPiChat({
    directory: app.dir,
    settings: responses.settings,
    tools: { references: () => [] },
    mcp: manager,
  });
  try {
    const result = await chat.fetch(
      new Request("https://pi.internal/turn", {
        method: "POST",
        body: JSON.stringify({
          jobId: randomUUID(),
          sessionId: randomUUID(),
          scope,
          input: chatInput("查一下竖屏交付规范", {
            recentMessages: [],
            memories: [],
          }),
        }),
      }),
    );
    const answer = await result.json();
    assert.equal(result.status, 200, JSON.stringify(answer));
    assert.match(answer.text, /1080×1920/);
  } finally {
    await chat.close();
  }
  assert.deepEqual(fixture.calls, [
    {
      name: "lookup",
      arguments: { topic: "竖屏交付" },
      auth: "Bearer " + fixture.access,
      modelHeader: undefined,
    },
  ]);
  const other = manager.turn({ ...scope, bindingId: "project-b" });
  assert.deepEqual(other.specs, []);
  const retryTurn = manager.turn({ ...scope, retry: true });
  const cached = await retryTurn.execute(
    retryTurn.specs[0].name,
    { topic: "竖屏交付" },
    "new-call-id",
    AbortSignal.timeout(5000),
  );
  assert.match(cached.content[0].text, /1080×1920/);
  assert.equal(fixture.calls.length, 1);
  await retryTurn.close();
  const turn = manager.turn(scope);
  manager.setSelection(project, added.id, []);
  await assert.rejects(
    turn.execute(turn.specs[0].name, {}, "revoked", AbortSignal.timeout(5000)),
    /停用/,
  );
  assert.equal(fixture.calls.length, 1);
  await turn.close();
  await app.restart();
  const message = {
    role: "assistant",
    chatId: "chat",
    bindingId: project,
    replyTo: "msg",
  };
  assert.match(
    app.manager.decorate(message).mcpCalls[0].summary,
    /docs\.example/,
  );
  assert.deepEqual(app.manager.decorate(message).mcpCalls[0].links, [
    "https://docs.example/specs",
  ]);
  assert.equal(
    app.manager.decorate({ ...message, bindingId: "project-b" }).mcpCalls,
    undefined,
  );
  assert.deepEqual(app.manager.list(project)[0].selected, []);
  await app.manager.action(project, { id: added.id, action: "remove" });
  assert.deepEqual(app.manager.list(project), []);
});

test("公开连接与浏览器 OAuth 使用同一个目录，PKCE 回调一次有效", async (t) => {
  const fixture = await serviceFixture(t),
    { manager } = await setup(t);
  assert.equal(
    (await manager.add({ name: "公开", url: fixture.origin + "/public" }))
      .status,
    "ready",
  );
  const auth = await manager.add({
    name: "登录",
    url: fixture.origin + "/oauth-mcp",
  });
  assert.equal(auth.status, "authorization");
  const login = await manager.action("p", { id: auth.id, action: "login" });
  const redirect = new URL(login.url);
  assert.equal(redirect.origin, fixture.origin);
  assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
  const response = new URLSearchParams({
    code: "fixture-code",
    state: redirect.searchParams.get("state"),
    iss: fixture.origin,
  });
  assert.equal((await manager.finish(auth.id, response)).status, "ready");
  assert.ok(fixture.issued[0].get("code_verifier"));
  await assert.rejects(manager.finish(auth.id, response), /过期/);
  await assert.rejects(
    manager.add({ name: "无效", url: "file:///private" }),
    /HTTPS/,
  );
});
