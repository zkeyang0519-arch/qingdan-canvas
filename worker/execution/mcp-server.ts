import { McpServer } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../types";
import { check, HttpError } from "../http";
import {
  executionToolNames,
  executionToolSchemas,
  type ExecutionToolName,
} from "../../shared/agent/execution";
import {
  executionPrincipal,
  mintExecutionToken,
  type ExecutionPrincipal,
} from "./execution-auth";
export async function callExecutionHub(
  env: Env,
  p: ExecutionPrincipal,
  action: string,
  input: unknown,
  name?: string,
) {
  const response = await env.RUNNER_HUBS.get(
    env.RUNNER_HUBS.idFromName(p.runnerId),
  ).fetch("https://runner/execution/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ principal: p, input, name }),
  });
  const value = (await response.json()) as Record<string, unknown>;
  check(
    response.ok,
    typeof value.error === "string" ? value.error : "执行请求失败。",
    response.status,
  );
  return value;
}
export async function serveExecutionMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const p = await executionPrincipal(request, env),
    hostname = new URL(request.url).hostname;
  return createMcpHandler(
    () => {
      const server = new McpServer({
        name: "qingdan-executor",
        version: "1.0.0",
      });
      for (const name of executionToolNames)
        server.registerTool(
          name,
          {
            description: name,
            inputSchema: executionToolSchemas[name],
            annotations: {
              readOnlyHint: ["codex_get_run", "codex_list_projects"].includes(
                name,
              ),
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          async (input: unknown) => {
            try {
              const result = await callExecutionHub(
                env,
                p,
                "tool",
                input,
                name,
              );
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(result) },
                ],
                structuredContent: result,
              };
            } catch (e) {
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: e instanceof HttpError ? e.message : "执行请求失败。",
                  },
                ],
                structuredContent: {
                  error: e instanceof HttpError ? e.message : "执行请求失败。",
                  status: e instanceof HttpError ? e.status : 500,
                },
              };
            }
          },
        );
      return server;
    },
    {
      route: "/executor-mcp",
      corsOptions: false,
      allowedHostnames: [hostname],
      allowedOriginHostnames: [hostname],
      legacy: "stateless",
      responseMode: "auto",
    },
  )(request, env, ctx);
}
export async function bridgeExecutionTool(
  env: Env,
  ctx: ExecutionContext,
  p: ExecutionPrincipal,
  name: ExecutionToolName,
  args: Record<string, unknown>,
) {
  const credential = await mintExecutionToken(env, p),
    endpoint = "https://execution.internal/executor-mcp";
  let requests = 0;
  const internalFetch: typeof fetch = async (input, init) => {
    check(++requests <= 12, "执行传输请求过多。", 429);
    const request = new Request(input, init);
    check(request.url === endpoint, "执行传输地址无效。", 403);
    request.headers.set("Host", "execution.internal");
    request.headers.set("Authorization", "Bearer " + credential);
    return serveExecutionMcp(request, env, ctx);
  };
  const client = new Client({
    name: "qingdan-browser-bridge",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: internalFetch,
  });
  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: 10000 },
    );
    if (result.isError) {
      const error = result.structuredContent as
        { status?: number; error?: string } | undefined;
      throw new HttpError(
        error?.status || 400,
        error?.error || "执行工具请求无效。",
      );
    }
    return {
      result: result.structuredContent,
      tool: name,
      transport: "streamable-http",
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "执行传输或工具请求无效。");
  } finally {
    await client.close();
  }
}
