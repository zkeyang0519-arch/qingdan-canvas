import { blockText } from "../canvas/model.js";

// Canvas notes keep an empty editing row. It is not a saved Agent task.
export function canvasChecklistTasks(page) {
  return (page?.tasks || []).filter(
    (task) =>
      task.note?.noteKind !== "text" &&
      task.block?.runs &&
      blockText(task.block).trim(),
  );
}

// The shared canvas owns membership and completion. The server snapshot only
// supplies execution versions/specs, which may arrive after a local edit.
export function mergeCanvasChecklistTasks(page, snapshot) {
  const saved = new Map(
    snapshot.map((task) => [JSON.stringify([task.noteId, task.taskId]), task]),
  );
  return canvasChecklistTasks(page).map(({ note, key, block, locked }) => {
    const task = saved.get(JSON.stringify([note.id, key]));
    const text = blockText(block);
    const current =
      task &&
      task.text === text &&
      !!task.done === !!block.done &&
      (task.completedAt ?? null) === (block.completedAt ?? null);
    return {
      ...task,
      noteId: note.id,
      taskId: key,
      text,
      done: !!block.done,
      completedAt: block.completedAt ?? null,
      locked: !!(locked || task?.locked),
      specStatus: current ? task.specStatus : "syncing",
    };
  });
}

export const checklistTaskVersion = ({
  noteId,
  taskId,
  generation,
  specRevision,
}) => JSON.stringify([noteId, taskId, generation, specRevision]);

export function validProjectHistory(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (run) =>
        run?.executionMode === "project" &&
        typeof run.runId === "string" &&
        typeof run.createdAt === "string" &&
        typeof run.status === "string" &&
        typeof run.terminal === "boolean" &&
        typeof run.stopConfirmed === "boolean" &&
        Array.isArray(run.submission?.tasks) &&
        run.submission.tasks.every(
          (item) =>
            typeof item?.source?.taskRef?.noteId === "string" &&
            typeof item.source.taskRef.taskId === "string" &&
            Number.isSafeInteger(item.source.generation) &&
            Number.isSafeInteger(item.source.specRevision),
        ),
    )
  );
}

// Keep one latest attempt per source, without output, prompts or project data.
// Recent server history is bounded; this browser remembers already seen results.
export function projectTaskHistory(runs, canvasId) {
  const seen = new Set();
  const history = new Map();
  const ordered = [...runs].sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || ""),
  );
  for (const run of ordered) {
    if (run.executionMode !== "project") continue;
    for (const item of run.submission?.tasks || []) {
      const source = item.source;
      const ref = source?.taskRef;
      if (!ref || (ref.canvasId && ref.canvasId !== canvasId)) continue;
      const identity = JSON.stringify([ref.noteId, ref.taskId]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (!history.has(run.runId))
        history.set(run.runId, {
          runId: run.runId,
          executionMode: "project",
          createdAt: run.createdAt || "",
          status: run.status,
          terminal: !!run.terminal,
          stopConfirmed: !!run.stopConfirmed,
          submission: { tasks: [] },
        });
      history
        .get(run.runId)
        .submission.tasks.push({ taskId: ref.taskId, source });
    }
  }
  return [...history.values()];
}

// Execution ending is a presentation state, not acceptance or canvas writeback.
export function projectReviewSources(history) {
  const review = new Map();
  for (const run of history) {
    for (const { source } of run.submission.tasks) {
      if (
        run.terminal &&
        run.stopConfirmed &&
        ["verifying", "succeeded"].includes(run.status)
      ) {
        review.set(
          checklistTaskVersion({
            ...source.taskRef,
            generation: source.generation,
            specRevision: source.specRevision,
          }),
          run.runId,
        );
      }
    }
  }
  return review;
}
