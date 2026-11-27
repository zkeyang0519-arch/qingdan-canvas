// Public diagnostics only. Provider bodies and credentials are never copied
// into the task card or a model retry prompt.
export function modelIssue(
  value = {},
  { model = "", service = "模型服务" } = {},
) {
  if (value.issue?.code) return value.issue;
  const raw = String(value.errorMessage || value.body || value.message || "");
  const status =
    Number(value.status || raw.match(/\b([45]\d\d)\b/)?.[1]) || undefined;
  const label = String(service || "模型服务").slice(0, 60);
  const result = (code, message, retryable = false) => ({
    code,
    message,
    retryable,
    status,
    model,
    service: label,
    source: "model",
  });
  if (status === 402 || /insufficient[_ ]balance|余额不足/i.test(raw))
    return result(
      "MODEL_BALANCE_INSUFFICIENT",
      `${label}返回余额不足（402）。请检查该模型服务的 API 额度，或选择有额度的模型连接；已有任务成果已保存。`,
    );
  if (
    /client_not_allowed/i.test(raw) ||
    (status === 403 && /仅支持编程客户端/.test(raw))
  )
    return result(
      "MODEL_CLIENT_NOT_ALLOWED",
      `${label}未允许轻单使用此密钥（client_not_allowed），请核对支持的客户端。`,
    );
  if (status === 401)
    return result(
      "MODEL_AUTH_FAILED",
      `${label}未接受访问凭据（401），请在模型设置中核对连接。`,
    );
  if (status === 403)
    return result(
      "MODEL_ACCESS_DENIED",
      `${label}拒绝了本次请求（403），请核对当前连接的模型和接口权限。`,
    );
  if (status === 404 || /model_not_found|model[^\n]*not found/i.test(raw))
    return result(
      "MODEL_NOT_FOUND",
      `${label}未找到模型 ${model}，请核对该账号可用的模型 ID。`,
    );
  if (status === 429)
    return result(
      "MODEL_RATE_LIMITED",
      `${label}当前限流（429）。已有进度已保存，可稍后从当前步骤重试。`,
      true,
    );
  if (status && status >= 500)
    return result(
      "MODEL_UNAVAILABLE",
      `${label}模型服务暂时不可用（${status}），已有进度已保存。`,
      true,
    );
  if (
    /context[_ ](?:length|window)|maximum context|too many tokens|上下文(?:超出|超过|容量)|超过.{0,20}上下文/i.test(
      raw,
    )
  )
    return result(
      "MODEL_CONTEXT_TOO_LARGE",
      `${label}的单次上下文超出容量，需重新组织当前步骤的输入；完整成果仍保存在任务中。`,
    );
  if (
    value.stopReason === "length" ||
    /max[_ ](?:output[_ ])?tokens|output.*limit/i.test(raw)
  )
    return result(
      "MODEL_OUTPUT_INCOMPLETE",
      `${label}的回复达到输出长度限制，尚未交付完整结果。`,
    );
  if (/timed?\s*out|timeout|ETIMEDOUT/i.test(raw))
    return result(
      "MODEL_TIMEOUT",
      `${label}本次响应超时，已有进度已保存。`,
      true,
    );
  if (
    /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|network|connection error/i.test(
      raw,
    )
  )
    return result(
      "MODEL_NETWORK_ERROR",
      `连接${label}时发生网络错误，已有进度已保存。`,
      true,
    );
  return null;
}

export function issueError(issue) {
  return Object.assign(new Error(issue.message), {
    code: issue.code,
    status: issue.status,
    issue,
  });
}

export function interruptedRun(signal) {
  if (signal?.reason?.name === "TimeoutError")
    return issueError({
      code: "RUN_TIMEOUT",
      source: "runtime",
      retryable: true,
      message:
        "本轮运行达到单段时限，已保存检查点；任务尚未完成，可从当前步骤继续。",
    });
  return issueError({
    code: "RUN_INTERRUPTED",
    source: "runtime",
    retryable: true,
    message: "已停止本轮执行，当前步骤和回执已保存。",
  });
}
