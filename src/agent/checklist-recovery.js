import { checklistMutationSchema } from "../../shared/agent/checklist.ts";
import {
  executionToolSchemas,
  manualIntentSchema,
} from "../../shared/agent/execution.ts";

export const checklistPath = "/api/agent/execution/checklist";
const intentsPath = "/api/agent/execution/intents";
const toolsPath = "/api/agent/execution/tools";
export const exact = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export const operationKey = (action, payload) => exact([action, payload]);
const assert = (condition) => {
  if (!condition) throw Error("旧操作信息不完整或关联不符，仅供只读核对。");
};
const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
export const validDraft = (value) =>
  plain(value) &&
  ["text", "instruction", "acceptance"].every(
    (key) => typeof value[key] === "string",
  ) &&
  (value.acceptanceChecks === undefined ||
    Array.isArray(value.acceptanceChecks));
export const validEditor = (value) =>
  value === null ||
  (plain(value) &&
    validDraft(value.value) &&
    plain(value.task) &&
    typeof value.task.noteId === "string" &&
    typeof value.task.taskId === "string" &&
    typeof value.task.text === "string" &&
    Number.isSafeInteger(value.task.generation) &&
    Number.isSafeInteger(value.task.specRevision));
export const legacyScope = ({ userId, roomId, pageId, binding }) =>
  JSON.stringify([
    userId,
    roomId,
    pageId,
    JSON.stringify([
      binding.bindingId,
      binding.revision,
      binding.runnerId,
      binding.workspaceId,
    ]),
  ]);

export function intentCheckpoint(result, record, binding) {
  const input = result?.input;
  assert(
    executionToolSchemas.codex_create_run.safeParse(input).success &&
      input.kind === "task" &&
      input.requestId === record.requestId &&
      input.bindingId === binding.bindingId &&
      input.bindingRevision === binding.revision,
  );
  return {
    result,
    nextRequest: {
      path: toolsPath,
      method: "POST",
      body: {
        bindingId: input.bindingId,
        name: "codex_create_run",
        arguments: input,
      },
    },
  };
}

// Validate stored requests at the consumer boundary as well as during migration.
// Keep the original wire body: parsing is validation, never permission to fill defaults.
export function inspectChecklistRequest(record, binding) {
  assert(
    plain(record) &&
      typeof record.requestId === "string" &&
      record.request?.method === "POST",
  );
  const { path, body } = record.request;
  assert(plain(body) && body.bindingId === binding.bindingId);
  if (path === checklistPath) {
    const { bindingId: _, ...request } = body;
    assert(
      request.requestId === record.requestId &&
        checklistMutationSchema.safeParse(request).success,
    );
    return { action: request.action, request };
  }
  if (path === intentsPath) {
    assert(
      body.requestId === record.requestId &&
        body.bindingRevision === binding.revision &&
        body.kind === "task" &&
        Array.isArray(body.sourceTasks) &&
        manualIntentSchema.safeParse(body).success,
    );
    if (record.checkpoint?.result) {
      const expected = intentCheckpoint(
        record.checkpoint.result,
        record,
        binding,
      );
      assert(
        exact(expected.nextRequest) === exact(record.checkpoint.nextRequest),
      );
    } else assert(!record.checkpoint?.nextRequest);
    return { action: "dispatch" };
  }
  assert(
    path === toolsPath &&
      body.name === "codex_cancel_run" &&
      Object.keys(body).length === 3 &&
      body.arguments?.requestId === record.requestId &&
      executionToolSchemas.codex_cancel_run.safeParse(body.arguments).success,
  );
  return { action: "stop" };
}

function parseLegacyEntry(entry, context) {
  let legacy, action, op;
  assert(
    Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      plain(entry[1]),
  );
  const parsed = JSON.parse(entry[0]);
  assert(Array.isArray(parsed) && parsed.length === 2);
  const [kind, payload] = parsed;
  action = kind;
  const { requestId, input } = entry[1];
  assert(
    Object.keys(entry[1]).every((k) => ["requestId", "input"].includes(k)) &&
      typeof requestId === "string" &&
      !!requestId,
  );
  let request;
  if (["create", "save", "reorder"].includes(action)) {
    assert(
      plain(payload) &&
        !("action" in payload) &&
        !("requestId" in payload) &&
        !("bindingId" in payload) &&
        input == null,
    );
    request = {
      path: checklistPath,
      method: "POST",
      body: {
        bindingId: context.binding.bindingId,
        action,
        requestId,
        ...payload,
      },
    };
  } else if (action === "dispatch") {
    assert(plain(payload) && !("requestId" in payload));
    request = {
      path: intentsPath,
      method: "POST",
      body: { requestId, ...payload },
    };
  } else {
    assert(action === "stop" && typeof payload === "string" && input == null);
    request = {
      path: toolsPath,
      method: "POST",
      body: {
        bindingId: context.binding.bindingId,
        name: "codex_cancel_run",
        arguments: { runId: payload, requestId },
      },
    };
  }
  legacy = { requestId, request, checkpoint: null };
  if (action === "dispatch" && input != null)
    legacy.checkpoint = intentCheckpoint({ input }, legacy, context.binding);
  inspectChecklistRequest(legacy, context.binding);
  op = operationKey(action, payload);
  return { legacy, action, op };
}

export function retireLegacyRequest(store, context, record) {
  if (!store.getSnapshot().durable) return;
  const key = `qingdan.agent-checklist-requests:${legacyScope(context)}`;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    const retained = entries.filter((entry) => {
      try {
        const parsed = parseLegacyEntry(entry, context);
        return (
          parsed.legacy.requestId !== record.requestId ||
          parsed.op !== record.operationKey ||
          exact(parsed.legacy.request) !== exact(record.request)
        );
      } catch {
        return true;
      }
    });
    if (
      retained.length === entries.length ||
      window.sessionStorage.getItem(key) !== raw
    )
      return;
    if (retained.length)
      window.sessionStorage.setItem(key, JSON.stringify(retained));
    else window.sessionStorage.removeItem(key);
  } catch {
    /* Preserve the old evidence if browser storage cannot be updated. */
  }
}

export async function migrateChecklistRequests(store, context) {
  const scope = legacyScope(context),
    key = `qingdan.agent-checklist-requests:${scope}`;
  const quarantined = [];
  let raw;
  try {
    raw = window.sessionStorage.getItem(key);
  } catch {
    return { quarantined, warning: "无法读取旧操作恢复信息。" };
  }
  if (raw === null) return { quarantined, warning: "" };
  let entries;
  try {
    const [account, canvas, page, nested, ...extra] = JSON.parse(
      key.slice("qingdan.agent-checklist-requests:".length),
    );
    assert(
      !extra.length &&
        account === context.userId &&
        canvas === context.roomId &&
        page === context.pageId &&
        exact(JSON.parse(nested)) ===
          exact([
            context.binding.bindingId,
            context.binding.revision,
            context.binding.runnerId,
            context.binding.workspaceId,
          ]),
    );
    entries = JSON.parse(raw);
    assert(Array.isArray(entries));
  } catch {
    return { quarantined: [raw], warning: "旧操作信息不完整，仅供只读核对。" };
  }
  const retained = [];
  let warning = "";
  // Validate the whole old Map before choosing an identity. Corrupt duplicates
  // cannot be resolved by whichever variant happened to be listed first.
  const byId = new Map(),
    byOperation = new Map(),
    contradictory = new Set();
  for (const entry of entries) {
    // Even an unreadable payload key is evidence about its declared identity.
    // Index that identity before validating the rest of the old Map entry.
    const id = entry?.[1]?.requestId;
    if (typeof id === "string" && id)
      byId.set(id, [...(byId.get(id) || []), entry]);
    if (
      !Array.isArray(entry) ||
      typeof entry[0] !== "string" ||
      !id
    )
      continue;
    let op;
    try {
      op = exact(JSON.parse(entry[0]));
    } catch {
      continue;
    }
    byOperation.set(op, [...(byOperation.get(op) || []), entry]);
  }
  for (const group of [...byId.values(), ...byOperation.values()])
    if (new Set(group.map(exact)).size > 1)
      for (const entry of group) contradictory.add(entry);
  for (const entry of entries) {
    if (contradictory.has(entry)) {
      quarantined.push(entry);
      retained.push(entry);
      continue;
    }
    let legacy, action, op;
    try {
      ({ legacy, action, op } = parseLegacyEntry(entry, context));
    } catch {
      quarantined.push(entry);
      retained.push(entry);
      continue;
    }
    try {
      const adopted = await store.adopt(op, legacy, {
        safeStop: action === "stop",
      });
      if (legacy.checkpoint && !adopted.checkpoint)
        await store.checkpoint(adopted.requestId, legacy.checkpoint);
      if (!store.getSnapshot().durable) retained.push(entry);
    } catch (error) {
      warning = error.message;
      retained.push(entry);
    }
  }
  // A still-running old tab may update this journal; never overwrite its newer value.
  try {
    if (
      store.getSnapshot().durable &&
      window.sessionStorage.getItem(key) === raw
    ) {
      if (retained.length)
        window.sessionStorage.setItem(key, JSON.stringify(retained));
      else window.sessionStorage.removeItem(key);
    }
  } catch {
    warning ||= "旧操作仍保留，尚未完成恢复信息迁移。";
  }
  return { quarantined, warning };
}
