import { randomUUID } from "node:crypto";
import { digest } from "./task-store.mjs";

// Runtime statuses, discovered resource IDs and receipts do not change the
// work the user approved. Goal, deliverables and named steps do.
export function planDigest(task) {
  return digest({
    goal: task.goal,
    requirements: task.requirements.map(
      ({ id, description, check, operation }) => ({
        id,
        description,
        check,
        operation,
      }),
    ),
    steps: task.steps.map(
      ({
        id,
        title,
        description,
        requirementIds,
        dependsOn,
        tools,
        execution,
        operation,
      }) => ({
        id,
        title: title || description,
        description,
        requirementIds,
        dependsOn,
        tools,
        execution,
        operation,
      }),
    ),
  });
}

export function needsTaskPlan(text = "") {
  return /^(?:新任务[：:]\s*)?(?:请|请你|帮我|帮忙|麻烦你|你)?\s*(?:执行|完成|制作|生成|新建|创建|修改|修复|开发|实现|写一|整理并|处理(?:这|以下|这批)|去\s*(?:codex|waao))|(?:一批|以下|这些|所选).{0,8}待办/i.test(
    text.trim(),
  );
}

export function planApproved(task) {
  return (
    task.plan?.status === "approved" && task.plan.digest === planDigest(task)
  );
}

export function reviewPlan(task) {
  if (!task.requirePlanConfirmation) return;
  if (!task.steps.length || !task.requirements.length) return;
  const signature = planDigest(task);
  if (task.plan?.digest !== signature) {
    const questionId = randomUUID();
    task.plan = {
      revision: (task.plan?.revision || 0) + 1,
      digest: signature,
      questionId,
      status: "pending",
      createdAt: Date.now(),
    };
    task.questions = task.questions.filter(
      (q) => q.kind !== "plan_confirmation",
    );
    task.questions.push({
      id: questionId,
      kind: "plan_confirmation",
      question: "确认这份任务计划后开始执行",
      reason: "确认后按卡片中的步骤连续推进。",
      options: [],
      createdAt: Date.now(),
    });
  }
  if (!planApproved(task)) {
    const completed = new Set(
      (task.activities || [])
        .filter((a) => a.kind === "tool" && a.status === "done" && a.evidenceId)
        .map((a) => a.id),
    );
    task.steps = task.steps.map((s) => ({
      ...s,
      title: s.title || s.description,
      status:
        completed.has("step:" + s.id) && s.status === "done"
          ? "done"
          : "pending",
    }));
    task.status = "waiting_plan";
    task.progress = `已拆分 ${task.steps.length} 个子任务，确认后开始执行。`;
  }
  if (task.feasibility) {
    task.plan.canConfirm = task.feasibility.ready;
    if (!task.feasibility.ready) {
      task.status = "blocked";
      task.progress = task.feasibility.issues.map((i) => i.message).join("\n");
    }
  }
}

export function acceptPlan(task, input, messageId) {
  const question = task.questions.find(
    (q) =>
      q.id === input.taskReply?.questionId && q.kind === "plan_confirmation",
  );
  if (!question) return false;
  if (task.plan?.canConfirm === false)
    throw Error("这份计划还有未解决的能力或依赖问题，请先调整计划。");
  if (
    task.plan?.questionId !== question.id ||
    task.plan.digest !== planDigest(task) ||
    (task.plan.status === "approved" && task.plan.approvedBy !== messageId)
  )
    throw Error("任务计划已经变化，请查看最新卡片后确认。");
  task.plan.status = "approved";
  task.plan.approvedBy = messageId;
  task.plan.approvedAt ||= Date.now();
  question.answer = "已确认计划并开始执行";
  question.answerMessageId = messageId;
  return true;
}
