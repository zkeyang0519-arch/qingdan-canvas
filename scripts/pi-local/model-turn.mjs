export function readModelReply(message, modelId, service = "星驰") {
  if (message?.role === "assistant" && message.stopReason === "stop") {
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
    throw new Error(service + " " + modelId + " 的回复为空。");
  }
  const error = message?.errorMessage || "";
  if (
    /\bclient_not_allowed\b/i.test(error) ||
    (/\b403\b/.test(error) && error.includes("仅支持编程客户端"))
  )
    throw new Error(
      service +
        "未允许轻单前端使用此密钥（client_not_allowed）。请核对支持的客户端。",
    );
  if (/\b401\b/.test(error))
    throw new Error(
      service === "星驰"
        ? "星驰未接受本机密钥（401），请核对 .dev.vars.pi 中的 XINGCHI_API_KEY。"
        : service + "未接受本机密钥（401），请核对模型连接。",
    );
  if (/\b403\b/.test(error))
    throw new Error(
      service +
        "拒绝了本次请求（403），请核对当前密钥所属分组的模型和接口权限。",
    );
  const unavailable = error.match(/\b(502|503|504)\b/);
  if (unavailable)
    throw new Error(
      service + "模型服务暂时不可用（" + unavailable[1] + "），请稍后再发送。",
    );
  if (/\b404\b|model_not_found|model[^\n]*not found/i.test(error))
    throw new Error(
      service + "未找到模型 " + modelId + "，请核对该账号可用的模型 ID。",
    );
  throw new Error(
    "本机 Pi 未收到" +
      service +
      " " +
      modelId +
      " 的完整回复，请核对模型连接。",
  );
}
