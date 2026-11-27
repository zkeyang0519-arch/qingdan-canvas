// Conservative, provider-independent estimate. Non-ASCII text is not treated
// as four characters per token. Exact provider usage is recorded separately.
export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const ascii = (text.match(/[\x00-\x7f]/g) || []).length;
  return Math.ceil(ascii / 3 + (text.length - ascii));
}

function blocks(messages) {
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "toolResult") continue;
    const block = [message];
    const calls =
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((p) => p.type === "toolCall")
        : [];
    if (calls.length) {
      while (messages[i + 1]?.role === "toolResult") block.push(messages[++i]);
      // Never send orphan tool calls after checkpoint trimming.
      if (!calls.every((c) => block.some((m) => m.toolCallId === c.id)))
        continue;
    }
    result.push(block);
  }
  return result;
}

export function replayWindow(messages, limit = 36000) {
  const kept = [];
  let size = 0;
  for (const block of blocks(messages).reverse()) {
    const length = JSON.stringify(block).length;
    if (size + length > limit) continue;
    kept.unshift(...block);
    size += length;
  }
  return kept;
}

export function contextBudget(
  contextWindow = 65536,
  outputTokens = 8192,
  specs = [],
) {
  return Math.max(
    256,
    contextWindow - outputTokens - estimateTokens(specs) - 6000,
  );
}

export function packMessages(
  messages,
  tokenBudget,
  targetBudget = tokenBudget,
) {
  if (estimateTokens(messages) <= Math.min(tokenBudget, targetBudget))
    return messages;
  const groups = blocks(messages);
  const lastUser = groups.findLastIndex((g) => g[0].role === "user");
  // Host checkpoint and current user input are mandatory. Older raw tool
  // output can be retrieved by evidence id; it must not displace the task.
  const pinned = new Set();
  groups.forEach((g, i) => {
    const text = typeof g[0].content === "string" ? g[0].content : "";
    if (i === lastUser || text.startsWith("轻单保存的任务检查点"))
      pinned.add(i);
  });
  const selected = new Set(pinned);
  let used = [...pinned].reduce((n, i) => n + estimateTokens(groups[i]), 0);
  if (used > tokenBudget)
    throw Error(
      "当前输入和任务关键资料超过所选模型的上下文容量，请缩短输入或选择更大上下文的模型；已保存成果不会删除。",
    );
  // Keep the most recent complete exchange when it fits the real model window.
  // A soft working-set target never rejects a valid mandatory input.
  const last = groups.length - 1;
  if (
    last >= 0 &&
    !selected.has(last) &&
    used + estimateTokens(groups[last]) <= tokenBudget
  ) {
    selected.add(last);
    used += estimateTokens(groups[last]);
  }
  const workingBudget = Math.min(tokenBudget, Math.max(targetBudget, used));
  for (let i = groups.length - 1; i >= 0; i--) {
    if (selected.has(i)) continue;
    const tokens = estimateTokens(groups[i]);
    if (used + tokens > workingBudget) continue;
    selected.add(i);
    used += tokens;
  }
  return groups.flatMap((g, i) => (selected.has(i) ? g : []));
}

export function compactControlMessages(messages) {
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const name = message.toolName || message.name;
    if (!["update_task", "request_capability", "submit_result"].includes(name))
      return message;
    let data;
    try {
      data = JSON.parse(
        message.content?.find((p) => p.type === "text")?.text || "",
      );
    } catch {
      return message;
    }
    const compact =
      name === "request_capability"
        ? {
            status: data.status,
            name: data.name,
            message: data.message,
            loaded: data.status === "ready",
          }
        : {
            status: data.status,
            accepted: data.accepted,
            failures: data.failures,
            plan: data.plan && {
              revision: data.plan.revision,
              status: data.plan.status,
              canConfirm: data.plan.canConfirm,
            },
            blockers: data.blockers,
            progress: data.progress,
          };
    return {
      ...message,
      content: [{ type: "text", text: JSON.stringify(compact) }],
    };
  });
}
export function semanticResult(value) {
  if (Array.isArray(value)) return value.map(semanticResult);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(?:request_?id|trace_?id|timestamp|checked_?at|observed_?at|server_?time|updated_?at)$/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, semanticResult(item)]),
    );
  if (typeof value === "string") {
    try {
      return semanticResult(JSON.parse(value));
    } catch {}
    return value.replace(
      /(?:request_id|request id|trace_id)\s*[:=]\s*[\w-]+/gi,
      "request_id:[omitted]",
    );
  }
  return value;
}

export function artifactContext(task, maxTokens = 8000) {
  const artifacts = [];
  let used = 0;
  for (const a of [...(task?.artifacts || [])].reverse()) {
    const remaining = Math.max(0, maxTokens - used);
    const excerpt = a.text?.slice(0, Math.min(12000, remaining));
    const entry = {
      id: a.id,
      title: a.title,
      evidenceId: a.evidenceId,
      contentHash: a.contentHash,
      resource: a.resource,
      text: excerpt,
      truncated: !!a.text && excerpt.length < a.text.length,
    };
    if (estimateTokens(entry) + used > maxTokens) continue;
    artifacts.unshift(entry);
    used += estimateTokens(entry);
    if (artifacts.length >= 8) break;
  }
  return artifacts;
}
