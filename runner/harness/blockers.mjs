import { digest } from "./task-store.mjs";
import { resultData } from "./evidence.mjs";
import { waaoAccessIssue } from "../../shared/agent/waao-access.mjs";

export function retryablePermissionDenial(result) {
  if (!result?.isError) return false;
  const issue = waaoAccessIssue(result),
    data = resultData(result);
  // These explicit rejections did not accept work. Approval queues, unknown
  // delivery and successful receipts must always retain their original identity.
  return (
    issue?.kind === "permission" &&
    /^(?:forbidden|permission_denied|access_denied|insufficient_scope|not_authorized)$/i.test(
      issue.code,
    ) &&
    ![data, data.error, data.error?.data]
      .filter(Boolean)
      .some((v) => v.task_id || v.run_id || v.approval_id)
  );
}

export function addBlocker(task, input) {
  task.blockers ||= [];
  const id =
    input.id ||
    "block_" +
      digest([
        input.code,
        input.stepIds || [],
        input.resource || {},
        input.tool,
      ]).slice(0, 20);
  const prior = task.blockers.find((b) => b.id === id);
  const next = {
    ...prior,
    ...input,
    id,
    resolved: false,
    createdAt: prior?.createdAt || Date.now(),
  };
  task.blockers = [...task.blockers.filter((b) => b.id !== id), next];
  return next;
}

export function blockingFor(task, stepId) {
  const blocked = new Set();
  for (const b of (task.blockers || []).filter(
    (b) => !b.resolved && b.kind !== "model",
  ))
    for (const id of b.stepIds?.length
      ? b.stepIds
      : task.steps.map((s) => s.id))
      blocked.add(id);
  for (const q of (task.questions || []).filter(
    (q) => !q.answer && q.kind !== "plan_confirmation",
  ))
    for (const id of q.blocksStepIds?.length
      ? q.blocksStepIds
      : task.steps.map((s) => s.id))
      blocked.add(id);
  const reasons = (task.blockers || []).filter(
    (b) =>
      !b.resolved &&
      b.kind !== "model" &&
      (!b.stepIds?.length || b.stepIds.includes(stepId)),
  );
  let changed;
  do {
    changed = false;
    for (const step of task.steps)
      if (
        !blocked.has(step.id) &&
        (step.dependsOn || []).some((id) => blocked.has(id))
      ) {
        blocked.add(step.id);
        changed = true;
      }
  } while (changed);
  if (blocked.has(stepId) && !reasons.length)
    reasons.push({
      code: "STEP_BLOCKED",
      message:
        "此步骤或它的前置步骤仍有未解决的条件，其他不依赖它的步骤仍可继续。",
      kind: "input",
    });
  return reasons;
}

export function canResolve(blocker, name, args, readOnly) {
  if (!readOnly) return false;
  if (blocker.resolver)
    return (
      name === blocker.resolver.name &&
      digest(args) === digest(blocker.resolver.args)
    );
  if (blocker.code === "WAAO_MACRO_CONFIRMATION_REQUIRED")
    return (
      /__macro_get$/.test(name) && args.macro_id === blocker.resource?.macro_id
    );
  return false;
}

export function observeBlockers(task, name, args, result, stepId) {
  if (!/^mcp__waao__|^waao$/.test(name)) return;
  const data = resultData(result);
  const status = data.task?.status || data.status;
  for (const b of task.blockers || [])
    if (
      !b.resolved &&
      b.code === "WAITING_EXTERNAL_RESULT" &&
      canResolve(b, name, args, true) &&
      [
        "succeeded",
        "ready",
        "completed",
        "failed",
        "cancelled",
        "stopped",
        "error",
        "rejected",
      ].includes(status)
    ) {
      b.resolved = true;
      if (
        ["failed", "cancelled", "stopped", "error", "rejected"].includes(status)
      )
        addBlocker(task, {
          kind: "external",
          code: "EXTERNAL_TASK_FAILED",
          stepIds: b.stepIds,
          message:
            "原平台任务未成功，已保留原回执，请先核对平台原因再决定后续处理。",
          resource: b.resource,
          tool: name,
        });
    }
  if (
    /__macro_get$/.test(name) &&
    data.status === "enabled" &&
    data.agent_runnable !== false
  ) {
    for (const blocker of task.blockers || [])
      if (
        blocker.code === "WAAO_MACRO_CONFIRMATION_REQUIRED" &&
        blocker.resource?.macro_id === (data.macro_id || args.macro_id) &&
        (!blocker.resource.version || data.version >= blocker.resource.version)
      )
        blocker.resolved = true;
  }
  const access = result?.isError && waaoAccessIssue(result);
  if (access)
    addBlocker(task, {
      kind: "authorization",
      code: access.code,
      message: access.message,
      stepIds: stepId ? [stepId] : [],
      action: { label: access.actionLabel, url: access.actionUrl },
      tool: name,
      evidenceId: task.evidence.at(-1)?.id,
      deniedAtInputCount: task.userInputs?.length || 0,
    });
  if (
    /__(macro_create|macro_update|macro_get)$/.test(name) &&
    ["draft", "pending", "pending_confirmation", "paused"].includes(data.status)
  )
    addBlocker(task, {
      kind: "external",
      code: "WAAO_MACRO_CONFIRMATION_REQUIRED",
      message:
        "这个宏尚待 WAAO 官网确认并启用。修改宏会生成新版本，须核对启用状态后才能运行。",
      stepIds: stepId ? [stepId] : [],
      resource: {
        macro_id: data.macro_id || args.macro_id,
        version: data.version,
      },
      tool: name,
    });
}

export function readySteps(task) {
  return task.steps.filter(
    (s) =>
      s.status !== "done" &&
      !blockingFor(task, s.id).length &&
      (s.dependsOn || []).every(
        (id) => task.steps.find((p) => p.id === id)?.status === "done",
      ),
  );
}

export function publicBlockers(task) {
  return (task.blockers || [])
    .filter((b) => !b.resolved)
    .map(({ id, kind, code, message, stepIds, action }) => ({
      id,
      kind,
      code,
      message,
      stepIds,
      action,
    }));
}
