import {
  agentReplyJsonSchema,
  agentReplySchema,
  type AgentReply,
} from "../../shared/agent/chat";
import type { Env } from "../types";

const maxOutputTokens = 8192;
const maxResponseBytes = 1024 * 1024;
const requestTimeoutMs = 45_000;
const defaultBaseUrl = "https://api.openai.com/v1";

const errorMessages = {
  MODEL_NOT_CONFIGURED: "模型服务尚未配置或配置无效。",
  MODEL_AUTH_FAILED: "模型服务拒绝了访问凭据。",
  MODEL_RATE_LIMITED: "模型服务当前达到限额，请稍后重试。",
  MODEL_UNAVAILABLE: "模型服务暂时无法响应。",
  MODEL_TIMEOUT: "等待模型回复超时。",
  MODEL_REFUSED: "模型拒绝了本次请求。",
  MODEL_INCOMPLETE: "模型回复不完整，未生成建议。",
  MODEL_INVALID_RESPONSE: "模型回复格式无效，未生成建议。",
  MODEL_RESPONSE_TOO_LARGE: "模型回复超过大小限制。",
} as const;

export class ChatModelError extends Error {
  constructor(public readonly code: keyof typeof errorMessages) {
    super(errorMessages[code]);
    this.name = "ChatModelError";
  }
}

type ChatModelEnv = Pick<
  Env,
  "ROUTER_API_KEY" | "ROUTER_BASE_URL" | "ROUTER_MODEL" | "ROUTER_API_FORMAT"
>;
type ChatContext = {
  instructions: string;
  messages: readonly { role: "user" | "assistant"; content: string }[];
};
type Usage = { inputTokens: number; outputTokens: number };

function modelConfig(env: ChatModelEnv) {
  const model = env.ROUTER_MODEL?.trim() || null;
  const key = env.ROUTER_API_KEY?.trim() ?? "";
  const requestedFormat = env.ROUTER_API_FORMAT?.trim() || "responses";
  const format =
    requestedFormat === "responses" || requestedFormat === "chat_completions"
      ? requestedFormat
      : "invalid";
  const base = env.ROUTER_BASE_URL?.trim() || defaultBaseUrl;
  const authority = /^https:\/\/([^/?#\\]+)/iu.exec(base)?.[1];
  let url: URL | null = null;
  if (authority && !authority.includes("@") && !/[?#\\]/u.test(base))
    try {
      const parsed = new URL(base);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password)
        url = parsed;
    } catch {
      // Invalid configuration is reported without echoing the supplied URL.
    }
  return {
    model,
    key,
    format,
    url,
    configured:
      !!model && /^[!-~]+$/u.test(key) && format !== "invalid" && !!url,
  };
}

export function chatModelStatus(env: ChatModelEnv) {
  const { model, format, url, configured } = modelConfig(env);
  return { configured, model, format, host: url?.host ?? null };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ChatModelError("MODEL_INVALID_RESPONSE");
  }
}

async function readJson(response: Response, signal: AbortSignal) {
  if (Number(response.headers.get("Content-Length")) > maxResponseBytes) {
    void response.body?.cancel().catch(() => {});
    throw new ChatModelError("MODEL_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ChatModelError("MODEL_INVALID_RESPONSE");
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let bytes = 0;
    let value = "";
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      bytes += chunk.byteLength;
      if (bytes > maxResponseBytes)
        throw new ChatModelError("MODEL_RESPONSE_TOO_LARGE");
      value += decoder.decode(chunk, { stream: true });
    }
    signal.throwIfAborted();
    return parseJson(value + decoder.decode());
  } catch (error) {
    cancel();
    if (error instanceof ChatModelError) throw error;
    if (signal.aborted) throw new ChatModelError("MODEL_TIMEOUT");
    throw new ChatModelError("MODEL_INVALID_RESPONSE");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function responsesText(body: Record<string, unknown>): string {
  if (body.status === "failed") throw new ChatModelError("MODEL_UNAVAILABLE");
  if (
    body.status === "incomplete" &&
    asRecord(body.incomplete_details)?.reason === "content_filter"
  )
    throw new ChatModelError("MODEL_REFUSED");
  if (typeof body.status === "string" && body.status !== "completed")
    throw new ChatModelError("MODEL_INCOMPLETE");
  if (body.status !== "completed" || !Array.isArray(body.output))
    throw new ChatModelError("MODEL_INVALID_RESPONSE");
  const parts: string[] = [];
  for (const item of body.output) {
    const message = asRecord(item);
    if (message?.type === "reasoning") continue;
    if (
      message?.type !== "message" ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    )
      throw new ChatModelError("MODEL_INVALID_RESPONSE");
    if (message.status !== undefined && message.status !== "completed")
      throw new ChatModelError("MODEL_INCOMPLETE");
    for (const item of message.content) {
      const part = asRecord(item);
      if (part?.type === "refusal") throw new ChatModelError("MODEL_REFUSED");
      if (part?.type !== "output_text" || typeof part.text !== "string")
        throw new ChatModelError("MODEL_INVALID_RESPONSE");
      parts.push(part.text);
    }
  }
  return parts.join("");
}

function completionsText(body: Record<string, unknown>): string {
  const choice = Array.isArray(body.choices)
    ? asRecord(body.choices[0])
    : undefined;
  const message = asRecord(choice?.message);
  const toolCalls = message?.tool_calls;
  if (choice?.finish_reason === "content_filter" || message?.refusal)
    throw new ChatModelError("MODEL_REFUSED");
  if (choice?.finish_reason === "length")
    throw new ChatModelError("MODEL_INCOMPLETE");
  if (
    choice?.finish_reason !== "stop" ||
    message?.role !== "assistant" ||
    typeof message.content !== "string" ||
    (toolCalls != null &&
      (!Array.isArray(toolCalls) || toolCalls.length > 0)) ||
    message.function_call != null
  )
    throw new ChatModelError("MODEL_INVALID_RESPONSE");
  return message.content;
}

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function responseUsage(value: unknown, responses: boolean): Usage | undefined {
  const usage = asRecord(value);
  const input = usage?.[responses ? "input_tokens" : "prompt_tokens"];
  const output = usage?.[responses ? "output_tokens" : "completion_tokens"];
  if (tokenCount(output) && output > maxOutputTokens)
    throw new ChatModelError("MODEL_RESPONSE_TOO_LARGE");
  if (tokenCount(input) && tokenCount(output))
    return { inputTokens: input, outputTokens: output };
}

function responseError(status: number): ChatModelError {
  if (status === 401 || status === 403)
    return new ChatModelError("MODEL_AUTH_FAILED");
  if (status === 429) return new ChatModelError("MODEL_RATE_LIMITED");
  if (status === 408) return new ChatModelError("MODEL_TIMEOUT");
  return new ChatModelError("MODEL_UNAVAILABLE");
}

export async function generateChatReply(
  env: ChatModelEnv,
  context: ChatContext,
  fetcher = fetch,
): Promise<{ reply: AgentReply; usage?: Usage }> {
  const config = modelConfig(env);
  if (!config.configured || !config.url)
    throw new ChatModelError("MODEL_NOT_CONFIGURED");
  const responses = config.format === "responses";
  const endpoint = config.url;
  const deepseek = endpoint.hostname === "api.deepseek.com";
  const path = responses ? "responses" : "chat/completions";
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/${path}`;
  const request = responses
    ? {
        model: config.model,
        store: false,
        instructions: context.instructions,
        input: context.messages,
        max_output_tokens: maxOutputTokens,
        text: {
          format: {
            type: "json_schema",
            name: "agent_reply",
            strict: true,
            schema: agentReplyJsonSchema,
          },
        },
      }
    : {
        model: config.model,
        messages: [
          {
            role: "system",
            content: [
              context.instructions,
              "只返回一个符合以下结构的 JSON 对象，不添加 Markdown 代码围栏。",
              JSON.stringify(agentReplyJsonSchema),
              '无建议时的 JSON 示例：\n{"text":"我们可以先明确目标。","tasks":[],"memories":[]}',
            ].join("\n\n"),
          },
          ...context.messages,
        ],
        ...(deepseek
          ? { max_tokens: maxOutputTokens, thinking: { type: "disabled" } }
          : { max_completion_tokens: maxOutputTokens }),
        response_format: { type: "json_object" },
      };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ChatModelError("MODEL_TIMEOUT"));
      controller.abort();
    }, requestTimeoutMs);
  });
  const generate = async () => {
    const response = await fetcher(endpoint, {
      method: "POST",
      // Workerd supports manual/follow. The status check below rejects redirects
      // without sending credentials or conversation history to the target.
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw responseError(response.status);
    }
    const body = asRecord(await readJson(response, controller.signal));
    if (!body) throw new ChatModelError("MODEL_INVALID_RESPONSE");
    const content = responses ? responsesText(body) : completionsText(body);
    const reply = agentReplySchema.safeParse(parseJson(content));
    if (!reply.success) throw new ChatModelError("MODEL_INVALID_RESPONSE");
    const usage = responseUsage(body.usage, responses);
    return { reply: reply.data, ...(usage ? { usage } : {}) };
  };
  try {
    return await Promise.race([generate(), deadline]);
  } catch (error) {
    if (error instanceof ChatModelError) throw error;
    throw new ChatModelError("MODEL_UNAVAILABLE");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
