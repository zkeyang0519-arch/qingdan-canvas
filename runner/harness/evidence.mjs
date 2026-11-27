import { digest } from "./task-store.mjs";
import { activityTitle } from "../../shared/agent/task-activity.mjs";

export function resultData(result) {
  if (result?.structuredContent) return result.structuredContent;
  for (const part of result?.content || []) {
    if (part.type !== "text") continue;
    try {
      const value = JSON.parse(part.text);
      if (value && typeof value === "object") return value;
    } catch {}
  }
  return result || {};
}
export function resultText(result) {
  const data = resultData(result);
  return (
    data.text ||
    (result?.content || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n")
  );
}
export function operationOf(name, args = {}, readOnly = false) {
  if (name === "codex")
    return args.action === "images" ? "image.create" : "draft.create";
  if (/mcp__codex__(codex|codex_reply)$/.test(name)) return "draft.create";
  if (name === "waao")
    return args.action === "submit"
      ? "generation.submit"
      : args.action === "status"
        ? "generation.status"
        : "resource.read";
  if (/^mcp__/.test(name) && !/^mcp__waao__/.test(name))
    return readOnly || /(?:_list|_get|_load|_info|_overview)$/.test(name)
      ? "resource.read"
      : "unknown";
  if (/^mcp__waao__macro_run$/.test(name)) return "workflow.submit";
  if (/^mcp__waao__macro_run_get$/.test(name)) return "workflow.status";
  if (/canvas_apply_changes$/.test(name))
    return args.changes?.some((c) => c.op === "create")
      ? "node.create"
      : "node.update";
  if (/node.*create$/.test(name)) return "node.create";
  if (/node_generate$/.test(name)) return "generation.submit";
  if (/task_get$|node_generation_status$|generation_get$/.test(name))
    return "generation.status";
  if (readOnly || /(?:_list|_get|_load|_info|_overview)$/.test(name))
    return "resource.read";
  return "unknown";
}
const resourceKeys = [
  "project_id",
  "canvas_id",
  "node_id",
  "task_id",
  "asset_id",
  "run_id",
  "macro_id",
  "generation_id",
];
export function normalizeEvidence(
  name,
  args,
  result,
  { id, taskId, callId, readOnly = false } = {},
) {
  const raw = resultData(result),
    data = raw.task || raw;
  const operation = operationOf(name, args, readOnly);
  const bad = ["failed", "error", "rejected", "cancelled", "stopped"].includes(
    data.status,
  );
  const ok = !result?.isError && !bad;
  const resource = Object.fromEntries(
    resourceKeys
      .filter((k) => data[k] || args?.[k])
      .map((k) => [k, data[k] || args[k]]),
  );
  if (
    Array.isArray(data.created) &&
    data.created.length === 1 &&
    data.created[0].node_id
  )
    resource.node_id = data.created[0].node_id;
  const resources = (data.created || [])
    .filter((item) => item.node_id)
    .map((item) => {
      const change =
        args?.changes?.find((c) => c.ref === item.ref) ||
        (data.created.length === 1 && args?.changes?.length === 1
          ? args.changes[0]
          : null);
      return {
        resource: { ...resource, node_id: item.node_id },
        inputHash: change?.data?.prompt ? digest(change.data.prompt) : null,
      };
    });
  const mediaReady =
    ok &&
    ["generation.submit", "generation.status", "image.create"].includes(
      operation,
    ) &&
    (result?.playable === true ||
      (["succeeded", "ready", "completed"].includes(data.status) &&
        (!!data.asset_ids?.length ||
          !!data.asset_id ||
          !!data.media_url ||
          !!data.output_url)));
  const snapshotPrompt =
    /^mcp__waao__generation_get$/.test(name) &&
    (data.prompt || data.config?.prompt);
  return {
    id,
    taskId,
    sourceCallId: callId,
    label: name,
    title: activityTitle(name, args),
    kind: "tool",
    ok,
    operation,
    resource,
    resources,
    args,
    mediaReady,
    observedAt: Date.now(),
    generationSnapshot:
      !!snapshotPrompt &&
      !!resource.node_id &&
      !!(resource.generation_id || resource.task_id),
    inputHash: snapshotPrompt
      ? digest(snapshotPrompt)
      : args?.prompt
        ? digest(args.prompt)
        : args?.changes?.length === 1 && args.changes[0].data?.prompt
          ? digest(args.changes[0].data.prompt)
          : null,
    resultKind: !ok
      ? "failed"
      : mediaReady
        ? "ready"
        : operation === "node.create" && (data.created?.length || data.node_id)
          ? "created"
          : ["generation.submit", "workflow.submit"].includes(operation)
            ? "submitted"
            : operation === "resource.read"
              ? "observed"
              : "returned",
    result,
  };
}
export function artifactFrom(evidence) {
  if (
    !evidence.ok ||
    ![
      "draft.create",
      "image.create",
      "node.create",
      "generation.status",
    ].includes(evidence.operation)
  )
    return null;
  if (evidence.operation === "generation.status" && !evidence.mediaReady)
    return null;
  const text =
    evidence.operation === "draft.create" ? resultText(evidence.result) : "";
  if (!text && evidence.operation === "draft.create") return null;
  return {
    id: "artifact_" + evidence.id,
    kind: evidence.operation,
    evidenceId: evidence.id,
    title: evidence.title,
    text,
    resource: evidence.resource,
    contentHash: digest(text || evidence.resource),
    createdAt: evidence.observedAt,
    links: [
      resultData(evidence.result).media_url,
      resultData(evidence.result).output_url,
      ...(evidence.result?.content || [])
        .filter((p) => p.type === "resource_link")
        .map((p) => p.uri),
    ].filter((url) => {
      try {
        const u = new URL(url);
        return u.protocol === "https:" && !u.username && !u.password;
      } catch {
        return false;
      }
    }),
  };
}
// Attach each observation to the original action, never to the preceding poll.
// A long-running task must retain the same provenance after hundreds of reads.
export function attachEvidenceOrigin(task, evidence) {
  if (!["generation.submit", "generation.status"].includes(evidence.operation))
    return;
  const sourceOperation =
    evidence.operation === "generation.status"
      ? "generation.submit"
      : "node.create";
  const source = task.evidence
    .flatMap((e) =>
      e.resources?.length ? e.resources.map((r) => ({ ...e, ...r })) : [e],
    )
    .findLast((e) => {
      if (
        !e.ok ||
        e.operation !== sourceOperation ||
        (e.taskId && e.taskId !== task.id)
      )
        return false;
      const service = (label) =>
        label === "waao" ? "waao-local" : label.split("__")[1];
      if (service(e.label) !== service(evidence.label)) return false;
      const a = evidence.resource || {},
        b = e.resource || {};
      const localReceipt =
        evidence.label === "waao" &&
        sourceOperation === "generation.submit" &&
        resultData(evidence.result).id &&
        resultData(evidence.result).id === resultData(e.result).id;
      const key =
        sourceOperation === "generation.submit" ? "task_id" : "node_id";
      if (!localReceipt && (!a[key] || a[key] !== b[key])) return false;
      return ["project_id", "canvas_id", "node_id", "task_id"].every(
        (k) => !a[k] || !b[k] || a[k] === b[k],
      );
    });
  if (source) {
    evidence.resource = { ...source.resource, ...evidence.resource };
    evidence.inputHash ||= source.inputHash;
    evidence.sourceEvidenceId = source.id;
  }
}
export function expectedOperation(requirement) {
  if (requirement.operation) return requirement.operation;
  const d = requirement.description || "";
  if (/等待.*就绪|核对.*就绪|生成结果|图片就绪|成片就绪/.test(d))
    return "generation.status";
  if (/提交.*生成/.test(d)) return "generation.submit";
  if (/新建.*节点|创建.*节点/.test(d)) return "node.create";
  if (/稿件|旁白|提示词|改稿/.test(d) && !/生成图片|生图|成片/.test(d))
    return "draft.create";
  if (/查询|查阅|读取|列出/.test(d)) return "resource.read";
  return null;
}
export function requirementTools(requirement) {
  return (
    requirement.tools ||
    (requirement.tool
      ? requirement.tool.split(/\s*[/,、|]\s*/).filter(Boolean)
      : [])
  );
}

export function canonicalRequirement(requirement) {
  // These adapters have one fixed business meaning. The model does not get to
  // relabel a returned draft as an asynchronous image-generation submission.
  if (requirement.check !== "tool_result") return requirement;
  const tools = requirementTools(requirement);
  if (
    !tools.length ||
    !tools.every((name) =>
      /^mcp__codex__(codex|codex_reply)$|^mcp__waao__(node_generate|task_get|node_generation_status|generation_get|macro_run|macro_run_get)$/.test(
        name,
      ),
    )
  )
    return requirement;
  const operations = [...new Set(tools.map((name) => operationOf(name)))];
  return operations.length === 1
    ? { ...requirement, operation: operations[0] }
    : requirement;
}

export function knownReference(value, ids) {
  if (ids.has(value)) return value;
  return (
    [...ids].find(
      (id) => value.startsWith(id + " ") || value.startsWith(id + "："),
    ) || value
  );
}
export function externalWaitFor(evidence) {
  const data = resultData(evidence.result);
  if (!evidence.ok) return null;
  if (
    evidence.label === "waao" &&
    evidence.operation === "generation.submit" &&
    data.id
  )
    return { name: "waao", args: { action: "status", receiptId: data.id } };
  if (/mcp__.+__node_generate$/.test(evidence.label) && data.task_id)
    return {
      name: evidence.label.replace(/node_generate$/, "task_get"),
      args: { task_id: data.task_id },
    };
  if (
    /^mcp__waao__macro_run$/.test(evidence.label) &&
    data.run_id &&
    ["queued", "running", "waiting"].includes(data.status)
  )
    return {
      name: evidence.label.replace(/macro_run$/, "macro_run_get"),
      args: { run_id: data.run_id },
    };
  return null;
}
