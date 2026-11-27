import { digest } from "./task-store.mjs";
import { preparedArguments } from "./prepared-steps.mjs";
import {
  expectedOperation,
  requirementTools,
  resultData,
} from "./evidence.mjs";

export function substantiveAnswer(value) {
  const text = String(value || "").trim();
  return (
    !!text &&
    !/^(?:本次|所有|全部|任务|工作|步骤|已|已经|都|完成|成功|结束|验收通过|文案|稿件|结果|处理|生成|好了|已交付|[，。!！\s])+$/.test(
      text,
    )
  );
}

export const deliveryStep = (step) =>
  !step.execution &&
  !step.operation &&
  /^(?:总结|汇总|交付|整理.*结果|提交验收|用 submit_result)/.test(
    step.title || step.description || "",
  );

export function stepRequirements(task, step) {
  if (step.requirementIds?.length)
    return step.requirementIds
      .map((id) => task.requirements.find((r) => r.id === id))
      .filter(Boolean);
  const exact = task.requirements.filter(
    (r) => r.id === step.id || r.description === step.description,
  );
  if (exact.length) return exact;
  const operation = expectedOperation(step);
  const matches = task.requirements.filter(
    (r) =>
      expectedOperation(r) === operation ||
      (r.check === "media_ready" &&
        ["generation.submit", "generation.status"].includes(operation)),
  );
  if (operation && matches.length === 1) return matches;
  return !deliveryStep(step) && task.requirements.length === 1
    ? task.requirements
    : [];
}

function lineage(task, evidence) {
  const seen = new Set(),
    result = [];
  let next = evidence;
  while (next && !seen.has(next.id) && result.length < 12) {
    if (next.taskId && next.taskId !== task.id) return [];
    seen.add(next.id);
    result.push(next);
    next =
      next.sourceEvidenceId &&
      task.evidence.find((e) => e.id === next.sourceEvidenceId);
  }
  return result;
}

function sameGeneration(status, submit) {
  if (!status.ok || !submit.ok || submit.operation !== "generation.submit")
    return false;
  const a = status.resource || {},
    b = submit.resource || {};
  if (
    status.label !== "waao" &&
    status.label.split("__")[1] !== submit.label.split("__")[1]
  )
    return false;
  if (
    status.label === "waao" &&
    submit.label === "waao" &&
    resultData(status.result).id &&
    resultData(status.result).id === resultData(submit.result).id
  )
    return true;
  // A ready image on the same node is not enough when it belongs to an older job.
  if (!a.task_id || !b.task_id || a.task_id !== b.task_id) return false;
  return ["project_id", "canvas_id", "node_id"].every(
    (k) => !a[k] || !b[k] || a[k] === b[k],
  );
}

function allowedTools(task, requirement) {
  const original = requirementTools(requirement);
  const bound =
    task.plan?.status === "approved"
      ? task.steps
          .filter((s) => s.requirementIds?.includes(requirement.id))
          .flatMap((s) =>
            [s.execution?.tool, ...(s.tools || [])].filter(Boolean),
          )
      : [];
  return [...new Set([...original, ...bound])];
}

export function requirementProof(task, requirement, ids, { answer } = {}) {
  const failures = [];
  if (requirement.check === "answer") {
    const scopedAnswer = task.steps?.find(
      (s) =>
        (s.requirementIds?.includes(requirement.id) ||
          s.id === requirement.id ||
          s.description === requirement.description) &&
        s.answer,
    )?.answer;
    const single =
      task.requirements.filter((r) => r.check === "answer").length <= 1;
    const delivered =
      scopedAnswer ||
      (answer && (answer !== task.answer || single)
        ? answer
        : single
          ? task.answer || task.finalText
          : "");
    if (task.schemaVersion >= 3 && !substantiveAnswer(delivered))
      failures.push("尚未保存实际交付的文字内容。");
    return { accepted: !failures.length, failures, evidenceIds: [] };
  }
  const refs = (ids || []).map((id) => task.evidence.find((e) => e.id === id));
  if (!refs.length)
    return {
      accepted: false,
      failures: ["需要真实工具回执。"],
      evidenceIds: [],
    };
  if (refs.some((e) => !e || !e.ok || (e.taskId && e.taskId !== task.id)))
    return {
      accepted: false,
      failures: ["引用的证据不存在、失败或来自其他任务。"],
      evidenceIds: [],
    };
  const tools = allowedTools(task, requirement);
  const expected =
    requirement.check === "media_ready"
      ? "generation.status"
      : expectedOperation(requirement);
  const scoped = refs.filter((e) => {
    const chain = lineage(task, e);
    const submit = chain.find((p) => sameGeneration(e, p));
    const snapshotOrigin =
      e.generationSnapshot &&
      task.evidence.find(
        (p) =>
          p.ok &&
          p.operation === "node.create" &&
          p.resultKind === "created" &&
          (!p.taskId || p.taskId === task.id) &&
          (p.resources?.length ? p.resources : [p]).some(
            (o) =>
              o.resource?.node_id === e.resource?.node_id &&
              o.inputHash &&
              o.inputHash === e.inputHash,
          ),
      );
    const toolMatch =
      !tools.length ||
      tools.includes(e.label) ||
      (requirement.check === "media_ready" &&
        submit &&
        tools.includes(submit.label));
    if (!toolMatch) return false;
    if (requirement.check === "media_ready") {
      if (
        !e.mediaReady ||
        (e.operation &&
          !["generation.status", "generation.submit", "image.create"].includes(
            e.operation,
          ))
      )
        return false;
      if (
        e.operation === "generation.status" &&
        task.schemaVersion >= 3 &&
        !submit &&
        !snapshotOrigin
      )
        return false;
    } else if (expected && e.operation && e.operation !== expected)
      return false;
    if (e.operation === "unknown" && (!tools.length || expected)) return false;
    if (expected === "node.create" && e.resultKind !== "created") return false;
    if (
      task.schemaVersion >= 3 &&
      expected === "generation.submit" &&
      !e.resource?.task_id &&
      !(e.label === "waao" && resultData(e.result).id)
    )
      return false;
    if (expected === "workflow.submit" && !e.resource?.run_id) return false;
    const objects = e.resources?.length ? e.resources : [e];
    return objects.some((object) => {
      const resource = {
        ...(submit?.resource || {}),
        ...(e.resource || {}),
        ...(object.resource || {}),
      };
      if (
        Object.entries(requirement.resource || {}).some(
          ([k, v]) => resource[k] !== v,
        )
      )
        return false;
      const adopted =
        requirement.inputArtifactId ||
        (expected === "node.create" &&
        /提示词|稿件|prompt|采用/i.test(requirement.description)
          ? (
              task.artifacts?.findLast(
                (a) =>
                  a.text &&
                  (a.kind === "draft.create" || (!a.kind && a.evidenceId)),
              ) ||
              task.artifacts?.findLast(
                (a) => a.text && a.kind === "adopted.text",
              )
            )?.id
          : null);
      if (adopted) {
        const artifact = task.artifacts?.find((a) => a.id === adopted);
        const hash = object.inputHash || e.inputHash || submit?.inputHash;
        if (!artifact || !hash || hash !== digest(artifact.text)) return false;
      }
      return true;
    });
  });
  if (!scoped.length)
    failures.push("回执与要求的操作、对象、生成任务或采用稿不匹配。");
  return {
    accepted: !failures.length,
    failures,
    evidenceIds: scoped.map((e) => e.id),
  };
}

export function verifyStep(task, step, ids) {
  if (step.execution) {
    let expected;
    try {
      expected = preparedArguments(task, step);
    } catch (error) {
      return { accepted: false, failures: [error.message], evidenceIds: [] };
    }
    ids = (ids || []).filter((id) => {
      const evidence = task.evidence.find((e) => e.id === id);
      return (
        evidence?.label === step.execution.tool &&
        digest(evidence.args) === digest(expected)
      );
    });
  }
  const requirements = stepRequirements(task, step);
  if (!requirements.length)
    return {
      accepted: false,
      failures: ["请为此步骤关联明确的验收项。"],
      evidenceIds: [],
    };
  const operation = expectedOperation(step);
  const results = requirements.map((r) =>
    requirementProof(
      task,
      r.check === "media_ready" &&
        ["generation.submit", "workflow.submit"].includes(operation)
        ? {
            ...r,
            check: "tool_result",
            operation:
              step.execution?.tool === "mcp__waao__macro_run"
                ? "workflow.submit"
                : operation,
          }
        : r,
      ids,
      { answer: step.answer },
    ),
  );
  return {
    accepted: results.every((r) => r.accepted),
    failures: results.flatMap((r) => r.failures),
    evidenceIds: [...new Set(results.flatMap((r) => r.evidenceIds))],
  };
}

export function reconcileSteps(task) {
  if (task.schemaVersion < 3) return;
  for (const step of task.steps) {
    if (deliveryStep(step)) {
      if (step.status === "done" && !task.verification?.accepted)
        step.status = "pending";
      continue;
    }
    const scoped = task.evidence
      .filter((e) => e.ok && e.stepId === step.id)
      .map((e) => e.id);
    const ids = [...new Set([...(step.evidenceIds || []), ...scoped])].filter(
      (id) => task.evidence.some((e) => e.id === id && e.ok),
    );
    const proof = verifyStep(task, step, ids);
    step.verification = proof;
    if (proof.accepted) {
      step.status = "done";
      step.evidenceIds = proof.evidenceIds;
    } else if (step.status === "done")
      step.status = ids.length ? "running" : "pending";
  }
}

export function allRequirementChecks(task) {
  return task.requirements.map((r) => {
    const proof = requirementProof(
      task,
      r,
      task.evidence.filter((e) => e.ok).map((e) => e.id),
      { answer: task.answer },
    );
    return {
      requirementId: r.id,
      evidenceIds: proof.evidenceIds,
      explanation: proof.accepted
        ? "已核对保存的实际成果。"
        : proof.failures.join("；"),
      accepted: proof.accepted,
    };
  });
}
