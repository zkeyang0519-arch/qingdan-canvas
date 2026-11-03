import { parseAgentCommand } from "../../shared/agent/schemas.ts";
import { sortPlan, validateManualOrder } from "../../shared/agent/sort-plan.ts";
import { blockText } from "../canvas/model.js";

export function newDraftTask(text = "") {
  return {
    taskId: crypto.randomUUID(),
    text,
    instruction: "",
    acceptanceText: "",
    dependsOn: [],
    priority: 2,
    dueLocal: "",
  };
}
export function exampleTasks() {
  const a = {
    ...newDraftTask("任务 A：准备数据"),
    instruction: "整理本次报告需要的数据，保存为 data.json。",
    acceptanceText: "data.json 包含本次报告所需的数据。",
  };
  const b = {
    ...newDraftTask("任务 B：生成报告"),
    instruction: "读取任务 A 生成的数据，制作报告。",
    acceptanceText: "报告中的数据与 data.json 一致。",
    dependsOn: [a.taskId],
    priority: 0,
  };
  return [a, b];
}
export function copyPageTasks(page) {
  return (page?.tasks ?? [])
    .filter((t) => !t.block.done)
    .map((t) => newDraftTask(blockText(t.block)));
}
export function readDraft(key, storage = localStorage) {
  try {
    const value = JSON.parse(storage.getItem(key));
    if (
      value?.version !== 1 ||
      !Array.isArray(value.tasks) ||
      value.tasks.length > 50
    )
      return [];
    if (
      value.tasks.some(
        (t) =>
          !t ||
          ![
            t.taskId,
            t.text,
            t.instruction,
            t.acceptanceText,
            t.dueLocal,
          ].every((v) => typeof v === "string") ||
          !Array.isArray(t.dependsOn) ||
          t.dependsOn.some((v) => typeof v !== "string") ||
          ![0, 1, 2, 3].includes(t.priority),
      )
    )
      return [];
    return value.tasks;
  } catch {
    return [];
  }
}
export function checkDraft(draft, manual = false) {
  try {
    if (!draft.length) throw Error("请先添加任务或载入示例。");
    draft.forEach((t, i) => {
      for (const [field, label] of [
        ["text", "任务名称"],
        ["instruction", "执行要求"],
        ["acceptanceText", "完成条件"],
      ])
        if (!t[field].trim()) throw Error(`任务 ${i + 1} 缺少${label}。`);
    });
    const { tasks } = parseAgentCommand({
      type: "create_plan",
      requestId: "trial",
      bindingId: "trial",
      canvasId: "trial",
      sectionId: "trial",
      createdByMessageId: "trial",
      tasks: draft.map(({ acceptanceText, dueLocal, ...task }) => ({
        ...task,
        dueAt: dueLocal ? new Date(dueLocal).toISOString() : null,
        acceptance: acceptanceText
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((description, i) => ({
            id: `criterion-${i}`,
            kind: "human",
            description,
            required: true,
          })),
      })),
    });
    const order = manual ? tasks.map((t) => t.taskId) : sortPlan(tasks);
    if (manual) validateManualOrder(tasks, order);
    return { order, error: null };
  } catch (error) {
    const title = (id) => draft.find((t) => t.taskId === id)?.text || id;
    if (error.code === "DEPENDENCY_CYCLE")
      return {
        error: `这些任务互相等待：${error.details.cycle.map(title).join(" → ")}。请取消其中一条依赖。`,
      };
    if (error.code === "DEPENDENCY_ORDER")
      return {
        error: error.details.conflicts
          .map(
            (c) =>
              `“${title(c.dependencyId)}”必须排在“${title(c.taskId)}”前面。`,
          )
          .join(" "),
      };
    if (error.code === "VALIDATION_ERROR")
      return {
        error:
          "任务格式无效：名称、要求和完成条件每项最多 32,000 字，最多 50 条条件；请检查截止时间和依赖。",
      };
    return { error: error.message };
  }
}
