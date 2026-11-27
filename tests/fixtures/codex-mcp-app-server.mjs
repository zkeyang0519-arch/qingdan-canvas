import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
const [directory, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  const override = path.join(directory, "codex-version.txt");
  const version = existsSync(override)
    ? readFileSync(override, "utf8").trim()
    : "0.171.0-alpha.13.2";
  console.log("codex-cli " + version);
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(
    existsSync(path.join(directory, "listen-only"))
      ? "--listen <URL> Supported: stdio://"
      : "--stdio",
  );
  process.exit(0);
}
if (
  existsSync(path.join(directory, "listen-only")) &&
  !args.includes("--listen")
)
  process.exit(2);
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
const record = (value) =>
  appendFileSync(
    path.join(directory, "events.jsonl"),
    JSON.stringify(value) + "\n",
  );
const file = (id) => path.join(directory, "thread-" + id + ".json");
const waaoFile = path.join(directory, "waao-registration.json");
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  const waao = existsSync(waaoFile)
    ? JSON.parse(readFileSync(waaoFile, "utf8"))
    : null;
  switch (method) {
    case "initialize":
      result = { userAgent: "fixture", codexHome: directory };
      break;
    case "account/read":
      result = {
        account: existsSync(path.join(directory, "logged-out"))
          ? null
          : { type: "chatgpt" },
        requiresOpenaiAuth: true,
      };
      break;
    case "config/read":
      if (existsSync(path.join(directory, "config-field.txt"))) {
        const expected = readFileSync(
          path.join(directory, "config-field.txt"),
          "utf8",
        ).trim();
        if (!Object.hasOwn(params, expected)) {
          send({
            id,
            error: { code: -32602, message: `missing field '${expected}'` },
          });
          continue;
        }
      }
      result = {
        config: {
          mcp_servers: {
            unrelated: { enabled: true },
            ...(waao && { [waao.name]: waao.entry }),
          },
        },
      };
      break;
    case "thread/start":
    case "thread/resume": {
      if (
        params.sandbox !== "read-only" ||
        params.approvalPolicy !== "never" ||
        params.config["mcp_servers.unrelated.enabled"] !== false
      )
        throw Error("unexpected delegation policy");
      if (
        waao &&
        (!params.ephemeral ||
          params.config["mcp_servers." + waao.name + ".enabled"] === false)
      )
        throw Error("unexpected MCP scope");
      const thread =
        method === "thread/start"
          ? { id: randomUUID(), cwd: params.cwd, history: [] }
          : JSON.parse(readFileSync(file(params.threadId)));
      writeFileSync(file(thread.id), JSON.stringify(thread));
      record({ method, thread: thread.id, cwd: thread.cwd });
      result = { thread };
      break;
    }
    case "mcpServerStatus/list":
      if (
        !waao ||
        params.serverName !== waao.name ||
        params.environmentId !== undefined ||
        !existsSync(file(params.threadId))
      )
        throw Error("unscoped MCP status request");
      result = {
        nextCursor: null,
        data: [
          {
            name: waao.name,
            environmentId: waao.runtimeEnvironment ?? null,
            httpOrigin: waao.origin,
            authStatus: "oAuth",
            runtimeStatus: "connected",
            toolsError: null,
            tools: Object.fromEntries(
              ["project_list", "canvas_list", "node_generate"].map((name) => [
                name,
                { name, inputSchema: { type: "object", properties: {} } },
              ]),
            ),
          },
        ],
      };
      break;
    case "mcpServer/tool/call":
      if (
        !waao ||
        params.server !== waao.name ||
        params.environmentId !== (waao.runtimeEnvironment ?? undefined) ||
        !existsSync(file(params.threadId))
      )
        throw Error("wrong MCP server");
      record({ method, tool: params.tool });
      if (waao.rejectCall) {
        send({
          id,
          error: { code: -32000, message: "fixture call interrupted" },
        });
        continue;
      }
      result = {
        content: [{ type: "text", text: '{"projects":[]}' }],
        structuredContent: { projects: [] },
      };
      break;
    case "turn/start": {
      const thread = JSON.parse(readFileSync(file(params.threadId)));
      const prompt = params.input[0].text;
      thread.history.push(prompt);
      writeFileSync(file(thread.id), JSON.stringify(thread));
      const turn = { id: randomUUID(), status: "inProgress", items: [] };
      record({ method, thread: thread.id, prompt });
      send({ id, result: { turn } });
      if (prompt === "进度检查") {
        send({
          method: "item/started",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: {
              id: "command-fixture",
              type: "commandExecution",
              command: "rg --files",
            },
          },
        });
        send({
          method: "item/started",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: {
              id: "reasoning-fixture",
              type: "reasoning",
              text: "不应成为操作行",
            },
          },
        });
      }
      if (prompt !== "等我取消") {
        send({
          method: "item/completed",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: {
              type: "agentMessage",
              id: randomUUID(),
              phase: "final_answer",
              text: thread.history.join("，"),
            },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: thread.id,
            turn: { ...turn, status: "completed" },
          },
        });
      }
      continue;
    }
    case "turn/interrupt":
      record({ method, thread: params.threadId });
      result = {};
      break;
    default:
      send({ id, error: { code: -32601, message: "unsupported" } });
      continue;
  }
  send({ id, result });
}
