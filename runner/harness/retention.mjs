import { hasSecretText } from "../../shared/agent/secret-text.mjs";
const sensitive =
  /api.?key|secret|token|password|cookie|authorization|credential|base64|^data$|^env$/i;
function excerpt(value, depth = 0) {
  if (depth > 4) return undefined;
  if (typeof value === "string") {
    if (hasSecretText(value)) return "[凭据内容已排除]";
    return value.replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, "$1").slice(0, 1000);
  }
  if (Array.isArray(value))
    return value.slice(0, 8).map((item) => excerpt(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitive.test(key))
        .slice(0, 12)
        .map(([key, item]) => [key, excerpt(item, depth + 1)]),
    );
  return value;
}
export function completedTaskReport(task, jobId) {
  if (!task || task.status !== "completed" || !task.verification?.accepted)
    return null;
  const verifiedEvidenceIds = [
    ...new Set(
      (task.verification.checks || []).flatMap(
        (check) => check.evidenceIds || [],
      ),
    ),
  ].slice(0, 64);
  return {
    taskId: task.id,
    jobId,
    finalRevision: task.completedRevision || task.revision,
    status: "completed",
    goal: task.goal.slice(0, 8000),
    summary: (task.finalText || task.progress || "").slice(0, 8000),
    messageIds: task.messageIds.slice(-64),
    verifiedEvidenceIds,
    evidence: task.evidence
      .filter((e) => verifiedEvidenceIds.includes(e.id))
      .slice(-32)
      .map((e) => ({
        id: e.id,
        label: e.label.slice(0, 150),
        kind: e.kind === "tool" ? "tool" : "answer",
        ok: !!e.ok,
        text: JSON.stringify(excerpt(e.result ?? e.text ?? e.label)).slice(
          0,
          3000,
        ),
      })),
  };
}
