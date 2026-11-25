export function verifyResult(task, checks) {
  const failures = [];
  const evidence = new Map(task.evidence.map((item) => [item.id, item]));
  for (const requirement of task.requirements) {
    const check = checks.find((item) => item.requirementId === requirement.id);
    if (!check) {
      failures.push(requirement.description + "：缺少检查结果。");
      continue;
    }
    const refs = check.evidenceIds.map((id) => evidence.get(id));
    if (refs.some((item) => !item || !item.ok)) {
      failures.push(
        requirement.description + "：引用的证据不存在或是失败回执。",
      );
      continue;
    }
    if (
      requirement.check !== "answer" &&
      !refs.some((item) => item.kind === "tool" && item.ok)
    )
      failures.push(requirement.description + "：需要真实工具回执。");
    if (
      requirement.check === "media_ready" &&
      !refs.some((item) => item.mediaReady)
    )
      failures.push(
        requirement.description + "：尚未取得平台确认就绪的媒体回执。",
      );
  }
  for (const item of task.gaps.filter(
    (item) => item.blocking && !item.resolved,
  ))
    failures.push("信息仍不完整：" + item.description);
  for (const question of task.questions.filter((item) => !item.answer))
    failures.push("尚待回答：" + question.question);
  for (const step of task.steps.filter((item) => item.status !== "done"))
    failures.push("步骤未完成：" + step.description);
  if (!task.requirements.length) failures.push("尚未明确任务验收条件。");
  return { accepted: failures.length === 0, failures };
}

export function modelState(state) {
  if (!state) return null;
  const {
    goal,
    originalGoal,
    status,
    requirements,
    steps,
    gaps,
    questions,
    progress,
    budget,
  } = state;
  return {
    goal,
    originalGoal,
    status,
    requirements,
    steps,
    gaps,
    questions,
    progress,
    budget,
    evidence: state.evidence.map(({ result, args, ...item }) => item),
  };
}

export function taskCard(state) {
  if (!state) return null;
  return {
    id: state.id,
    revision: state.revision,
    goal: state.goal,
    status: state.status,
    progress: state.progress,
    steps: state.steps,
    gaps: state.gaps,
    questions: state.questions.filter((item) => !item.answer),
    verification: state.verification || null,
    result: state.finalText || null,
    budget: {
      requests: state.budget.requests,
      maxRequests: state.budget.maxRequests,
    },
  };
}
