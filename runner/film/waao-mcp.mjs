import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { waaoMcpUrl } from "../../shared/agent/waao-endpoint.mjs";
export {
  waaoMcpUrl,
  waaoIssuer,
  waaoScopes,
} from "../../shared/agent/waao-endpoint.mjs";

const authNeeded = () =>
  Object.assign(
    Error("请打开轻单的「工具 → WAAO」，点击「连接 WAAO」完成官网授权。"),
    { status: 401 },
  );

// Both the project tool registry and the film workflow use the same official
// transport. The former needs native MCP results, the latter consumes their data.
export async function openWaaoMcp(
  { token, getToken, fetchImpl = fetch, onRejected },
  signal,
  beforeDispatch,
) {
  if (!(getToken ? await getToken() : token)) throw authNeeded();
  const client = new Client({ name: "qingdan-pi", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(waaoMcpUrl), {
    fetch: async (input, init) => {
      const dest = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (dest.href !== waaoMcpUrl)
        throw Error("WAAO MCP 请求地址与官网不符。");
      const bearer = getToken ? await getToken() : token;
      if (!bearer) throw authNeeded();
      const requestSignal = AbortSignal.any(
        [init?.signal, signal].filter(Boolean),
      );
      requestSignal.throwIfAborted();
      const packet = init?.method === "POST" ? JSON.parse(init.body) : null;
      if (packet) beforeDispatch?.(packet);
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Bearer " + bearer);
      const response = await fetchImpl(dest.href, {
        ...init,
        headers,
        redirect: "error",
        signal: requestSignal,
      });
      if (response.status === 401) {
        onRejected?.(bearer);
        await response.body?.cancel().catch(() => {});
        throw authNeeded();
      }
      if (response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw Object.assign(Error("当前 WAAO 账号或授权缺少此操作的权限。"), {
          status: 403,
          code:
            packet?.method === "tools/call"
              ? "WAAO_TOOL_FORBIDDEN"
              : "WAAO_FORBIDDEN",
        });
      }
      return response;
    },
  });
  async function close() {
    try {
      if (transport.sessionId) await transport.terminateSession();
    } catch {}
    await client.close().catch(() => {});
  }
  try {
    await client.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async listTools(options) {
      const tools = new Map(),
        seen = new Set();
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, options);
        for (const tool of page.tools) tools.set(tool.name, tool);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
          throw Error("WAAO MCP 工具目录分页无效。");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return [...tools.values()];
    },
    async callTool(name, args, options) {
      try {
        return await client.callTool(
          { name, arguments: args },
          { timeout: 90000, ...options },
        );
      } catch (error) {
        if (error.code !== "WAAO_TOOL_FORBIDDEN") throw error;
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
    },
    close,
  };
}

export async function withWaaoMcp(connection, signal, run) {
  const client = await openWaaoMcp(
    connection,
    signal,
    connection.beforeDispatch,
  );
  return useWaaoTools(client, signal, run, connection.allows);
}

export async function useWaaoTools(client, signal, run, allows) {
  try {
    const advertised = await client.listTools({ signal });
    const catalog = new Map(
      advertised
        .filter((tool) => !allows || allows(tool.name))
        .map((tool) => [tool.name, tool]),
    );
    return await run({
      catalog,
      call: async (name, args) => {
        if (!catalog.has(name))
          throw Error("当前 WAAO 授权未提供工具 " + name + "。");
        const result = await client.callTool(name, args, { signal });
        if (result.isError)
          throw Error(
            "WAAO 工具 " +
              name +
              " 执行失败：" +
              (
                result.content?.find((p) => p.type === "text")?.text ||
                "平台未返回详情"
              ).slice(0, 240),
          );
        if (result.structuredContent !== undefined)
          return result.structuredContent;
        const text = result.content
          ?.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        if (!text) throw Error("WAAO 工具没有返回可核对的结果。");
        try {
          return JSON.parse(text);
        } catch {
          return { text };
        }
      },
    });
  } finally {
    await client.close();
  }
}
