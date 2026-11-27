export function fallbackReport(task) {
  if (task.status === "waiting_model" && task.failure)
    return (
      task.failure.message +
      "\n\n已有成果与任务卡均已保留，恢复后从未完成的步骤继续。"
    );
  if (task.status === "waiting_plan")
    return `已将这次任务拆成 ${task.steps.length} 个子任务。请查看任务卡，确认后开始执行；也可以先调整计划。`;
  const done = [
    ...new Set(
      (task.activities || [])
        .filter((a) => a.status === "done" && a.kind === "tool")
        .map((a) => a.title),
    ),
  ];
  const artifact = (task.artifacts || []).findLast((a) => a.text);
  const remaining = (task.steps || [])
    .filter((s) => s.status !== "done")
    .map((s) => s.description);
  const question = task.questions.find((q) => !q.answer);
  const parts = [];
  if (task.status === "blocked")
    parts.push(
      ...new Set(
        (task.blockers || []).filter((b) => !b.resolved).map((b) => b.message),
      ),
    );
  if (done.length) parts.push("本次已完成：" + done.join("、") + "。");
  const links = [
    ...new Set((task.artifacts || []).flatMap((a) => a.links || [])),
  ];
  if (links.length)
    parts.push(links.map((url, i) => `[查看成果 ${i + 1}](${url})`).join("\n"));
  if (artifact?.text) parts.push(artifact.text.slice(0, 6000));
  if (remaining.length) parts.push("尚待完成：" + remaining.join("、") + "。");
  if (question) parts.push(question.question, question.reason);
  else if (task.status !== "completed") {
    parts.push(task.progress || "本次未能完成全部要求，已有结果已保存。");
    parts.push(
      task.status === "waiting_external"
        ? task.external?.expectedStatus === "enabled"
          ? "宏尚待在 WAAO 确认启用，宿主会继续核对这个宏的状态。"
          : "生成任务尚未完成，将继续查询原回执。"
        : task.status === "cancelled"
          ? "已停止后续操作，已有成果保留。"
          : "任务尚未完成。继续时会沿用已保存的成果与回执，从未完成的步骤接着处理。",
    );
  }
  return parts.filter(Boolean).join("\n\n");
}
export function deliveryText(task, text) {
  if (!task) return text || "";
  if (task.status === "completed")
    return text || task.finalText || task.answer || fallbackReport(task);
  // A model's unconditional success claim cannot override the host verdict.
  const premature =
    /(?:全部|所有(?:任务|步骤)?|整个任务|任务)(?:都|已|已经)?(?:完成|成功)|验收通过|已通过验收|^已完成[。.!！]?$/.test(
      text || "",
    );
  return text?.trim().length >= 12 && !premature
    ? text.trim()
    : fallbackReport(task);
}
