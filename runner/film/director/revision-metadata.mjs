// A factual fallback for missing editorial bookkeeping, never a content repair.
// Keep the model's exact draft, reasons and issues. Identity/timing/format checks
// still run afterward and cannot be relaxed by this comparison.
export function completeRevisionMetadata(result, previous, nodeId) {
  if (
    nodeId === "review_prompt" ||
    typeof result?.draft !== "string" ||
    !Array.isArray(result.changes) ||
    result.changes.length ||
    !Array.isArray(result.issues) ||
    result.draft === previous
  )
    return result;
  const next = result.draft;
  let start = 0,
    end = 0;
  while (
    start < Math.min(previous.length, next.length) &&
    previous[start] === next[start]
  )
    start++;
  while (
    end < Math.min(previous.length, next.length) - start &&
    previous[previous.length - end - 1] === next[next.length - end - 1]
  )
    end++;
  const excerpt = (text) =>
    text.length > 160 ? text.slice(0, 160) + "…" : text || "（空）";
  const before = excerpt(previous.slice(start, previous.length - end));
  const after = excerpt(next.slice(start, next.length - end));
  const location = `全文第 ${previous.slice(0, start).split("\n").length} 行起（程序比对）`;
  return {
    ...result,
    changes: [
      {
        location,
        reason: `模型未提供修改原因，以下仅为程序比对记录。原文片段「${before}」改为「${after}」。具体意图未说明，可在修改对照中核实。`,
      },
    ],
    issues: [
      ...result.issues,
      {
        severity: "advisory",
        category: "revision_metadata",
        location: "修改说明",
        reason:
          "本轮正文有变化，但模型未提供修改原因；程序已按真实文字差异补记，没有代写导演意图。",
        required_fix: "结合前后正文核实变化，继续检查角色、时间、内容和版式。",
        node_id: nodeId,
      },
    ],
  };
}
