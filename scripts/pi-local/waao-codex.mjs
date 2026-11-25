import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexClient } from "../../runner/codex-client.ts";
import { waaoMcpUrl } from "../../shared/agent/waao-endpoint.mjs";
import { codexRuntime } from "./codex-runtime.mjs";
import {
  adaptNativeClient,
  connectorFailure,
  defaultAdapter,
} from "./connector-policy.mjs";

const missing = () =>
  Object.assign(Error("本机 Codex 未启用 WAAO 官网连接。"), {
    code: "WAAO_CODEX_MISSING",
  });
const signIn = () =>
  Object.assign(
    Error("请在本机 Codex 恢复 WAAO 授权，然后点击「测试连接」。"),
    { status: 401, code: "WAAO_CODEX_AUTH" },
  );

// Codex owns the configured server and its OAuth tokens. This adapter starts
// an ephemeral transport context and forwards MCP calls, without a model turn.
export function codexWaaoMcp(directory, options = {}) {
  const runtime = codexRuntime(options);
  const cwd = path.resolve(directory, "waao-codex", "work");
  let inspected;
  return {
    maintenanceStatus: () =>
      options.maintenance?.status(inspected?.fingerprint),
    retryMaintenance: () => options.maintenance?.retry(inspected?.fingerprint),
    async connect(signal, beforeDispatch) {
      const identity = (inspected = await runtime.inspect());
      const open = (patch, probeSignal) =>
        connectOnce(identity, patch, probeSignal, beforeDispatch);
      const validate = (patch, probeSignal) =>
        connectOnce(identity, patch, probeSignal);
      return options.maintenance
        ? options.maintenance.connect({
            ...identity,
            kind: "waao",
            open,
            validate,
            signal,
          })
        : open(defaultAdapter, signal);
    },
  };
  async function connectOnce(identity, patch, signal, beforeDispatch) {
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const native = adaptNativeClient(
      new CodexClient({
        command: identity.command,
        args: runtime.args,
        env: runtime.env,
        protocolPolicy: "probe",
        stdioTransport: identity.stdioTransport,
        requestTimeoutMs: 90000,
        maxMessageBytes: 32 * 1024 * 1024,
      }),
      patch,
    );
    // Do not confirm purchases or other elicitation on the user's behalf.
    native.on("request", (p) => {
      if (p.method === "mcpServer/elicitation/request")
        native.respond(p.id, { action: "decline", content: null });
      else native.rejectRequest(p.id, "请在 WAAO 官网处理需要人工确认的请求。");
    });
    let closing;
    const close = () => {
      signal.removeEventListener("abort", abort);
      return (closing ??= native.close().catch(() => {}));
    };
    const abort = () => {
      void close();
    };
    signal.throwIfAborted();
    // Install the lifetime listener after spawn so a pre-spawn abort cannot
    // leave an app-server behind.
    try {
      await native.connect();
      signal.addEventListener("abort", abort, { once: true });
      signal.throwIfAborted();
      const { config } = await native.request("config/read", {
        cwd,
        includeLayers: false,
      });
      const registrations = config?.mcp_servers || {};
      const candidates = Object.entries(registrations).filter(
        ([, r]) =>
          r?.enabled !== false &&
          r?.url?.replace(/\/$/, "") === waaoMcpUrl &&
          !r.command,
      );
      const match =
        candidates.find(([name]) => name === "waao") ||
        (candidates.length === 1 ? candidates[0] : null);
      if (!match) throw missing();
      const [waaoName, entry] = match;
      const overrides = {
        "features.apps": false,
        "features.plugins": false,
        "features.shell_tool": false,
        "features.image_generation": false,
        web_search: "disabled",
      };
      for (const name of Object.keys(registrations))
        if (name !== waaoName)
          overrides["mcp_servers." + name + ".enabled"] = false;
      const started = await native.request("thread/start", {
        cwd,
        runtimeWorkspaceRoots: [cwd],
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        selectedCapabilityRoots: [],
        config: overrides,
      });
      const threadId = started.thread?.id;
      if (!threadId) throw Error("Codex 没有返回 WAAO 连接会话。");
      let row;
      const deadline = Date.now() + 22000;
      do {
        signal.throwIfAborted();
        // A config's default environment ("local") can still register its
        // MCP thread-wide (environmentId=null). Discover by name first and
        // pin the runtime scope actually returned when dispatching the tool.
        const page = await native.request("mcpServerStatus/list", {
          threadId,
          serverName: waaoName,
          detail: "toolsAndAuthOnly",
          limit: 100,
        });
        const named = (page.data || []).filter(
          (item) => item.name === waaoName,
        );
        const exact = entry.environment_id
          ? named.filter((item) => item.environmentId === entry.environment_id)
          : [];
        const rows = exact.length
          ? exact
          : named.filter(
              (item) => !entry.environment_id || item.environmentId == null,
            );
        if (rows.length > 1 || page.nextCursor)
          throw Error("Codex 未能唯一识别 WAAO 连接。");
        row = rows[0];
        if (
          row?.authStatus === "notLoggedIn" ||
          row?.runtimeStatus === "authenticationRequired"
        )
          throw signIn();
        if (row?.runtimeStatus === "disabled") throw missing();
        if (row?.runtimeStatus === "connected" && !row.toolsError) break;
        if (
          ["failed", "cancelled"].includes(row?.runtimeStatus) ||
          (row?.runtimeStatus === "connected" && row.toolsError)
        )
          throw Error("Codex 的 WAAO 连接暂不可用。");
        await delay(250, undefined, { signal });
      } while (Date.now() < deadline);
      if (
        row?.runtimeStatus !== "connected" ||
        row.httpOrigin !== new URL(waaoMcpUrl).origin
      )
        throw Error("无法确认 Codex 的 WAAO 官网连接。");
      const catalog = new Map(
        Object.values(row.tools || {})
          .filter(
            (tool) =>
              typeof tool?.name === "string" &&
              tool.inputSchema &&
              (!Array.isArray(entry.enabled_tools) ||
                entry.enabled_tools.includes(tool.name)) &&
              !entry.disabled_tools?.includes(tool.name),
          )
          .map((tool) => [tool.name, tool]),
      );
      const registeredEnvironment = row.environmentId
        ? { environmentId: row.environmentId }
        : {};
      return {
        source: "codex",
        verifiedMethods: [...native.verifiedMethods],
        contractMethods: [
          "config/read",
          "thread/start",
          "mcpServerStatus/list",
          "mcpServer/tool/call",
        ],
        listTools: async () => [...catalog.values()],
        async callTool(name, args, options = {}) {
          const callSignal = options.signal || signal;
          if (!catalog.has(name))
            throw Error("本机 Codex 没有开放该 WAAO 工具。");
          signal.throwIfAborted();
          callSignal.throwIfAborted();
          beforeDispatch?.({ method: "tools/call", params: { name } });
          callSignal.addEventListener("abort", abort, { once: true });
          try {
            const result = await native.request("mcpServer/tool/call", {
              threadId,
              server: waaoName,
              tool: name,
              arguments: args,
              ...registeredEnvironment,
            });
            if (!Array.isArray(result.content))
              throw Error("WAAO 返回的工具结果不完整。");
            return result;
          } catch (error) {
            if (
              /\b401\b|invalid_token|not logged in|authentication required/i.test(
                error.message,
              )
            )
              throw signIn();
            throw error;
          } finally {
            callSignal.removeEventListener("abort", abort);
          }
        },
        close,
      };
    } catch (error) {
      await close();
      runtime.reset();
      if (
        signal.aborted ||
        connectorFailure(error) === "protocol" ||
        [
          "WAAO_CODEX_AUTH",
          "WAAO_CODEX_MISSING",
          "ENOENT",
          "CODEX_VERSION_MISMATCH",
        ].includes(error.code)
      )
        throw error;
      throw Object.assign(
        Error("本机 Codex 的 WAAO 连接暂不可用，请测试连接。"),
        { code: "WAAO_CODEX_UNAVAILABLE" },
      );
    }
  }
}
