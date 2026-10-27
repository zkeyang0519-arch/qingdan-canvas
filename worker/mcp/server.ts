import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../types";
import type { McpPrincipal } from "./contracts";
import { registerTools } from "./tools";
export async function serveMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: McpPrincipal,
) {
  const host = new URL(request.url).hostname;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({
        name: "qingdan-canvas",
        version: "1.0.0",
      });
      registerTools(server, env, ctx, principal);
      return server;
    },
    {
      route: "/mcp",
      corsOptions: false,
      allowedHostnames: [host],
      allowedOriginHostnames: "*",
      legacy: "stateless",
      responseMode: "json",
    },
  );
  return handler(request, env, ctx);
}
