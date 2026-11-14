import type { BatchItem } from "./contracts";

export function projectTaskText(item: Pick<BatchItem, "text" | "instruction">): string {
  const text = item.text.trim();
  const instruction = item.instruction.trim();
  return instruction && instruction !== text ? `${text}\n${instruction}` : text;
}

// The same immutable text is displayed in Qingdan and sent as the initial
// Codex user message. Saved project information travels in additional context.
export function projectSubmissionText(items: BatchItem[]): string {
  return [
    "请结合已保存的项目信息，在同一轮中统筹完成以下待办。按需要安排实施顺序，统一说明修改、验证和未完成事项。",
    ...items.map((item, index) => `${index + 1}. ${projectTaskText(item)}`),
  ].join("\n\n");
}
