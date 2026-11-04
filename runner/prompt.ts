import type {
  AcceptanceCriterion,
  ExecutionSnapshot,
} from "../shared/agent/contracts";
const strings = { type: "array", items: { type: "string" } };
const summaryItems = {
  type: "array",
  items: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};
export function outputSchema(kind: ExecutionSnapshot["kind"]) {
  const properties =
    kind === "summary"
      ? {
          overview: { type: "string" },
          completed: summaryItems,
          inProgress: summaryItems,
          pending: summaryItems,
          blockers: summaryItems,
          verification: summaryItems,
          uncertainties: summaryItems,
        }
      : {
          outcome: {
            type: "string",
            enum: ["done", "blocked", "needs_input", "failed"],
          },
          summary: { type: "string" },
          changedFiles: strings,
          evidenceRefs: strings,
          remainingIssues: strings,
          nextTaskNotes: strings,
        };
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
function criterionText(criterion: AcceptanceCriterion, index: number) {
  const lines = [
    `${index + 1}. ${criterion.required ? "" : "可选："}${criterion.description}`,
  ];
  if (criterion.kind === "artifact") {
    lines.push(`   验收文件：${criterion.relativePath}`);
    if (criterion.predicate.type === "exists") lines.push("   文件必须存在。");
    if (criterion.predicate.type === "textContains")
      lines.push(`   文件内容应包含：${criterion.predicate.text}`);
    if (criterion.predicate.type === "jsonSchema")
      lines.push(
        `   文件内容应符合以下 JSON 结构约束：\n${JSON.stringify(criterion.predicate.schema, null, 2)}`,
      );
  }
  return lines.join("\n");
}

export function runTitle(snapshot: ExecutionSnapshot) {
  const title =
    snapshot.kind === "summary"
      ? "项目总结"
      : snapshot.task.text.trim().replace(/\s+/gu, " ");
  const characters = Array.from(title || "执行任务");
  return `轻单 · ${characters.slice(0, 40).join("")}${characters.length > 40 ? "…" : ""}`;
}

// The execution envelope stays in Runner state and protocol fields. The model
// receives only the human task and relevant context, never authority/hash IDs.
export function runPrompt(snapshot: ExecutionSnapshot, message?: string) {
  const parts: string[] = [];
  if (message !== undefined) {
    parts.push("请继续当前任务。", `补充要求：\n${message}`);
    if (snapshot.kind === "summary")
      parts.push("本轮仍然只读检查，不修改文件或实施任务。");
    else
      parts.push(
        "沿用当前会话的任务背景和完成标准，结合以上补充要求继续处理。",
      );
  } else {
    if (snapshot.kind === "summary") {
      parts.push(
        "请只读检查当前项目，整理一份项目进度总结。",
        "请说明项目现状、已经完成和正在进行的工作、待办事项、阻碍、已有验证证据以及尚不确定的内容。不要修改文件或实施任务。",
      );
    } else {
      parts.push("请在当前项目中完成以下任务。");
      if (snapshot.task.text.trim() !== snapshot.task.instruction.trim())
        parts.push(`任务：${snapshot.task.text}`);
      parts.push(
        `执行要求：\n${snapshot.task.instruction}`,
        `完成标准：\n${snapshot.task.acceptance.map(criterionText).join("\n")}`,
      );
    }
    const summary = snapshot.context.projectSummary;
    if (summary) {
      const background = [summary.overview];
      for (const [key, label] of [
        ["completed", "已完成"],
        ["inProgress", "进行中"],
        ["pending", "待处理"],
        ["blockers", "阻碍"],
        ["verification", "已有验证"],
        ["uncertainties", "待核实"],
      ] as const) {
        if (summary[key].length)
          background.push(
            `${label}：\n${summary[key].map((item) => `- ${item.text}`).join("\n")}`,
          );
      }
      parts.push(
        `已有项目背景（供核对，以当前项目实际情况为准）：\n${background.join("\n")}`,
      );
    }
    if (snapshot.context.decisions.length)
      parts.push(
        `已确定的要求：\n${snapshot.context.decisions.map((text) => `- ${text}`).join("\n")}`,
      );
    if (snapshot.context.previousTaskNotes.length)
      parts.push(
        `前一步的交接说明：\n${snapshot.context.previousTaskNotes.map((text) => `- ${text}`).join("\n")}`,
      );
  }
  parts.push(
    "遵守项目 AGENTS.md、审批和沙箱规则。只处理本次任务，不自行启动后续待办。",
    "完成后说明完成情况、修改的文件、实际做过的验证以及仍需处理的问题。没有验证过的内容请明确说明，不要编造结果。",
  );
  return parts.join("\n\n");
}
