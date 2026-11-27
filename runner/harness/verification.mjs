import { requirementProof, stepRequirements } from "./proofs.mjs";
import { publicBlockers } from "./blockers.mjs";
import { artifactContext } from "./context-pack.mjs";

export function verifyResult(task, checks) {
  const failures = [];
  if (task.requiresToolResult && !task.evidence.some((e) => e.ok))
    failures.push("用户要求实际工具操作，尚未取得成功回执。");
  for (const requirement of task.requirements) {
    const check = checks.find((c) => c.requirementId === requirement.id);
    if (!check) {
      failures.push(requirement.description + "：缺少检查结果。");
      continue;
    }
    const proof = requirementProof(task, requirement, check.evidenceIds, {
      answer:
        task.answer ||
        task.steps.find(
          (s) =>
            s.requirementIds?.includes(requirement.id) ||
            s.id === requirement.id,
        )?.answer,
    });
    for (const failure of proof.failures)
      failures.push(requirement.description + "：" + failure);
  }
  for (const gap of task.gaps.filter((g) => g.blocking && !g.resolved))
    failures.push("信息仍不完整：" + gap.description);
  for (const question of task.questions.filter((q) => !q.answer))
    failures.push("尚待回答：" + question.question);
  for (const blocker of publicBlockers(task).filter((b) => b.kind !== "model"))
    failures.push(blocker.message);
  for (const step of task.steps.filter((s) => s.status !== "done"))
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
    requirePlanConfirmation,
    plan,
    requirements,
    steps,
    gaps,
    questions,
    progress,
    budget,
  } = state;
  const compact = state.schemaVersion >= 3;
  const activeStep =
    steps.find((s) => s.id === state.activeStepId && s.status !== "done") ||
    steps.find((s) => s.status !== "done");
  const activeIds = new Set(
    activeStep ? stepRequirements(state, activeStep).map((r) => r.id) : [],
  );
  const shownRequirements =
    compact && activeIds.size
      ? requirements.filter((r) => activeIds.has(r.id))
      : requirements;
  return {
    goal,
    originalGoal: originalGoal?.slice(0, compact ? 1200 : 4000),
    planRef: compact ? "task_plan" : undefined,
    blockers: publicBlockers(state),
    failure: state.failure || null,
    status,
    requirePlanConfirmation,
    plan,
    requirements: shownRequirements.map((r) => ({
      ...r,
      description: r.description.slice(0, compact ? 300 : 700),
    })),
    steps: steps.map((s) => ({
      ...(compact
        ? {
            id: s.id,
            title: s.title,
            status: s.status,
            dependsOn: s.dependsOn,
            requirementIds: s.requirementIds,
          }
        : s),
      description:
        !compact || s.id === activeStep?.id
          ? s.description.slice(0, 250)
          : undefined,
    })),
    currentStep:
      compact && activeStep
        ? {
            id: activeStep.id,
            tools: activeStep.tools,
            execution: activeStep.execution
              ? { tool: activeStep.execution.tool, argsRef: "task_plan" }
              : undefined,
            verification: activeStep.verification,
          }
        : undefined,
    gaps: gaps
      .filter((g) => !g.resolved)
      .map((g) => ({ ...g, description: g.description.slice(0, 400) })),
    questions: questions
      .filter((q) => !q.answer)
      .map((q) => ({
        ...q,
        question: q.question.slice(0, 600),
        reason: q.reason.slice(0, 600),
      })),
    progress: progress?.slice(0, 600),
    budget,
    artifacts: compact
      ? (state.artifacts || []).slice(-8).map(({ text, ...artifact }) => ({
          ...artifact,
          length: text?.length,
          readWith: "read_context",
        }))
      : artifactContext(state),
    amendments: (state.userInputs || []).slice(compact ? -2 : -4).map((m) => ({
      id: "turn_" + m.id,
      text: m.text.slice(0, compact ? 700 : 2000),
    })),
    evidence: state.evidence
      .slice(compact ? -6 : -32)
      .map(({ result, args, ...item }) => item),
  };
}

export function taskCard(state) {
  if (!state) return null;
  return {
    id: state.id,
    revision: state.revision,
    goal: state.goal,
    status: state.status,
    blockers: publicBlockers(state),
    failure: state.failure || null,
    plan: state.plan || null,
    progress: state.progress,
    steps:
      state.schemaVersion >= 3
        ? state.steps.map(
            ({
              id,
              title,
              description,
              status,
              dependsOn,
              requirementIds,
            }) => ({
              id,
              title,
              description,
              status,
              dependsOn,
              requirementIds,
            }),
          )
        : state.steps,
    gaps: state.gaps,
    questions: state.questions.filter((item) => !item.answer),
    answerEvents: state.questions
      .filter((q) => q.answerEventId && q.kind !== "plan_confirmation")
      .map(({ id, question, answer, answeredAt }) => ({
        id,
        question,
        answer,
        answeredAt,
      })),
    activities: (state.activities || [])
      .filter(
        (a) =>
          (a.kind === "tool" || a.text || a.status === "running") &&
          (!state.plan || !state.steps.length || a.id.startsWith("step:")),
      )
      .map(({ lastProgressAt, ...activity }) => activity),
    messageIds: state.messageIds,
    activeMessageId: state.activeMessageId || state.messageIds?.at(-1),
    updatedAt: state.updatedAt,
    automaticWait: state.status === "waiting_external" && !!state.external,
    report: state.report || null,
    verification: state.verification || null,
    result: state.finalText || null,
    artifacts: (state.artifacts || []).map(
      ({ id, title, links, resource }) => ({ id, title, links, resource }),
    ),
    budget: {
      requests: state.budget.requests,
      maxRequests: state.budget.maxRequests,
      maxTokens: state.budget.maxTokens,
      tokens: state.budget.tokens,
      tools: state.evidence?.length || 0,
      lastInputEstimate: state.lastModelRequest?.estimatedInputTokens,
    },
  };
}
