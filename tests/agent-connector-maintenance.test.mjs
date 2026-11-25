import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readdir,
  readFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { build } from "esbuild";
import { ConnectorMaintenance } from "../scripts/pi-local/connector-maintenance.mjs";
import {
  connectorFailure,
  protocolDiagnostic,
  validateAdapter,
  mapRequest,
  defaultAdapter,
} from "../scripts/pi-local/connector-policy.mjs";
import { createMaintenanceProposer } from "../scripts/pi-local/maintenance-pi.mjs";
import { localCodexMcp } from "../scripts/pi-local/codex-mcp.mjs";
import { McpConnections } from "../scripts/pi-local/mcp-connections.mjs";
import { webWaao } from "../scripts/pi-local/waao.mjs";
import { waaoMcpId } from "../shared/agent/waao-endpoint.mjs";
import { waaoFixture, webEnv } from "./fixtures/waao-web-mcp.mjs";
import {
  openResponsesFixture,
  callItem,
  textItem,
} from "./fixtures/pi-local-responses.mjs";

const patch = {
  format: 1,
  requests: { "config/read": { includeLayers: "layers" } },
  responses: {},
};
const protocolError = () =>
  Object.assign(Error("missing field 'layers'"), {
    code: "CODEX_RPC_ERROR",
    rpcCode: -32602,
    method: "config/read",
  });
const fakeClient = () => ({
  verifiedMethods: ["config/read"],
  contractMethods: ["config/read"],
  listTools: async () => [{ name: "query", inputSchema: { type: "object" } }],
  close: async () => {},
});
async function folder(t) {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "connector-maintenance-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}
const request = (open, extra = {}) => ({
  fingerprint: "binary-fingerprint",
  version: "codex-cli 0.999.0",
  kind: "codex",
  open,
  signal: AbortSignal.timeout(20000),
  ...extra,
});

test("维护候选只能适配协议字段，不能写代码、凭据、权限或改变方法", () => {
  assert.deepEqual(
    mapRequest(validateAdapter(patch), "config/read", {
      cwd: "kept",
      includeLayers: false,
    }),
    { cwd: "kept", layers: false },
  );
  for (const invalid of [
    { ...patch, code: "process.exit()" },
    { ...patch, requests: { "config/read": { cwd: "root" } } },
    {
      ...patch,
      requests: { "config/read": { includeLayers: "approvalPolicy" } },
    },
    { ...patch, responses: { "account/read": { account: "other" } } },
    {
      ...patch,
      responses: { "thread/start": { "thread.id": "constructor.prototype" } },
    },
  ])
    assert.throws(() => validateAdapter(invalid));
  assert.deepEqual(
    protocolDiagnostic(
      Object.assign(protocolError(), {
        message: "missing field 'layers' Bearer private-token /private/project",
      }),
    ),
    {
      kind: "protocol",
      method: "config/read",
      rpcCode: -32602,
      field: "layers",
    },
  );
  assert.equal(connectorFailure({ status: 401 }), "authorization");
  assert.equal(connectorFailure({ status: 403 }), "permission");
});

test("相同故障只修复一次，候选通过探测后生效并在重启后复用", async (t) => {
  const dir = await folder(t);
  let calls = 0;
  const host = new ConnectorMaintenance(dir, {
    propose: async () => {
      calls++;
      await delay(30);
      return patch;
    },
  });
  const open = async (adapter) => {
    if (adapter.requests["config/read"]?.includeLayers !== "layers")
      throw protocolError();
    return fakeClient();
  };
  const clients = await Promise.all(
    Array.from({ length: 4 }, () => host.connect(request(open))),
  );
  await Promise.all(clients.map((client) => client.close()));
  assert.equal(calls, 1);
  assert.equal(host.status("binary-fingerprint").revision, 1);
  await host.close();
  const next = new ConnectorMaintenance(dir, {
    propose: async () => assert.fail("should use the verified adapter"),
  });
  try {
    await (await next.connect(request(open))).close();
  } finally {
    await next.close();
  }
});

test("失败补丁不能发布，两轮后持久化暂停，显式重试可重新检测", async (t) => {
  const dir = await folder(t);
  let calls = 0;
  const host = new ConnectorMaintenance(dir, {
    propose: async () => {
      calls++;
      return defaultAdapter;
    },
  });
  const open = async () => {
    throw protocolError();
  };
  await assert.rejects(host.connect(request(open)));
  assert.equal(calls, 2);
  assert.equal(host.status("binary-fingerprint").adapter, "builtin");
  await host.close();
  const next = new ConnectorMaintenance(dir, {
    propose: async () => {
      calls++;
      return patch;
    },
  });
  try {
    await assert.rejects(next.connect(request(open)), {
      code: "CONNECTOR_REPAIR_BLOCKED",
    });
    assert.equal(calls, 2);
    next.retry("binary-fingerprint");
    const fixed = (adapter) =>
      adapter.requests["config/read"]
        ? fakeClient()
        : Promise.reject(protocolError());
    await (await next.connect(request(fixed))).close();
    assert.equal(calls, 3);
  } finally {
    await next.close();
  }
});

test("授权故障不调用维护模型，未探测的执行接口补丁不能发布", async (t) => {
  const dir = await folder(t);
  let calls = 0;
  const host = new ConnectorMaintenance(dir, {
    propose: async () => {
      calls++;
      return {
        ...patch,
        requests: {
          ...patch.requests,
          "turn/start": { threadId: "conversationId" },
        },
      };
    },
  });
  try {
    await assert.rejects(
      host.connect(
        request(async () => {
          throw Object.assign(Error("login"), { code: "CODEX_LOGIN_REQUIRED" });
        }),
      ),
    );
    assert.equal(calls, 0);
    await assert.rejects(
      host.connect(
        request(async (adapter) => {
          if (!adapter.requests["config/read"]) throw protocolError();
          return {
            ...fakeClient(),
            contractMethods: ["config/read", "turn/start"],
          };
        }),
      ),
    );
    assert.equal(host.status("binary-fingerprint").adapter, "builtin");
  } finally {
    await host.close();
  }
});

test("已启用补丁失效时回滚，原连接实例保留自己的映射", async (t) => {
  const dir = await folder(t);
  let renamed = true;
  const host = new ConnectorMaintenance(dir, { propose: async () => patch });
  const open = async (adapter) => {
    if (Boolean(adapter.requests["config/read"]) !== renamed)
      throw protocolError();
    return {
      ...fakeClient(),
      revision: Boolean(adapter.requests["config/read"]),
    };
  };
  try {
    const old = await host.connect(request(open));
    renamed = false;
    const next = await host.connect(request(open));
    assert.equal(old.revision, true);
    assert.equal(next.revision, false);
    assert.equal(host.status("binary-fingerprint").adapter, "builtin");
    await old.close();
    await next.close();
  } finally {
    await host.close();
  }
});

test("真实 Pi 维护会话修复模拟 Codex 参数变化，且不获得业务工具或项目上下文", async (t) => {
  const dir = await folder(t);
  await build({
    entryPoints: ["scripts/pi-local/codex-mcp-server.mjs"],
    outfile: path.join(dir, "codex-mcp-server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  await writeFile(path.join(dir, "config-field.txt"), "layers");
  const provider = await openResponsesFixture((request) => {
    if (request.body.input.some((item) => item.type === "function_call_output"))
      return textItem("候选已交给独立验证器。");
    assert.deepEqual(
      request.body.tools.map((tool) => tool.name),
      ["propose_connector_adapter"],
    );
    return callItem("propose_connector_adapter", patch);
  });
  const catalog = {
    defaultId: "fixture",
    connection: () => ({ ...provider.settings, service: "local fixture" }),
  };
  const host = new ConnectorMaintenance(dir, {
    propose: createMaintenanceProposer(dir, catalog),
  });
  try {
    const service = localCodexMcp(dir, {
      command: process.execPath,
      args: [path.resolve("tests/fixtures/codex-mcp-app-server.mjs"), dir],
      maintenance: host,
    });
    const client = await service.connect(AbortSignal.timeout(40000));
    assert.deepEqual(
      (await client.listTools()).map((tool) => tool.name),
      ["codex", "codex-reply"],
    );
    await client.close();
    assert.equal(service.maintenanceStatus().revision, 1);
    assert.equal(provider.requests.length, 2);
    const prompt = JSON.stringify(provider.requests[0].body.input);
    assert.doesNotMatch(
      prompt,
      /local-fixture-only|PRIVATE-PROJECT|QINGDAN_CODEX/,
    );
    assert.match(prompt, /layers/);
    const files = await readdir(path.join(dir, "connectors"));
    assert.equal(files.filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    await host.close();
    await provider.close();
  }
});

test("连接前失败可恢复原请求，成功回执复用，发送后丢回包绝不重复执行", async (t) => {
  const dir = await folder(t);
  let mode = "ready",
    executions = 0;
  const service = {
    connect: async () => {
      if (mode === "connect-fails")
        throw Object.assign(Error("unavailable"), {
          code: "CODEX_UNAVAILABLE",
        });
      return {
        listTools: async () => [
          {
            name: "codex",
            inputSchema: {
              type: "object",
              properties: { prompt: { type: "string" } },
              required: ["prompt"],
            },
          },
        ],
        callTool: async () => {
          executions++;
          if (mode === "lost-ack") throw Error("connection lost");
          return { content: [{ type: "text", text: "original result" }] };
        },
        close: async () => {},
      };
    },
  };
  let manager = new McpConnections(dir, { codexService: service });
  await manager.initialCheck;
  const scope = {
    bindingId: "project",
    chatId: "chat",
    userMessageId: "message",
    visible: [],
    accountId: "pi-local",
  };
  await manager.action(scope.bindingId, {
    id: "builtin-codex",
    action: "select",
    tools: ["codex"],
  });
  try {
    const first = manager.turn(scope);
    mode = "connect-fails";
    await assert.rejects(
      first.execute(
        first.specs[0].name,
        { prompt: "test" },
        "original",
        AbortSignal.timeout(5000),
      ),
    );
    await first.close();
    assert.equal(executions, 0);
    mode = "ready";
    await manager.readyForTurn(scope.bindingId);
    const recovered = manager.turn({ ...scope, retry: true });
    const result = await recovered.execute(
      recovered.specs[0].name,
      { prompt: "test" },
      "replacement",
      AbortSignal.timeout(5000),
    );
    assert.equal(result.content[0].text, "original result");
    await recovered.close();
    assert.equal(executions, 1);
    assert.equal(
      manager.db.prepare("SELECT count(*) AS n FROM calls").get().n,
      1,
    );
    assert.equal(
      manager.db.prepare("SELECT callId FROM calls").get().callId,
      "original",
    );
    const replay = manager.turn({ ...scope, retry: true });
    assert.deepEqual(
      await replay.execute(
        replay.specs[0].name,
        { prompt: "test" },
        "newer",
        AbortSignal.timeout(5000),
      ),
      result,
    );
    assert.equal(
      (
        await replay.execute(
          replay.specs[0].name,
          { prompt: "changed" },
          "changed",
          AbortSignal.timeout(5000),
        )
      ).isError,
      true,
    );
    await replay.close();
    mode = "lost-ack";
    const secondScope = { ...scope, userMessageId: "second" };
    const second = manager.turn(secondScope);
    await assert.rejects(
      second.execute(
        second.specs[0].name,
        { prompt: "test" },
        "unknown",
        AbortSignal.timeout(5000),
      ),
    );
    await second.close();
    await manager.close();
    mode = "ready";
    manager = new McpConnections(dir, { codexService: service });
    await manager.initialCheck;
    const uncertain = manager.turn({ ...secondScope, retry: true });
    const held = await uncertain.execute(
      uncertain.specs[0].name,
      { prompt: "test" },
      "retry-unknown",
      AbortSignal.timeout(5000),
    );
    assert.equal(held.isError, true);
    assert.match(held.content[0].text, /unknown/);
    assert.equal(executions, 2);
    assert.deepEqual(manager.turn({ ...scope, bindingId: "other" }).specs, []);
    await uncertain.close();
  } finally {
    await manager.close();
  }
});

test("WAAO 官网直连独立于 Codex，来源选择持久化且不会自动扩大工具勾选", async (t) => {
  const dir = await folder(t);
  const remote = waaoFixture();
  let codexCalls = 0;
  const native = {
    connect: async () => {
      codexCalls++;
      return {
        source: "codex",
        listTools: async () => [
          { name: "project_list", inputSchema: { type: "object" } },
        ],
        close: async () => {},
      };
    },
  };
  const login = {
    token: async () => "fixture",
    status: () => ({ connected: true }),
  };
  let service = webWaao(login, webEnv, remote.http, native);
  let manager = new McpConnections(dir, { waaoService: service });
  await manager.initialCheck;
  const before = codexCalls;
  try {
    assert.equal(
      (
        await manager.action("project", {
          id: waaoMcpId,
          action: "source",
          source: "web",
        })
      ).status,
      "ready",
    );
    assert.equal(manager.list("project")[0].connectionSource, "web");
    assert.deepEqual(manager.list("project")[0].selected, []);
    await manager.close();
    service = webWaao(login, webEnv, remote.http, native);
    manager = new McpConnections(dir, { waaoService: service });
    await manager.initialCheck;
    assert.equal(codexCalls, before);
    assert.equal(manager.list("project")[0].connectionPreference, "web");
    assert.deepEqual(manager.list("project")[0].selected, []);
  } finally {
    await manager.close();
  }
});

test("取消原请求会立即停止等待，独立维护结果仍可供下一次调用使用", async (t) => {
  const dir = await folder(t);
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const host = new ConnectorMaintenance(dir, {
    propose: async () => {
      await wait;
      return patch;
    },
  });
  const open = (adapter) =>
    adapter.requests["config/read"]
      ? fakeClient()
      : Promise.reject(protocolError());
  const controller = new AbortController();
  try {
    const pending = host.connect(request(open, { signal: controller.signal }));
    await delay(20);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    release();
    await (await host.connect(request(open))).close();
    assert.equal(host.status("binary-fingerprint").revision, 1);
  } finally {
    release();
    await host.close();
  }
});
