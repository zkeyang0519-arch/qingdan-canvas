import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const capturedAt = "2026-11-03T02:00:00.000Z";
export const hash = "a".repeat(64);

export function makeTask(taskId = "task-a", overrides = {}) {
  return {
    taskId,
    text: "实现任务功能",
    instruction: "完成实现，并提供验证结果。",
    acceptance: [
      {
        id: "check-a",
        description: "用户确认结果",
        required: true,
        kind: "human",
      },
    ],
    dependsOn: [],
    priority: 2,
    dueAt: null,
    ...overrides,
  };
}

export function makeBinding(overrides = {}) {
  return {
    bindingId: "binding-a",
    ownerId: "owner-a",
    canvasId: "canvas-a",
    sectionId: "section-a",
    runnerId: "runner-a",
    workspaceId: "workspace-a",
    revision: 1,
    authEpoch: 1,
    enabled: true,
    ...overrides,
  };
}

export function makeSnapshot(overrides = {}) {
  const { taskId, ...task } = makeTask();
  return {
    snapshotId: "snapshot-a",
    runId: "run-a",
    kind: "task",
    ownerId: "owner-a",
    bindingId: "binding-a",
    bindingRevision: 1,
    workspaceId: "workspace-a",
    summaryRevision: 1,
    memoryEpoch: 1,
    sourceRefs: ["message-a"],
    payloadHash: hash,
    capturedAt,
    allowedCheckIds: ["test"],
    context: {
      projectSummary: null,
      decisions: [],
      previousTaskNotes: [],
      gitBaseline: { commit: null, branch: null, dirty: false },
    },
    task: {
      ...task,
      taskRef: { canvasId: "canvas-a", noteId: "note-a", taskId },
      planId: "plan-a",
      sourceTextHash: hash,
      specRevision: 1,
      specHash: hash,
      specStatus: "ready",
      createdByMessageId: "message-a",
    },
    ...overrides,
  };
}

export function makeOutcome(overrides = {}) {
  return {
    runId: "run-a",
    taskId: "task-a",
    outcome: "done",
    summary: "实现完成，等待验收。",
    changedFiles: ["src/app.ts"],
    evidenceRefs: ["evidence-a"],
    remainingIssues: [],
    nextTaskNotes: [],
    ...overrides,
  };
}

export function makeRunnerEvent(overrides = {}) {
  return {
    protocolVersion: 1,
    eventId: "event-a",
    runnerId: "runner-a",
    runId: "run-a",
    threadId: "thread-a",
    turnId: "turn-a",
    seq: 1,
    type: "turn.completed",
    occurredAt: capturedAt,
    payload: {
      status: "completed",
      outcome: makeOutcome(),
      summary: null,
      error: null,
    },
    ...overrides,
  };
}

export function makeQueueState(overrides = {}) {
  return {
    batchId: "batch-a",
    bindingId: "binding-a",
    bindingRevision: 1,
    planId: "plan-a",
    adoptedPlanRevision: 1,
    authorizedTaskIds: ["task-a"],
    state: "draft",
    activeRunId: null,
    queueRevision: 1,
    startedBy: "owner-a",
    ...overrides,
  };
}

export function makeCreatePlan(tasks = [makeTask()], overrides = {}) {
  return {
    type: "create_plan",
    requestId: "request-a",
    bindingId: "binding-a",
    canvasId: "canvas-a",
    sectionId: "section-a",
    createdByMessageId: "message-a",
    tasks,
    ...overrides,
  };
}

export function makeCommandEnvelope(overrides = {}) {
  return {
    protocolVersion: 1,
    commandId: "command-a",
    runId: "run-a",
    bindingRevision: 1,
    authEpoch: 1,
    leaseEpoch: 1,
    payloadHash: "b".repeat(64),
    issuedAt: capturedAt,
    expiresAt: "2026-11-03T02:01:00.000Z",
    payload: {
      type: "create_run",
      requestId: "request-a",
      runId: "run-a",
      bindingId: "binding-a",
      bindingRevision: 1,
      kind: "task",
      snapshotId: "snapshot-a",
      payloadHash: hash,
    },
    ...overrides,
  };
}

export async function loadAgentModules() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const tmp = path.join(root, ".tmp");
  await mkdir(tmp, { recursive: true });
  const dir = await mkdtemp(path.join(tmp, "agent-rules-"));
  try {
    const outfile = path.join(dir, "rules.mjs");
    await build({
      stdin: {
        contents:
          "export * from './shared/agent/schemas.ts'; export * from './shared/agent/sort-plan.ts'; export * from './shared/agent/deadlines.ts';",
        resolveDir: root,
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
