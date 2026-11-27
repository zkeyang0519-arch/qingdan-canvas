import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { McpConnections } from "../scripts/pi-local/mcp-connections.mjs";
import { codexMcpId } from "../scripts/pi-local/codex-mcp.mjs";
import { webWaao } from "../scripts/pi-local/waao.mjs";
import { HarnessCapabilities } from "../scripts/pi-local/harness-capabilities.mjs";
import { TaskStore } from "../runner/harness/task-store.mjs";
import { TaskRun } from "../runner/harness/coordinator.mjs";
import {
  waaoAccessIssue,
  readWaaoAccessError,
} from "../shared/agent/waao-access.mjs";
import {
  waaoMcpId,
  waaoMcpUrl,
  waaoProjectsUrl,
} from "../shared/agent/waao-endpoint.mjs";
import { waaoFixture } from "./fixtures/waao-web-mcp.mjs";

const scope = {
  accountId: "test",
  bindingId: "project-a",
  chatId: "chat",
  userMessageId: "m1",
  visible: [],
};
const queryName = "mcp__waao__project_list";
const codexService = {
  connect: async () => ({
    listTools: async () =>
      ["codex", "codex-reply"].map((name) => ({
        name,
        inputSchema: { type: "object" },
      })),
    close: async () => {},
  }),
};

async function fixture(t, seed) {
  const base = path.resolve(".tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "waao-service-"));
  await seed?.(dir);
  const remote = waaoFixture();
  const state = { extraTools: [], denial: null, connected: true };
  const service = webWaao(
    {
      token: async () => (state.connected ? "fixture" : null),
      clientId: () => "fixture-client",
      status: () => ({ configured: true, connected: state.connected }),
      rejected: () => {
        state.connected = false;
      },
    },
    {},
    async (url, init) => {
      const packet = init.method === "POST" ? JSON.parse(init.body) : {};
      if (
        packet.method === "tools/call" &&
        packet.params.name !== "account_get" &&
        state.denial
      ) {
        if (state.denial.status)
          return Response.json(state.denial.body, {
            status: state.denial.status,
          });
        if (state.denial.rpc)
          return Response.json({
            jsonrpc: "2.0",
            id: packet.id,
            error: state.denial.body,
          });
        return Response.json({
          jsonrpc: "2.0",
          id: packet.id,
          result: {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify(state.denial.body) },
            ],
            structuredContent: state.denial.body,
          },
        });
      }
      const response = await remote.http(url, init);
      if (
        packet.method === "tools/list" &&
        packet.params?.cursor &&
        state.extraTools.length
      ) {
        const data = await response.json();
        data.result.tools.push(
          ...state.extraTools.map((name) => ({
            name,
            description: "查询工具 " + name,
            inputSchema: { type: "object", properties: {} },
          })),
        );
        return Response.json(data);
      }
      return response;
    },
  );
  const create = () =>
    new McpConnections(dir, { waaoService: service, codexService });
  let manager = create();
  await manager.initialCheck;
  t.after(async () => {
    await manager.close();
    assert.equal(path.dirname(dir), base);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    dir,
    state,
    service,
    remote,
    get manager() {
      return manager;
    },
    async restart() {
      await manager.close();
      manager = create();
      await manager.initialCheck;
    },
  };
}

test("旧 WAAO 工具选择迁移为独立项目开关，其他 MCP 仍逐项选择，重启不恢复已关闭的服务", async (t) => {
  const f = await fixture(t, (dir) => {
    const db = new DatabaseSync(path.join(dir, "mcp-connections.sqlite"));
    db.exec(`CREATE TABLE servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,authMode TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offline',catalog TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE selections(binding TEXT NOT NULL,server TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,tools TEXT NOT NULL,PRIMARY KEY(binding,server));`);
    const add = db.prepare(
      "INSERT INTO servers(id,name,url,authMode) VALUES(?,?,?,?)",
    );
    add.run(waaoMcpId, "WAAO", waaoMcpUrl, "auto");
    add.run(codexMcpId, "Codex", "stdio:codex", "local");
    const choose = db.prepare("INSERT INTO selections VALUES(?,?,?)");
    choose.run(scope.bindingId, waaoMcpId, '["project_list"]');
    choose.run("project-b", waaoMcpId, "[]");
    choose.run(scope.bindingId, codexMcpId, '["codex"]');
    db.close();
  });
  const waao = (binding = scope.bindingId) =>
    f.manager.list(binding).find((s) => s.kind === "waao");
  assert.equal(waao().enabled, true);
  assert.ok(waao().selected.includes("node_generate"));
  assert.equal(waao("project-b").enabled, false);
  assert.equal(waao("new-project").enabled, false);
  assert.deepEqual(
    f.manager.list(scope.bindingId).find((s) => s.kind === "codex").selected,
    ["codex"],
  );
  await f.manager.action(scope.bindingId, {
    action: "service",
    id: waaoMcpId,
    enabled: false,
  });
  await f.restart();
  assert.equal(waao().enabled, false);
  assert.deepEqual(waao().selected, []);
  assert.equal(waao("project-b").enabled, false);
  assert.deepEqual(
    f.manager.list(scope.bindingId).find((s) => s.kind === "codex").selected,
    ["codex"],
  );
});

test("WAAO 新工具自动可发现，156 项以上目录只预加载少量定义，关闭状态不伪装为官网权限缺失", async (t) => {
  const f = await fixture(t);
  f.state.extraTools = Array.from(
    { length: 156 },
    (_, i) => "budget_query_" + i,
  );
  await f.manager.action(scope.bindingId, { action: "test", id: waaoMcpId });
  const caps = new HarnessCapabilities(f.manager, scope, []);
  const remote = f.manager.turn(scope);
  try {
    assert.equal((await caps.request(queryName)).status, "service_disabled");
    assert.equal(remote.specs.length, 0);
    await f.manager.action(scope.bindingId, {
      action: "service",
      id: waaoMcpId,
      enabled: true,
    });
    const enabled = f.manager.turn(scope);
    try {
      caps.preload(enabled, "WAAO 项目查询");
      assert.ok(enabled.specs.length > 156);
      assert.ok(caps.activeSpecs().length <= 6);
      assert.equal(
        (await caps.request("mcp__waao__budget_query_155")).status,
        "ready",
      );
      assert.equal(
        caps.activeSpecs().filter((s) => s.name.endsWith("budget_query_155"))
          .length,
        1,
      );
      f.state.extraTools.push("future_export_status");
      await f.manager.action(scope.bindingId, {
        action: "test",
        id: waaoMcpId,
      });
      assert.equal(
        (await caps.request("mcp__waao__future_export_status")).status,
        "ready",
      );
      assert.ok(
        f.manager
          .list(scope.bindingId)
          .find((s) => s.kind === "waao")
          .selected.includes("future_export_status"),
      );
      assert.equal(
        f.manager.list("project-b").find((s) => s.kind === "waao").enabled,
        false,
      );
      f.manager.setServiceEnabled(scope.bindingId, waaoMcpId, false);
      assert.throws(
        () => caps.authorize("mcp__waao__budget_query_155"),
        /停用/,
      );
      f.manager.setServiceEnabled(scope.bindingId, waaoMcpId, true);
      assert.throws(
        () => caps.authorize("mcp__waao__budget_query_155"),
        /服务设置发生变更/,
      );
    } finally {
      await enabled.close();
    }
  } finally {
    await caps.close();
    await remote.close();
  }
});

test("WAAO 未核验时不能开启项目，授权失效仍可关闭，并不再显示已确认账号", async (t) => {
  const f = await fixture(t);
  f.manager.setServiceEnabled(scope.bindingId, waaoMcpId, true);
  const remote = f.manager.turn(scope);
  try {
    f.state.denial = { status: 401, body: { error: "invalid_token" } };
    await assert.rejects(
      remote.execute(queryName, {}, "expired", AbortSignal.timeout(5000)),
      /连接 WAAO/,
    );
    const row = f.manager.list(scope.bindingId).find((s) => s.kind === "waao");
    assert.equal(row.status, "authorization");
    assert.equal(row.authorization, null);
    assert.equal(row.enabled, true);
    assert.throws(
      () => f.manager.setServiceEnabled("project-b", waaoMcpId, true),
      /先完成 WAAO 官网授权/,
    );
    f.manager.setServiceEnabled(scope.bindingId, waaoMcpId, false);
    assert.equal(
      f.manager.list(scope.bindingId).find((s) => s.kind === "waao").enabled,
      false,
    );
  } finally {
    await remote.close();
  }
});

test("真实 MCP HTTP 403 保留 WAAO 原因和操作入口，回执、进展和连接状态一致", async (t) => {
  const f = await fixture(t);
  f.manager.setServiceEnabled(scope.bindingId, waaoMcpId, true);
  f.state.denial = {
    status: 403,
    body: {
      error: {
        code: "insufficient_scope",
        message: "此应用没有该组织的读取权限。",
        data: {
          required_scopes: ["read"],
          manage_url: waaoProjectsUrl + "?permission=review",
        },
      },
    },
  };
  const remote = f.manager.turn(scope);
  const caps = new HarnessCapabilities(f.manager, scope, []);
  await caps.request(queryName);
  const store = new TaskStore(f.dir);
  const run = new TaskRun({
    store,
    scope,
    input: { text: "列出 WAAO 项目", history: [], memories: [] },
    jobId: "denied",
    signal: AbortSignal.timeout(10000),
    capabilities: caps,
  });
  try {
    await run.control("update_task", {
      requirements: [
        { id: "list", description: "取得实际项目列表", check: "answer" },
      ],
      steps: [],
    });
    const result = await run.execute(
      queryName,
      {},
      "denied-call",
      (name, args, id) =>
        remote.execute(name, args, id, AbortSignal.timeout(5000)),
    );
    assert.equal(result.isError, true);
    assert.equal(result.accessIssue.message, "此应用没有该组织的读取权限。");
    assert.deepEqual(result.accessIssue.requiredScopes, ["read"]);
    assert.equal(result.accessIssue.code, "insufficient_scope");
    const row = f.manager.list(scope.bindingId).find((s) => s.kind === "waao");
    assert.equal(row.status, "ready");
    assert.equal(row.authorization.verified, true);
    assert.equal(row.accessIssue.message, result.accessIssue.message);
    assert.equal(
      f.manager.list("project-b").find((s) => s.kind === "waao").accessIssue,
      null,
    );
    const receipt = f.manager.decorate({
      role: "assistant",
      bindingId: scope.bindingId,
      chatId: scope.chatId,
      replyTo: scope.userMessageId,
    }).mcpCalls[0];
    assert.equal(receipt.status, "error");
    assert.equal(receipt.accessIssue.actionUrl, result.accessIssue.actionUrl);
    assert.equal(run.task.activities.at(-1).text, result.accessIssue.message);
    assert.equal(
      run.task.activities.at(-1).action.url,
      result.accessIssue.actionUrl,
    );
    await assert.rejects(
      f.service.targets({}, AbortSignal.timeout(5000), remote.waaoAccess),
      (error) => error.accessIssue?.message === result.accessIssue.message,
    );
    f.state.denial = null;
    await remote.execute(queryName, {}, "recovered", AbortSignal.timeout(5000));
    assert.equal(
      f.manager.list(scope.bindingId).find((s) => s.kind === "waao")
        .accessIssue,
      null,
    );
  } finally {
    run.close();
    store.close();
    await caps.close();
    await remote.close();
  }
});

test("MCP 200 中的权限拒绝同样保留服务端原因，不把所有工具错误视作授权失败", async (t) => {
  const f = await fixture(t);
  f.manager.setServiceEnabled(scope.bindingId, waaoMcpId, true);
  f.state.denial = {
    body: {
      error: "approval_required",
      message: "需要组织管理员批准。",
      approval_url: waaoProjectsUrl + "?approval=fixture",
    },
  };
  const remote = f.manager.turn(scope);
  try {
    const result = await remote.execute(
      queryName,
      {},
      "approval",
      AbortSignal.timeout(5000),
    );
    assert.equal(result.accessIssue.kind, "approval");
    assert.match(result.accessIssue.actionLabel, /批准/);
    assert.equal(
      f.manager.list(scope.bindingId).find((s) => s.kind === "waao").status,
      "ready",
    );
    f.state.denial = {
      rpc: true,
      body: {
        code: -32003,
        message: "Operation denied",
        data: { code: "permission_denied", message: "项目只允许读取。" },
      },
    };
    const protocolDenied = await remote.execute(
      queryName,
      {},
      "protocol-denied",
      AbortSignal.timeout(5000),
    );
    assert.equal(protocolDenied.accessIssue.message, "项目只允许读取。");
    f.state.denial = {
      body: { error: { code: "invalid_parameter", message: "缺少项目 ID" } },
    };
    const invalid = await remote.execute(
      queryName,
      {},
      "invalid",
      AbortSignal.timeout(5000),
    );
    assert.equal(invalid.isError, true);
    assert.equal(invalid.accessIssue, undefined);
  } finally {
    await remote.close();
  }
});

test("拒绝说明清除凭据、仅使用官网处理入口，并兼容空或非对象 HTTP 错误", async () => {
  const issue = waaoAccessIssue({
    error: "insufficient_scope",
    error_description:
      '缺少 generate。Bearer secret-value "access_token":"private-value"',
    required_scope: "generate canvas:write",
    authorization_url: "https://untrusted.example/authorize",
  });
  assert.equal(issue.code, "insufficient_scope");
  assert.doesNotMatch(issue.message, /secret-value|private-value/);
  assert.deepEqual(issue.requiredScopes, ["generate", "canvas:write"]);
  assert.equal(issue.actionUrl, waaoProjectsUrl);
  assert.equal(
    waaoAccessIssue({ code: "budget_exceeded", message: "超出预算" }).kind,
    "budget",
  );
  for (const text of ["", "null", '"forbidden"', "<html>平台拒绝</html>"])
    assert.ok(
      (await readWaaoAccessError(new Response(text, { status: 403 }))).message,
    );
  assert.equal(
    waaoAccessIssue({ code: "internal_error", message: "稍后重试" }),
    null,
  );
});
