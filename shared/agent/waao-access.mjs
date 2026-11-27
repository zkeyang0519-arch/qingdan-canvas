import { waaoIssuer, waaoProjectsUrl } from "./waao-endpoint.mjs";

const clean = (value) =>
  String(value || "")
    .replace(/Bearer\s+[^\s",]+|sk-[A-Za-z0-9_-]{12,}/gi, "[凭据已隐藏]")
    .replace(
      /((?:access_token|refresh_token|api_key|password)["']?\s*[=:]\s*["']?)[^\s"',&}]+/gi,
      "$1[已隐藏]",
    )
    .slice(0, 1200);
function actionUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      [waaoIssuer, new URL(waaoProjectsUrl).origin].includes(url.origin)
    )
      return url.href;
  } catch {}
  return waaoProjectsUrl;
}

export function waaoAccessIssue(value, forced = false) {
  if (!value || typeof value !== "object") return null;
  if (value.accessIssue) return waaoAccessIssue(value.accessIssue, true);
  let data = value.structuredContent || value;
  if (!value.structuredContent && Array.isArray(value.content)) {
    for (const part of value.content) {
      if (part.type !== "text") continue;
      try {
        data = JSON.parse(part.text);
        break;
      } catch {}
    }
  }
  if (!data || typeof data !== "object") return null;
  const error =
    data.error && typeof data.error === "object" ? data.error : data;
  const detail =
    error.data && typeof error.data === "object" ? error.data : error;
  const code = clean(
    detail.code ||
      error.code ||
      data.code ||
      (typeof data.error === "string" ? data.error : "") ||
      (forced ? "forbidden" : ""),
  ).slice(0, 80);
  if (
    !forced &&
    !/forbidden|permission|scope|approval_required|access_denied|not_authorized|insufficient_credit|budget_exceeded/i.test(
      code,
    )
  )
    return null;
  const message = clean(
    detail.message ||
      error.message ||
      data.message ||
      data.error_description ||
      "当前 WAAO 授权不允许此操作，请在 WAAO 核对应用权限和资源范围。",
  );
  const scopes =
    detail.requiredScopes ||
    detail.required_scopes ||
    detail.required_scope ||
    detail.scope ||
    data.requiredScopes;
  const requiredScopes = (
    Array.isArray(scopes)
      ? scopes
      : typeof scopes === "string"
        ? scopes.split(/\s+/)
        : []
  )
    .filter((s) => typeof s === "string")
    .map((s) => clean(s).slice(0, 80))
    .slice(0, 12);
  const kind = /approval/.test(code)
    ? "approval"
    : /credit|budget/.test(code)
      ? "budget"
      : "permission";
  return {
    code,
    message,
    requiredScopes,
    kind,
    actionLabel:
      kind === "approval"
        ? "在 WAAO 查看待批准操作"
        : kind === "budget"
          ? "在 WAAO 查看预算"
          : "在 WAAO 查看权限与资源范围",
    actionUrl: actionUrl(
      detail.approval_url ||
        detail.authorization_url ||
        detail.manage_url ||
        detail.action?.url ||
        data.actionUrl,
    ),
  };
}

export async function readWaaoAccessError(response) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    while (reader && bytes < 16384) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const part = chunk.value.subarray(0, 16384 - bytes);
      bytes += part.length;
      text += decoder.decode(part, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (reader) await reader.cancel().catch(() => {});
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = { message: clean(text.replace(/<[^>]*>/g, " ").trim()) };
  }
  return waaoAccessIssue(value, true) || waaoAccessIssue({}, true);
}
