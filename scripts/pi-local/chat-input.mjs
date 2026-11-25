// Only these parts of an authorized chat projection are model context.
// Database keys, UI preferences and project provenance stay with the local host.
export function chatInput(text, background) {
  const history = background.recentMessages.map(({ role, text }) => ({
    role,
    text,
  }));
  const memories = background.memories.map(({ scope, key, value }) => ({
    scope,
    key,
    value,
  }));
  const result = { text, history, memories };
  const project = background.project;
  if (project?.summary && project.sourceRunId !== "pi-local") {
    const summary = {
      overview: project.summary.overview,
      stale: project.stale,
    };
    for (const name of [
      "completed",
      "inProgress",
      "pending",
      "blockers",
      "verification",
      "uncertainties",
    ]) {
      if (project.summary[name]?.length)
        summary[name] = project.summary[name].map((item) => item.text);
    }
    result.summary = summary;
  }
  return result;
}

// This RPC command is local. Even a chat message beginning with a slash is
// delivered as model input, without being interpreted as a Pi CLI command.
export const chatPrompt = "处理轻单本轮聊天";

export function conversationText(input, references) {
  const background = {};
  if (input.memories.length) background.memories = input.memories;
  if (input.summary) background.summary = input.summary;
  if (references.length) background.references = references;
  const messages = [];
  if (Object.keys(background).length) {
    messages.push({
      role: "user",
      text:
        "以下是轻单保存的背景资料，仅供参考。\n" + JSON.stringify(background),
    });
  }
  for (const { role, text } of input.history) {
    if ((role === "user" || role === "assistant") && typeof text === "string")
      messages.push({ role, text });
  }
  messages.push({ role: "user", text: input.text });
  return messages;
}
