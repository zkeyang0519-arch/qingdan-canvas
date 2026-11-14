import type { PlanTask } from "./contracts";
import { validDeadline } from "../deadline.js";
import { AgentValidationError } from "./errors";

export const MAX_PLAN_TASKS = 50;

function taskGraph(tasks: readonly PlanTask[]) {
  if (!Array.isArray(tasks))
    throw new AgentValidationError("VALIDATION_ERROR", "任务必须是数组。");
  if (tasks.length > MAX_PLAN_TASKS)
    throw new AgentValidationError(
      "LIMIT_EXCEEDED",
      "一个计划最多包含 50 条任务。",
    );
  const byId = new Map<string, PlanTask>();
  for (const task of tasks) {
    if (
      !task ||
      typeof task.taskId !== "string" ||
      !task.taskId.trim() ||
      task.taskId.length > 256 ||
      !Number.isInteger(task.priority) ||
      task.priority < 0 ||
      task.priority > 3 ||
      !Array.isArray(task.dependsOn) ||
      task.dependsOn.some(
        (id: unknown) => typeof id !== "string" || !id.trim(),
      ) ||
      new Set(task.dependsOn).size !== task.dependsOn.length ||
      (task.dueAt !== null && !validDeadline(task.dueAt))
    ) {
      throw new AgentValidationError("VALIDATION_ERROR", "任务排序字段无效。");
    }
    if (byId.has(task.taskId))
      throw new AgentValidationError(
        "DUPLICATE_TASK_ID",
        "任务 ID 不能重复。",
        { taskId: task.taskId },
      );
    byId.set(task.taskId, task);
  }
  for (const task of tasks)
    for (const dependencyId of task.dependsOn) {
      if (!byId.has(dependencyId))
        throw new AgentValidationError(
          "DEPENDENCY_MISSING",
          "找不到前置任务。",
          { taskId: task.taskId, dependencyId },
        );
    }

  // DFS reports an actual closed path, not every node Kahn's algorithm leaves
  // blocked behind it. The 50-task limit bounds recursion depth.
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  function visit(taskId: string) {
    if (state.get(taskId) === "visited") return;
    if (state.get(taskId) === "visiting") {
      const taskIds = stack.slice(stack.indexOf(taskId));
      throw new AgentValidationError("DEPENDENCY_CYCLE", "任务存在循环依赖。", {
        taskIds,
        cycle: [...taskIds, taskId],
      });
    }
    state.set(taskId, "visiting");
    stack.push(taskId);
    for (const dependencyId of byId.get(taskId)!.dependsOn) visit(dependencyId);
    stack.pop();
    state.set(taskId, "visited");
  }
  for (const task of tasks) visit(task.taskId);
  return byId;
}

function orderPositions(
  byId: ReadonlyMap<string, PlanTask>,
  order: readonly string[],
) {
  if (
    !Array.isArray(order) ||
    order.length !== byId.size ||
    new Set(order).size !== byId.size ||
    order.some((id) => !byId.has(id))
  ) {
    throw new AgentValidationError(
      "MANUAL_ORDER_INVALID",
      "排序必须恰好包含计划中的每条任务一次。",
    );
  }
  return new Map(order.map((id, index) => [id, index]));
}

export function sortPlan(
  tasks: readonly PlanTask[],
  explicitOrder?: readonly string[],
): string[] {
  const byId = taskGraph(tasks);
  const original = new Map(tasks.map((task, index) => [task.taskId, index]));
  const explicit =
    explicitOrder === undefined ? null : orderPositions(byId, explicitOrder);
  const remaining = new Set(byId.keys());
  const result: string[] = [];
  const compare = (a: PlanTask, b: PlanTask) =>
    (explicit ? explicit.get(a.taskId)! - explicit.get(b.taskId)! : 0) ||
    a.priority - b.priority ||
    (a.dueAt === b.dueAt
      ? 0
      : a.dueAt === null
        ? 1
        : b.dueAt === null
          ? -1
          : a.dueAt.localeCompare(b.dueAt)) ||
    original.get(a.taskId)! - original.get(b.taskId)! ||
    (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  while (remaining.size) {
    const ready = tasks.filter(
      (task) =>
        remaining.has(task.taskId) &&
        task.dependsOn.every((id) => !remaining.has(id)),
    );
    ready.sort(compare);
    const next = ready[0];
    remaining.delete(next.taskId);
    result.push(next.taskId);
  }
  return result;
}

export function validateManualOrder(
  tasks: readonly PlanTask[],
  order: readonly string[],
): void {
  const positions = orderPositions(taskGraph(tasks), order);
  const conflicts = tasks.flatMap((task) =>
    task.dependsOn
      .filter(
        (dependencyId) =>
          positions.get(dependencyId)! > positions.get(task.taskId)!,
      )
      .map((dependencyId) => ({ taskId: task.taskId, dependencyId })),
  );
  if (conflicts.length)
    throw new AgentValidationError(
      "DEPENDENCY_ORDER",
      "该顺序与任务依赖冲突。",
      { conflicts },
    );
}
