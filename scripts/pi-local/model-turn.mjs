import { modelIssue, issueError } from "../../shared/agent/model-issue.mjs";

export function readModelReply(message, modelId, service = "星驰") {
  const issue = modelIssue(message || {}, { model: modelId, service });
  const failure = (text) =>
    Object.assign(new Error(text), {
      code: issue?.code || "MODEL_INVALID_RESPONSE",
      issue: issue || {
        code: "MODEL_INVALID_RESPONSE",
        source: "model",
        retryable: false,
        model: modelId,
        service,
        message: text,
      },
    });
  if (message?.role === "assistant" && message.stopReason === "stop") {
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
    throw failure(service + " " + modelId + " 的回复为空。");
  }
  const error = message?.errorMessage || "";
  if (
    issue &&
    ![
      "MODEL_AUTH_FAILED",
      "MODEL_ACCESS_DENIED",
      "MODEL_CLIENT_NOT_ALLOWED",
      "MODEL_NOT_FOUND",
      "MODEL_UNAVAILABLE",
    ].includes(issue.code)
  )
    throw issueError(issue);
  if (
    /\bclient_not_allowed\b/i.test(error) ||
    (/\b403\b/.test(error) && error.includes("仅支持编程客户端"))
  )
    throw failure(
      service +
        "未允许轻单前端使用此密钥（client_not_allowed）。请核对支持的客户端。",
    );
  if (/\b401\b/.test(error))
    throw failure(
      service === "星驰"
        ? "星驰未接受本机密钥（401），请核对 .dev.vars.pi 中的 XINGCHI_API_KEY。"
        : service + "未接受本机密钥（401），请核对模型连接。",
    );
  if (/\b403\b/.test(error))
    throw failure(
      service +
        "拒绝了本次请求（403），请核对当前密钥所属分组的模型和接口权限。",
    );
  const unavailable = error.match(/\b(502|503|504)\b/);
  if (unavailable)
    throw failure(
      service + "模型服务暂时不可用（" + unavailable[1] + "），请稍后再发送。",
    );
  if (/\b404\b|model_not_found|model[^\n]*not found/i.test(error))
    throw failure(
      service + "未找到模型 " + modelId + "，请核对该账号可用的模型 ID。",
    );
  throw Object.assign(
    new Error(
      "本机 Pi 未收到" +
        service +
        " " +
        modelId +
        " 的完整回复，请核对模型连接。",
    ),
    {
      code: "MODEL_INVALID_RESPONSE",
      issue: {
        code: "MODEL_INVALID_RESPONSE",
        source: "model",
        retryable: false,
        model: modelId,
        service,
        message: "模型未返回完整的可交付回复，已有进度已保存。",
      },
    },
  );
}
