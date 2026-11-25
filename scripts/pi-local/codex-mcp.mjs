import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { codexRuntime } from "./codex-runtime.mjs";
import { defaultAdapter } from "./connector-policy.mjs";

export const codexMcpId = "builtin-codex";
const key = (value) => createHash("sha256").update(value).digest("hex");
const issues = {
  ENOENT:
    "没有找到本机 Codex，请安装 Codex CLI，或配置 QINGDAN_CODEX_BIN 后重启轻单。",
  CODEX_VERSION_MISMATCH: "当前 Codex CLI 版本尚未通过此连接器的协议验证。",
  CONNECTOR_PROTOCOL: "Codex 接口发生变化，正在检查连接器适配。",
  CONNECTOR_REPAIR_BLOCKED: "自动适配未通过，请在工具面板查看诊断后重试。",
  CODEX_LOGIN_REQUIRED: "请先在这台电脑登录 Codex，再点击「测试连接」。",
  CODEX_UNAVAILABLE:
    "本机 Codex app-server 未就绪，请检查 Codex 安装和登录状态后重试。",
};
export function codexConnectionIssue(error) {
  return Object.hasOwn(issues, error?.code) ? issues[error.code] : null;
}

export function localCodexMcp(directory, options = {}) {
  const adapter = path.resolve(directory, "codex-mcp-server.mjs");
  const runtime = codexRuntime(options);
  let inspected;
  return {
    maintenanceStatus: () =>
      options.maintenance?.status(inspected?.fingerprint),
    retryMaintenance: () => options.maintenance?.retry(inspected?.fingerprint),
    async connect(signal, beforeDispatch, scope) {
      const identity = (inspected = await runtime.inspect());
      const open = (patch, probeSignal) =>
        connectOnce(identity, patch, probeSignal, beforeDispatch, scope);
      const validate = (patch, probeSignal) =>
        connectOnce(identity, patch, probeSignal);
      return options.maintenance
        ? options.maintenance.connect({
            ...identity,
            kind: "codex",
            open,
            validate,
            signal,
          })
        : open(defaultAdapter, signal);
    },
  };
  async function connectOnce(identity, patch, signal, beforeDispatch, scope) {
    const project = path.resolve(
      directory,
      "codex-mcp",
      scope ? key(scope.accountId + "/" + scope.bindingId) : "probe",
    );
    const cwd = path.join(project, "work");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const launch = {
      command: identity.command,
      args: runtime.args,
      adapter: patch,
      stdioTransport: identity.stdioTransport,
      cwd,
      ...(scope && {
        chatDir: path.join(project, "chats", key(scope.chatId)),
        userMessageId: scope.userMessageId,
        visible: scope.visible,
      }),
    };
    signal.throwIfAborted();
    const transport = new StdioTransport({
      command: process.execPath,
      args: [adapter],
      cwd,
      inheritEnv: false,
      env: {
        ...runtime.env,
        QINGDAN_CODEX_MCP_LAUNCH: JSON.stringify(launch),
      },
    });
    const client = new McpClient({
      name: "qingdan-pi",
      version: "1",
      requestTimeoutMs: 25000,
    });
    const abort = () => {
      void client.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    async function close() {
      signal.removeEventListener("abort", abort);
      await client.close();
    }
    try {
      await client.connect(transport);
      signal.throwIfAborted();
    } catch {
      await close().catch(() => {});
      const code = transport.stderr.match(/QD_CODEX_STATUS=(\w+)/)?.[1];
      const encoded = transport.stderr.match(/QD_CODEX_DIAGNOSTIC=(.+)/)?.[1];
      let diagnostic;
      try {
        diagnostic = encoded && JSON.parse(encoded);
      } catch {
        /* Invalid diagnostics never become model input. */
      }
      runtime.reset();
      throw Object.assign(Error(issues[code] || issues.CODEX_UNAVAILABLE), {
        code: code || "CODEX_UNAVAILABLE",
        ...(diagnostic && {
          method: diagnostic.method,
          rpcCode: diagnostic.rpcCode,
          hint: diagnostic.field ? { field: diagnostic.field } : undefined,
        }),
      });
    }
    return {
      verifiedMethods: JSON.parse(
        transport.stderr.match(/QD_CODEX_VERIFIED=(.+)/)?.[1] || "[]",
      ),
      contractMethods: [
        "config/read",
        "thread/start",
        "thread/resume",
        "thread/read",
        "thread/turns/list",
        "thread/items/list",
        "turn/start",
        "turn/interrupt",
      ],
      listTools: (options) => client.listTools(options),
      callTool(name, args, options) {
        beforeDispatch?.({ method: "tools/call", params: { name } });
        return client.callTool(name, args, { ...options, timeoutMs: 480000 });
      },
      close,
    };
  }
}
