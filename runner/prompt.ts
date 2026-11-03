import type { ExecutionSnapshot } from "../shared/agent/contracts";
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
          runId: { type: "string" },
          taskId: { type: ["string", "null"] },
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
export function runPrompt(
  snapshot: ExecutionSnapshot,
  requestId: string,
  message?: string,
) {
  return JSON.stringify({
    protocol: "qingdan-run-v1",
    requestId,
    snapshot,
    purpose:
      snapshot.kind === "summary"
        ? "只读总结当前项目，检查现状与验证证据；不实施任务。"
        : "按 task 的要求实施本项任务，并报告真实结果。",
    requirements: [
      "遵守项目 AGENTS.md 与审批和沙箱规则。",
      "只处理本次指定项目与任务，不启动后续待办。",
      "最终仅返回符合 outputSchema 的 JSON；不可编造验证或隐瞒未解决问题。",
      "任务结果中的 runId、taskId 必须原样使用快照中的 ID；总结使用 ProjectSummary。",
    ],
    ...(message ? { followup: message } : {}),
  });
}
