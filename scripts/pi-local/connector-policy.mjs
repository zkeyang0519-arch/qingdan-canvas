import { z } from "zod";

// Declarative aliases only. A proposal cannot change RPC operations, credentials,
// destinations, permissions, cwd, sandbox policy, or the host's validation rules.
export const requestFields = {
  "config/read": ["includeLayers"],
  "thread/read": ["threadId", "includeTurns"],
  "thread/resume": ["threadId"],
  "thread/turns/list": ["threadId", "cursor", "limit"],
  "thread/items/list": ["threadId", "turnId", "cursor", "limit"],
  "turn/start": ["threadId"],
  "turn/interrupt": ["threadId", "turnId"],
  "mcpServerStatus/list": [
    "threadId",
    "serverName",
    "detail",
    "cursor",
    "limit",
  ],
  "mcpServer/tool/call": ["threadId", "environmentId"],
};
export const responseFields = {
  "thread/start": ["thread.id"],
  "thread/resume": ["thread.id"],
  "thread/read": ["thread.id", "thread.turns"],
  "thread/turns/list": ["data", "nextCursor"],
  "thread/items/list": ["data", "nextCursor"],
  "turn/start": ["turn.id", "turn.status"],
  "mcpServerStatus/list": ["data", "nextCursor"],
};
const forbidden =
  /(?:__proto__|prototype|constructor|token|secret|password|api.?key|authorization|approval|sandbox|permission|credential|endpoint|url|cwd|config|account)/i;
const field = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){0,3}$/)
  .refine((value) => !forbidden.test(value), "不允许修改安全或凭据字段");
const mappings = z.record(z.string(), z.record(z.string(), field));
const schema = z.strictObject({
  format: z.literal(1),
  requests: mappings.default({}),
  responses: mappings.default({}),
});
export const defaultAdapter = Object.freeze({
  format: 1,
  requests: {},
  responses: {},
});
export const adapterContract = {
  format: 1,
  requests: requestFields,
  responses: responseFields,
};

export function validateAdapter(input) {
  if (JSON.stringify(input).length > 16000) throw Error("连接器补丁过大。");
  const adapter = schema.parse(input);
  for (const [direction, allowed] of [
    ["requests", requestFields],
    ["responses", responseFields],
  ]) {
    for (const [method, entries] of Object.entries(adapter[direction])) {
      if (!Object.hasOwn(allowed, method))
        throw Error("不允许适配此协议方法。");
      const targets = new Set();
      for (const [canonical, wire] of Object.entries(entries)) {
        if (!allowed[method].includes(canonical))
          throw Error("不允许适配此协议字段。");
        if (direction === "requests" && wire.includes("."))
          throw Error("请求字段只能在原层级改名。");
        if (targets.has(wire)) throw Error("协议字段映射有冲突。");
        targets.add(wire);
      }
    }
  }
  return adapter;
}

const get = (value, key) =>
  key
    .split(".")
    .reduce(
      (row, part) =>
        row && typeof row === "object" && Object.hasOwn(row, part)
          ? row[part]
          : undefined,
      value,
    );
function put(value, key, data) {
  const parts = key.split(".");
  let target = value;
  for (const part of parts.slice(0, -1)) {
    if (
      !target[part] ||
      typeof target[part] !== "object" ||
      Array.isArray(target[part])
    )
      target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = data;
}
export function mapRequest(adapter, method, params) {
  const result = structuredClone(params);
  for (const [canonical, wire] of Object.entries(
    adapter.requests[method] || {},
  )) {
    if (wire === canonical || !Object.hasOwn(params, canonical)) continue;
    if (Object.hasOwn(params, wire)) throw Error("协议请求字段映射冲突。");
    result[wire] = params[canonical];
    delete result[canonical];
  }
  return result;
}
export function mapResponse(adapter, method, value) {
  const result = structuredClone(value);
  for (const [canonical, wire] of Object.entries(
    adapter.responses[method] || {},
  )) {
    const data = get(value, wire);
    if (data === undefined)
      throw Object.assign(Error("协议响应缺少所需字段。"), {
        code: "CONNECTOR_PROTOCOL",
        method,
        hint: { field: wire, issue: "missing" },
      });
    put(result, canonical, data);
  }
  return result;
}
export function adaptNativeClient(native, input = defaultAdapter) {
  const adapter = validateAdapter(input);
  const request = native.request.bind(native);
  native.verifiedMethods = new Set();
  native.request = async (method, params) => {
    try {
      const result = mapResponse(
        adapter,
        method,
        await request(method, mapRequest(adapter, method, params)),
      );
      const shape = {
        "account/read": (value) =>
          value && typeof value === "object" && Object.hasOwn(value, "account"),
        "config/read": (value) =>
          value?.config &&
          typeof value.config === "object" &&
          !Array.isArray(value.config),
        "thread/start": (value) =>
          typeof value?.thread?.id === "string" && !!value.thread.id,
        "thread/resume": (value) =>
          typeof value?.thread?.id === "string" && !!value.thread.id,
        "mcpServerStatus/list": (value) => Array.isArray(value?.data),
        "turn/start": (value) =>
          typeof value?.turn?.id === "string" && !!value.turn.id,
      }[method];
      if (shape && !shape(result))
        throw Object.assign(Error("协议响应结构发生变化。"), {
          code: "CONNECTOR_PROTOCOL",
          method,
        });
      native.verifiedMethods.add(method);
      return result;
    } catch (error) {
      error.method ??= method;
      throw error;
    }
  };
  return native;
}

export function connectorFailure(error) {
  const code = error?.code;
  if (error?.name === "AbortError") return "cancelled";
  if (
    ["CODEX_LOGIN_REQUIRED", "WAAO_CODEX_AUTH"].includes(code) ||
    error?.status === 401 ||
    /\b401\b|invalid_token|not logged in|authentication required/i.test(
      error?.message || "",
    )
  )
    return "authorization";
  if (
    error?.status === 403 ||
    /permission denied|unauthorized tool|工具已停用|无权访问/i.test(
      error?.message || "",
    )
  )
    return "permission";
  if (
    [
      "CONNECTOR_PROTOCOL",
      "CODEX_VERSION_MISMATCH",
      "CODEX_PROTOCOL_ERROR",
    ].includes(code) ||
    [-32601, -32602].includes(error?.rpcCode)
  )
    return "protocol";
  if (["ENOENT", "CODEX_UNAVAILABLE"].includes(code)) return "installation";
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "CODEX_REQUEST_TIMEOUT",
      "CODEX_DISCONNECTED",
      "WAAO_CODEX_UNAVAILABLE",
    ].includes(code) ||
    /\b50[234]\b|fetch failed|network connection/i.test(error?.message || "")
  )
    return "network";
  return "unavailable";
}

export function protocolDiagnostic(error) {
  // Forward syntax facts, never raw upstream errors, request bodies or paths.
  const match = String(error?.message || "").match(
    /(?:missing|unknown|unrecognized|invalid|required)\s+(?:field|parameter|argument)\s+[`'"]?([a-zA-Z][a-zA-Z0-9_]{0,60})/i,
  );
  const method =
    Object.hasOwn(requestFields, error?.method) ||
    Object.hasOwn(responseFields, error?.method)
      ? error.method
      : "initialize";
  const hint =
    error?.hint?.field && /^[a-zA-Z][\w.]{0,80}$/.test(error.hint.field)
      ? error.hint.field
      : match?.[1];
  return {
    kind: connectorFailure(error),
    method,
    ...(Number.isInteger(error?.rpcCode) && { rpcCode: error.rpcCode }),
    ...(hint && !forbidden.test(hint) && { field: hint }),
  };
}
