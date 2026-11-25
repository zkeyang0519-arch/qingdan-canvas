export const CONNECTION_STORAGE = "director-studio-connection-v1";
export const DEFAULT_CONNECTION = Object.freeze({
  source: "custom",
  baseUrl: "",
  model: "",
  apiKey: "",
  timeout: 120,
  temperature: 0.6,
  maxTokens: 12000,
});

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function numeric(value, fallback) {
  if (value === undefined) return fallback;
  return typeof value === "number" ||
    (typeof value === "string" && value.trim())
    ? Number(value)
    : NaN;
}

// Keep only known fields. Invalid number strings become editable defaults;
// validateConnection must run on the submitted values before normalization.
export function normalizeConnection(value) {
  const input = record(value);
  const normalizedNumber = (value, fallback) => {
    const number = numeric(value, fallback);
    return Number.isFinite(number) ? number : fallback;
  };
  return {
    source: "custom",
    baseUrl: text(input.baseUrl),
    model: text(input.model),
    apiKey: text(input.apiKey),
    timeout: normalizedNumber(input.timeout, DEFAULT_CONNECTION.timeout),
    temperature: normalizedNumber(
      input.temperature,
      DEFAULT_CONNECTION.temperature,
    ),
    maxTokens: normalizedNumber(input.maxTokens, DEFAULT_CONNECTION.maxTokens),
  };
}

export function publicConnection(value) {
  const { baseUrl, model, timeout, temperature, maxTokens } =
    normalizeConnection(value);
  return { baseUrl, model, timeout, temperature, maxTokens };
}

export function validateModelUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("模型地址格式不正确。");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !host.includes(".") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(":") ||
    /(^|\.)(localhost|local|internal|lan|test|invalid)$/.test(host) ||
    host === "metadata.google.internal"
  )
    throw new Error(
      "模型地址需使用公开 HTTPS 域名，不支持内网、IP 或带密码的地址。",
    );
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/chat/completions"))
    url.pathname += "/chat/completions";
  return url.toString();
}

export function validateConnection(value) {
  const input = record(value);
  if (!text(input.apiKey) || !text(input.model))
    return "请填写模型名称与 API Key。";
  if (/[\r\n]/.test(text(input.apiKey)))
    return "API Key 格式不正确，请粘贴完整的单行密钥。";
  try {
    validateModelUrl(text(input.baseUrl));
  } catch (error) {
    return error.message;
  }
  const timeout = numeric(input.timeout, DEFAULT_CONNECTION.timeout);
  const temperature = numeric(
    input.temperature,
    DEFAULT_CONNECTION.temperature,
  );
  const maxTokens = numeric(input.maxTokens, DEFAULT_CONNECTION.maxTokens);
  if (![30, 60, 120].includes(timeout))
    return "单步骤超时请选择 30、60 或 120 秒。";
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    return "温度需为 0 到 2 之间的数字。";
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 65536)
    return "最大输出长度需为 256 到 65536 之间的整数。";
  return "";
}
