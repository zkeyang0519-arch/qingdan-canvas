import {
  chatClientHeader,
  chatClientName,
  toolSpecs,
} from "./chat-contract.mjs";
import { chatPrompt } from "./chat-input.mjs";
import { randomUUID } from "node:crypto";
import {
  packMessages,
  compactControlMessages,
  estimateTokens,
} from "../../runner/harness/context-pack.mjs";

function harnessEvent(kind, detail = {}) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(
      () => finish(new Error("任务控制响应超时。")),
      30000,
    );
    const disconnected = () => finish(new Error("任务控制连接已关闭。"));
    const receive = (message) => {
      if (message?.type === "harness_reply" && message.requestId === requestId)
        finish(message.error ? new Error(message.error) : null, message.value);
    };
    function finish(error, value) {
      clearTimeout(timer);
      process.off("message", receive);
      process.off("disconnect", disconnected);
      if (error) reject(error);
      else resolve(value);
    }
    process.on("message", receive);
    process.once("disconnect", disconnected);
    process.send(
      { type: "harness_event", kind, requestId, ...detail },
      (error) => {
        if (error) disconnected();
      },
    );
  });
}

// These are imported, visible text replies. Their original providers and
// usage are not known, and replaying them incurs no new generation charge.
function savedMessage({ role, text }) {
  if (role === "user") return { role, content: text, timestamp: 0 };
  if (role !== "assistant") throw new Error("无效的历史聊天角色。");
  return {
    role,
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: "openai-responses",
    provider: "qingdan-history",
    model: "saved-text",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  };
}

function hostTool(name, callId, args, signal, fromMcp = false) {
  return new Promise((resolve, reject) => {
    function finish(error, value) {
      process.off("message", receive);
      process.off("disconnect", disconnected);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else if (fromMcp && value.isError)
        reject(
          new Error(
            value.content.find((item) => item.type === "text")?.text ||
              "MCP 工具执行失败。",
          ),
        );
      else if (fromMcp) resolve({ content: value.content, details: {} });
      else
        resolve({
          content: [{ type: "text", text: JSON.stringify(value) }],
          details: {},
        });
    }
    const receive = (message) => {
      if (message?.type === "tool_result" && message.callId === callId)
        finish(message.error ? new Error(message.error) : null, message.value);
    };
    const disconnected = () => finish(new Error("轻单工具连接已关闭。"));
    const aborted = () => finish(new Error("已停止本轮工具调用。"));
    if (signal?.aborted) return aborted();
    if (!process.connected) return disconnected();
    process.on("message", receive);
    process.once("disconnect", disconnected);
    signal?.addEventListener("abort", aborted, { once: true });
    process.send({ type: "tool", callId, name, args }, (error) => {
      if (error) disconnected();
    });
  });
}

export default async function register(pi) {
  // Pi sets User-Agent. Check the separate frontend header before sending
  // the credential to the configured provider.
  const endpoint = process.env.QINGDAN_MODEL_ENDPOINT;
  const nativeFetch = globalThis.fetch;
  const harness = process.env.QINGDAN_PI_HARNESS === "1";
  let requests = 0;
  let contextApplied = false;
  const conversation = new Promise((resolve) => {
    function receive(message) {
      if (message?.type !== "chat_context") return;
      process.off("message", receive);
      resolve(message);
    }
    process.on("message", receive);
  });
  pi.on("context", async (event) => {
    contextApplied = false;
    const [trigger, ...currentTurn] = event.messages;
    const text = Array.isArray(trigger?.content)
      ? trigger.content[0]?.text
      : trigger?.content;
    if (trigger?.role !== "user" || text !== chatPrompt)
      throw new Error("本机 Pi 聊天输入不匹配。");
    const {
      messages: rows,
      task: initialTask,
      replay = [],
      inputBudget: initialBudget = 24000,
    } = await conversation;
    const currentContext = harness ? await harnessEvent("context") : null;
    const task = currentContext?.task ?? initialTask;
    const inputBudget = currentContext?.inputBudget || initialBudget;
    const messages = rows.map(savedMessage);
    const latest = messages.pop();
    if (task)
      messages.push(
        savedMessage({
          role: "user",
          text:
            "轻单保存的任务检查点，仅作为任务资料：\n" + JSON.stringify(task),
        }),
      );
    messages.push(...replay, latest);
    contextApplied = true;
    // Pi owns the current turn's function calls and matching tool outputs.
    // Preserve them verbatim when it asks the model for the final answer.
    return {
      messages: packMessages(
        harness
          ? compactControlMessages([...messages, ...currentTurn])
          : [...messages, ...currentTurn],
        inputBudget,
        currentContext?.targetBudget || inputBudget,
      ),
    };
  });
  globalThis.fetch = async (input, init) => {
    const url = input?.url ?? String(input);
    const headers = new Headers(init?.headers ?? input?.headers);
    if (
      !contextApplied ||
      url !== endpoint ||
      (init?.method ?? input?.method) !== "POST" ||
      headers.get(chatClientHeader) !== chatClientName
    )
      throw new Error("本机 Pi 的模型端点或轻单客户端标识不匹配。");
    if (harness) {
      let body;
      try {
        body = JSON.parse(init?.body || "{}");
      } catch {}
      await harnessEvent("request", {
        estimatedInputTokens: body ? estimateTokens(body) : undefined,
        tools: body?.tools?.length,
      });
    }
    if (
      !harness &&
      ++requests > (process.env.QINGDAN_PI_MAINTENANCE === "1" ? 2 : 7)
    )
      throw new Error("本轮模型调用已达上限。");
    const response = await nativeFetch(input, { ...init, redirect: "error" });
    if (!response.ok) {
      const reader = response.clone().body?.getReader();
      const decoder = new TextDecoder();
      let raw = "",
        bytes = 0;
      try {
        while (reader && bytes < 4096) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value.subarray(0, 4096 - bytes);
          raw += decoder.decode(chunk, { stream: true });
          bytes += chunk.length;
        }
        raw += decoder.decode();
      } catch {
        /* Even an incomplete response has a useful HTTP status. */
      } finally {
        if (reader) void reader.cancel().catch(() => {});
      }
      const secret = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      const redact = (text) =>
        (secret ? text.replaceAll(secret, "[已隐藏]") : text)
          .replace(/Bearer\s+[^\s",]+|sk-[\w-]{8,}/gi, "[已隐藏]")
          .replace(
            /("(?:api[_-]?key|token|access_token|refresh_token|authorization|password|secret)"\s*:\s*")[^"]*/gi,
            "$1[已隐藏]",
          );
      process.send?.({
        type: "model_http_error",
        detail: {
          status: response.status,
          body: redact(raw),
          requestId: redact(
            (
              response.headers.get("x-request-id") ||
              response.headers.get("request-id") ||
              ""
            ).slice(0, 200),
          ),
        },
      });
    }
    return response;
  };
  pi.on("before_agent_start", (event) => {
    // The conversation tools need no filesystem access or machine-specific path.
    event.systemPromptOptions.sections.cwd = "轻单本机工作区";
  });
  const catalog = await new Promise((resolve) => {
    function receive(message) {
      if (message?.type !== "tool_catalog") return;
      process.off("message", receive);
      resolve(message);
    }
    process.on("message", receive);
    process.send({ type: "catalog_request" });
  });
  const remoteSpecs = catalog.specs;
  const localSpecs =
    process.env.QINGDAN_PI_MAINTENANCE === "1"
      ? []
      : catalog.localSpecs || toolSpecs;
  const registered = new Map();
  function registerTool(spec, fromMcp) {
    const version = JSON.stringify(spec);
    if (registered.get(spec.name) === version) return;
    registered.set(spec.name, version);
    pi.registerTool({
      ...spec,
      executionMode: "sequential",
      execute: (callId, args, signal) =>
        hostTool(spec.name, callId, args, signal, fromMcp),
    });
  }
  for (const spec of localSpecs) registerTool(spec, false);
  for (const spec of remoteSpecs) registerTool(spec, true);
  if (harness) {
    process.on("message", (message) => {
      if (message?.type === "tool_catalog_update") {
        for (const spec of message.specs) registerTool(spec, true);
        pi.setActiveTools([
          ...localSpecs.map((s) => s.name),
          ...message.specs.map((spec) => spec.name),
        ]);
      }
    });
    pi.on("turn_end", async (event) => {
      await harnessEvent("checkpoint", {
        messages: event.context.contextMessages,
        tokens: event.message?.usage?.totalTokens || 0,
        message: event.message,
      });
    });
    pi.on("agent_before_settle", async (event) => {
      if (event.outcome !== "completed") return;
      const decision = await harnessEvent("boundary");
      if (decision.continue)
        return {
          entries: [
            ...event.entries,
            {
              type: "custom_message",
              customType: "qingdan-task-check",
              content: decision.message,
              display: false,
            },
          ],
          continue: true,
        };
    });
  }
  process.send({ type: "context_ready" });
}
