// Qingdan's stdio MCP server. Its backend speaks the official Codex app-server
// protocol. The launcher supplies the project and chat scope outside tool input.
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { CodexClient } from "../../runner/codex-client.ts";
import {
  adaptNativeClient,
  connectorFailure,
  protocolDiagnostic,
} from "./connector-policy.mjs";
import { listCodexTurnItems } from "../../runner/film/codex.mjs";
import { nativeActivityLine } from "../../shared/agent/task-activity.mjs";

const promptSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(32000),
});
const missingThread =
  "这段轻单聊天里没有可继续的 Codex 对话，请先使用「新建 Codex 对话」。";
const publicErrors = new Set([
  missingThread,
  "本次 Codex 对话未完成。",
  "Codex 没有返回最终答复。",
  "Codex 会话目录与当前项目不一致。",
  "Codex 未采用当前项目的只读设置。",
  "本轮 Codex 调用已停止。",
  "本次连接只用于检测 Codex。",
]);

function finalMessage(items) {
  const messages = items.filter(
    (item) => item.type === "agentMessage" && item.text?.trim(),
  );
  return (
    messages.findLast((item) => item.phase === "final_answer") ||
    messages.findLast((item) => item.phase == null)
  )?.text;
}

async function main() {
  const {
    cwd,
    chatDir,
    userMessageId,
    visible = [],
    command,
    args = [],
    adapter,
    stdioTransport,
  } = JSON.parse(process.env.QINGDAN_CODEX_MCP_LAUNCH);
  delete process.env.QINGDAN_CODEX_MCP_LAUNCH;
  const native = adaptNativeClient(
    new CodexClient({
      command,
      args,
      protocolPolicy: "probe",
      stdioTransport,
      shutdownTimeoutMs: 900,
      env: process.env,
    }),
    adapter,
  );
  let db,
    busy = false,
    closing,
    disconnected = false,
    active;
  const stopped = new AbortController();
  native.on("disconnect", () => {
    disconnected = true;
  });
  native.on("request", (packet) =>
    native.rejectRequest(packet.id, "请从轻单项目聊天中发起授权操作。"),
  );
  async function close() {
    if (!closing) {
      stopped.abort();
      closing = (async () => {
        if (active?.turn && !active.terminal && !disconnected)
          await native
            .request("turn/interrupt", {
              threadId: active.thread,
              turnId: active.turn,
            })
            .catch(() => {});
        await native.close().catch(() => {});
      })();
    }
    return closing;
  }
  try {
    await native.connect();
    const auth = await native.request("account/read", { refreshToken: false });
    if (!auth.account && auth.requiresOpenaiAuth !== false)
      throw Object.assign(Error("login"), { code: "CODEX_LOGIN_REQUIRED" });
    if (chatDir) {
      await mkdir(chatDir, { recursive: true, mode: 0o700 });
      db = new DatabaseSync(path.join(chatDir, "threads.sqlite"), {
        timeout: 5000,
      });
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS turns(id INTEGER PRIMARY KEY, thread TEXT NOT NULL,
          message TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);
        CREATE UNIQUE INDEX IF NOT EXISTS active_thread ON turns(thread) WHERE done=0;`);
    }
    const config = {
      "features.shell_tool": false,
      "features.apps": false,
      "features.plugins": false,
      "features.image_generation": false,
      web_search: "disabled",
    };
    // Native user-level MCP connections have their own permissions. Only the
    // explicitly selected Qingdan tool is being delegated for this conversation.
    const effective = await native.request("config/read", {
      cwd,
      includeLayers: false,
    });
    for (const name of Object.keys(effective.config?.mcp_servers || {}))
      config["mcp_servers." + name + ".enabled"] = false;
    process.stderr.write(
      "QD_CODEX_VERIFIED=" + JSON.stringify([...native.verifiedMethods]) + "\n",
    );
    const threadOptions = {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      sandbox: "read-only",
      approvalPolicy: "never",
      config,
    };
    const permittedMessages = JSON.stringify([...visible, userMessageId]);
    function lastThread() {
      const latest = db
        .prepare(
          `SELECT thread FROM turns WHERE message IN
        (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT 1`,
        )
        .get(permittedMessages);
      if (!latest) return null;
      const blocked = db
        .prepare(
          `SELECT 1 FROM turns WHERE thread=? AND
        (done=0 OR message NOT IN (SELECT value FROM json_each(?))) LIMIT 1`,
        )
        .get(latest.thread, permittedMessages);
      return blocked ? null : latest.thread;
    }

    async function run(continuation, prompt, requestSignal, onProgress) {
      if (!db || !userMessageId) throw Error("本次连接只用于检测 Codex。");
      const signal = AbortSignal.any([
        requestSignal,
        stopped.signal,
        AbortSignal.timeout(470000),
      ]);
      signal.throwIfAborted();
      const existing = continuation ? lastThread() : null;
      if (continuation && !existing) throw Error(missingThread);
      const startedThread = existing
        ? await native.request("thread/resume", {
            ...threadOptions,
            threadId: existing,
            excludeTurns: true,
          })
        : await native.request("thread/start", {
            ...threadOptions,
            ephemeral: false,
            selectedCapabilityRoots: [],
          });
      const { thread } = startedThread;
      if (
        (startedThread.sandbox && startedThread.sandbox.type !== "readOnly") ||
        (startedThread.approvalPolicy &&
          startedThread.approvalPolicy !== "never")
      )
        throw Error("Codex 未采用当前项目的只读设置。");
      if (
        !thread?.id ||
        (existing && thread.id !== existing) ||
        path.relative(await realpath(cwd), await realpath(thread.cwd)) !== ""
      )
        throw Error("Codex 会话目录与当前项目不一致。");
      signal.throwIfAborted();
      // A lost start/completion acknowledgement cannot be replayed into or
      // continued from a possibly running native conversation.
      const claim = db
        .prepare("INSERT INTO turns(thread,message) VALUES(?,?)")
        .run(thread.id, userMessageId);
      const completed = new Map(),
        replies = new Map();
      const job = { thread: thread.id, turn: null, terminal: false };
      active = job;
      function observe({ method, params }) {
        if (params?.threadId !== thread.id) return;
        if (!job.turn || !params.turnId || params.turnId === job.turn) {
          const line = nativeActivityLine({ method, params });
          if (line) onProgress?.(line);
        }
        if (method === "turn/started" && !job.turn) job.turn = params.turn?.id;
        if (method === "turn/completed" && params.turn?.id)
          completed.set(params.turn.id, params.turn);
        if (
          method === "item/completed" &&
          params.item?.type === "agentMessage"
        ) {
          if (!replies.has(params.turnId)) replies.set(params.turnId, []);
          replies.get(params.turnId).push(params.item);
        }
      }
      native.on("notification", observe);
      try {
        onProgress?.("Codex · turn/start");
        const started = await native.request("turn/start", {
          threadId: thread.id,
          clientUserMessageId: randomUUID(),
          cwd,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          input: [{ type: "text", text: prompt, text_elements: [] }],
        });
        if (!started.turn?.id || (job.turn && job.turn !== started.turn.id))
          throw Error("本次 Codex 对话未完成。");
        job.turn = started.turn.id;
        let terminal = started.turn;
        while (terminal.status === "inProgress" && !completed.has(job.turn)) {
          if (disconnected) throw Error("本次 Codex 对话未完成。");
          await delay(150, undefined, { signal });
        }
        terminal = completed.get(job.turn) || terminal;
        job.terminal = true;
        if (terminal.status !== "completed")
          throw Error("本次 Codex 对话未完成。");
        const live = [
          ...(terminal.items || []),
          ...(replies.get(job.turn) || []),
        ];
        const text =
          finalMessage(live) ||
          finalMessage(await listCodexTurnItems(native, thread.id, job.turn));
        if (!text) throw Error("Codex 没有返回最终答复。");
        db.prepare("UPDATE turns SET done=1 WHERE id=?").run(
          claim.lastInsertRowid,
        );
        return {
          content: [{ type: "text", text }],
          structuredContent: { threadId: thread.id, turnId: job.turn, text },
        };
      } finally {
        native.off("notification", observe);
        if (!job.terminal && job.turn && !closing && !disconnected)
          await native
            .request("turn/interrupt", {
              threadId: thread.id,
              turnId: job.turn,
            })
            .catch(() => {});
        active = null;
      }
    }

    serveStdio(() => {
      const mcp = new McpServer({ name: "qingdan-codex", version: "1.0.0" });
      for (const [name, title, description] of [
        [
          "codex",
          "新建 Codex 对话",
          "把当前任务交给本机 Codex，在当前项目独立的只读工作区开始新对话并取得答复。",
        ],
        [
          "codex-reply",
          "继续 Codex 对话",
          "让本机 Codex 继续这段轻单聊天中最近可见的 Codex 对话，保留它的原生上下文。",
        ],
      ]) {
        mcp.registerTool(
          name,
          { title, description, inputSchema: promptSchema },
          async ({ prompt }, ctx) => {
            if (busy)
              return {
                isError: true,
                content: [{ type: "text", text: "Codex 正在处理上一条请求。" }],
              };
            busy = true;
            let progress = 0;
            const token = ctx.mcpReq._meta?.progressToken;
            const onProgress = (message) => {
              if (token !== undefined && !ctx.mcpReq.signal.aborted)
                void ctx.mcpReq
                  .notify({
                    method: "notifications/progress",
                    params: {
                      progressToken: token,
                      progress: ++progress,
                      message,
                    },
                  })
                  .catch(() => {});
            };
            try {
              return await run(
                name === "codex-reply",
                prompt,
                ctx.mcpReq.signal,
                onProgress,
              );
            } catch (error) {
              const text =
                ctx.mcpReq.signal.aborted || stopped.signal.aborted
                  ? "本轮 Codex 调用已停止。"
                  : publicErrors.has(error.message)
                    ? error.message
                    : "没有取得本机 Codex 的答复，请检查 Codex 登录、网络和可用额度。";
              return { isError: true, content: [{ type: "text", text }] };
            } finally {
              busy = false;
            }
          },
        );
      }
      return mcp;
    });
    process.stdin.once("end", () => void close());
    process.once("SIGTERM", () => void close());
  } catch (error) {
    const status =
      connectorFailure(error) === "protocol"
        ? "CONNECTOR_PROTOCOL"
        : ["ENOENT", "CODEX_VERSION_MISMATCH", "CODEX_LOGIN_REQUIRED"].includes(
              error.code,
            )
          ? error.code
          : "CODEX_UNAVAILABLE";
    process.stderr.write("QD_CODEX_STATUS=" + status + "\n");
    process.stderr.write(
      "QD_CODEX_DIAGNOSTIC=" + JSON.stringify(protocolDiagnostic(error)) + "\n",
    );
    await close();
    process.exitCode = 1;
  }
}

await main();
