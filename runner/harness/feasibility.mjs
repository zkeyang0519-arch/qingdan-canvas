import { requirementTools, operationOf, externalWaitFor } from "./evidence.mjs";
import { requirementProof, stepRequirements } from "./proofs.mjs";
import { digest } from "./task-store.mjs";

export function assessPlan(task, catalog) {
  const issues = [],
    names = new Map(catalog.map((c) => [c.name, c]));
  for (const requirement of task.requirements) {
    if (requirement.check === "answer") continue;
    const ids = task.evidence.filter((e) => e.ok).map((e) => e.id);
    if (requirementProof(task, requirement, ids).accepted) continue;
    const steps = task.steps.filter((s) =>
      stepRequirements(task, s).some((r) => r.id === requirement.id),
    );
    const explicit = [
      ...new Set(
        steps.flatMap((s) =>
          [s.execution?.tool, ...(s.tools || [])].filter(Boolean),
        ),
      ),
    ];
    let required = explicit.length ? explicit : requirementTools(requirement);
    // Already accepted jobs only need their state query, never another submit.
    const submitted =
      requirement.check === "media_ready" &&
      task.evidence.findLast(
        (e) =>
          e.ok &&
          e.operation === "generation.submit" &&
          externalWaitFor(e) &&
          (!required.length || required.includes(e.label)),
      );
    if (submitted) required = [externalWaitFor(submitted).name];
    if (!required.length) {
      if (
        requirement.operation &&
        !catalog.some(
          (c) =>
            c.state === "ready" &&
            operationOf(c.name, {}, c.readOnly) === requirement.operation,
        )
      )
        issues.push({
          code: "CAPABILITY_UNAVAILABLE",
          requirementId: requirement.id,
          stepIds: steps.map((s) => s.id),
          message: `当前连接没有提供“${requirement.description}”所需的能力，请先调整执行路径。`,
        });
      continue;
    }
    const available = required.filter(
      (name) => names.get(name)?.state === "ready",
    );
    // Explicit step tools are all dependencies. Legacy requirement.tools lists
    // alternative implementations; at least one must be callable.
    const missing = explicit.length
      ? required.filter((name) => !available.includes(name))
      : available.length
        ? []
        : required;
    for (const tool of missing) {
      const entry = names.get(tool);
      const code = !entry
        ? "CAPABILITY_UNAVAILABLE"
        : entry.state === "service_disabled"
          ? "SERVICE_DISABLED"
          : ["authorization", "not_authorized"].includes(entry.state)
            ? "AUTHORIZATION_REQUIRED"
            : "SERVICE_UNAVAILABLE";
      issues.push({
        code,
        tool,
        serverId: entry?.serverId,
        requirementId: requirement.id,
        stepIds: steps.map((s) => s.id),
        message: !entry
          ? `当前工具目录没有 ${tool}。登录成功不代表提供这个接口，须调整执行路径后再确认计划。`
          : `${tool} 当前${code === "SERVICE_DISABLED" ? "未在此项目开启" : code === "AUTHORIZATION_REQUIRED" ? "需要完成服务授权" : "不可用"}。`,
      });
    }
  }
  for (const step of task.steps) {
    for (const parent of step.dependsOn || [])
      if (parent === step.id || !task.steps.some((s) => s.id === parent))
        issues.push({
          code: "PLAN_DEPENDENCY_INVALID",
          stepIds: [step.id],
          message: `${step.title || step.description} 引用了无效的前置步骤。`,
        });
    for (const id of step.requirementIds || [])
      if (!task.requirements.some((r) => r.id === id))
        issues.push({
          code: "PLAN_REQUIREMENT_INVALID",
          stepIds: [step.id],
          message: "步骤引用的验收项不存在。",
        });
  }
  const visiting = new Set(),
    visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const p of task.steps.find((s) => s.id === id)?.dependsOn || [])
      if (!visit(p)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  }
  if (task.steps.some((s) => !visit(s.id)))
    issues.push({
      code: "PLAN_DEPENDENCY_CYCLE",
      message: "步骤之间存在循环依赖，请调整计划。",
      stepIds: [],
    });
  return {
    ready: !issues.length,
    issues,
    catalogVersion: digest(catalog.map(({ name, state }) => [name, state])),
    checkedAt: Date.now(),
  };
}
