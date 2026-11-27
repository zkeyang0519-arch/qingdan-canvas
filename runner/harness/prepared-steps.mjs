import { visitTemplate } from "./recipes.mjs";
import { resultData, resultText } from "./evidence.mjs";

function field(value, path = []) {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw Error("前置步骤没有返回计划所需的字段。");
    value = value[key];
  }
  if (value === undefined) throw Error("计划输入尚未取得。");
  return value;
}

export function validatePreparedSteps(task) {
  const ids = new Set(task.steps.map((s) => s.id));
  for (const step of task.steps) {
    if (!step.execution) continue;
    if (JSON.stringify(step.execution).length > 256000)
      throw Error("单步输入过大，请改用已保存的产物引用。");
    visitTemplate(step.execution.args, (ref) => {
      if (ref.$artifact) {
        if (!task.artifacts.some((a) => a.id === ref.$artifact))
          throw Error("当前任务没有这份已保存产物。");
        return null;
      }
      if (ref.$input)
        throw Error(
          "任务步骤使用明确输入或前置产物，不能引用未声明的自由输入。",
        );
      if (
        !ids.has(ref.$step) ||
        ref.$step === step.id ||
        !step.dependsOn?.includes(ref.$step)
      )
        throw Error("步骤只能引用已声明的前置步骤。");
      return null;
    });
  }
}

export function preparedArguments(task, step) {
  return visitTemplate(step.execution.args, (ref) => {
    if (ref.$artifact) {
      const artifact = task.artifacts.find((a) => a.id === ref.$artifact);
      if (!artifact) throw Error("当前任务没有这份已保存产物。");
      return field(artifact, ref.path);
    }
    if (ref.$input) throw Error("未声明的任务输入。");
    const prior = task.steps.find((s) => s.id === ref.$step);
    if (
      !prior ||
      prior.status !== "done" ||
      !step.dependsOn?.includes(prior.id)
    )
      throw Error("前置步骤尚未通过核验。");
    const evidence = [...task.evidence]
      .reverse()
      .find(
        (e) =>
          e.ok && e.stepId === prior.id && prior.evidenceIds?.includes(e.id),
      );
    const value = evidence
      ? { ...resultData(evidence.result), text: resultText(evidence.result) }
      : prior.answer
        ? { text: prior.answer }
        : null;
    return field(value, ref.path);
  });
}
