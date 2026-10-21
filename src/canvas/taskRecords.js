import { id, now, patchObjects } from "./model.js";
import { effectivelyLocked, normalizeLayout } from "./layout.js";

export function forgetRecoveryOrigin(object) {
  if (!("recoveryOrigin" in object)) return object;
  const { recoveryOrigin, ...rest } = object;
  return rest;
}

// Retain the positions of deleted blocks so separate recoveries can arrive in any order.
export function mergeBlockOrder(order = [], incoming = []) {
  const result = [...order];
  for (let i = 0; i < incoming.length; i++) {
    const key = incoming[i];
    if (result.includes(key)) continue;
    const next = incoming.slice(i + 1).find((k) => result.includes(k));
    const previous = incoming.slice(0, i).findLast((k) => result.includes(k));
    const at = next
      ? result.indexOf(next)
      : previous
        ? result.indexOf(previous) + 1
        : result.length;
    result.splice(at, 0, key);
  }
  return result;
}

export function setTaskRemark(state, noteId, blockId, text) {
  const note = state.objects.find((o) => o.id === noteId && o.type === "note");
  const block = note?.blocks.find((b) => b.id === blockId);
  if (
    !block ||
    effectivelyLocked(state.objects, noteId) ||
    typeof text !== "string" ||
    (block.remark?.text || "") === text
  )
    return state;
  return patchObjects(state, {
    [noteId]: {
      blocks: note.blocks.map((b) =>
        b.id === blockId
          ? text
            ? { ...b, remark: { text, updatedAt: now() } }
            : (({ remark, ...rest }) => rest)(b)
          : b,
      ),
    },
  });
}

export function deleteTask(state, noteId, blockId) {
  const note = state.objects.find((o) => o.id === noteId && o.type === "note");
  const block = note?.blocks.find((b) => b.id === blockId);
  if (!block || effectivelyLocked(state.objects, noteId)) return state;
  const order = mergeBlockOrder(
    note.blockOrder,
    note.blocks.map((b) => b.id),
  );
  const next = patchObjects(state, {
    [noteId]: {
      blocks: note.blocks.filter((b) => b.id !== blockId),
      blockOrder: order,
    },
  });
  return {
    ...next,
    trash: [
      {
        id: id("trash"),
        kind: "task",
        objects: [],
        deletedAt: now(),
        task: {
          noteId,
          block: structuredClone(block),
          note: { ...structuredClone(note), blocks: [], blockOrder: order },
        },
      },
      ...state.trash,
    ],
  };
}

export function mergeRestoredNote(existing, archived) {
  const blocks = [
    ...existing.blocks,
    ...archived.blocks.filter(
      (b) => !existing.blocks.some((live) => live.id === b.id),
    ),
  ];
  const order = mergeBlockOrder(
    mergeBlockOrder(
      existing.blockOrder || archived.blockOrder,
      existing.blocks.map((b) => b.id),
    ),
    archived.blockOrder || archived.blocks.map((b) => b.id),
  );
  return {
    ...existing,
    blockOrder: order,
    blocks: blocks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
  };
}

export function restoreTask(state, batch) {
  const { note: snapshot, block, noteId } = batch.task;
  const live = state.objects.find((o) => o.id === noteId);
  if (
    live &&
    (live.type !== "note" || effectivelyLocked(state.objects, noteId))
  )
    return state;
  const boardId = state.boards.some((b) => b.id === snapshot.boardId)
    ? snapshot.boardId
    : state.boards[0]?.id;
  if (!boardId) return state;
  const parent = state.objects.find(
    (o) =>
      o.id === snapshot.parentId &&
      o.boardId === boardId &&
      ["frame", "collection"].includes(o.type),
  );
  if (!live && parent && effectivelyLocked(state.objects, parent.id))
    return state;
  if (
    state.objects.some(
      (o) =>
        o.id === block.id ||
        (o.id !== noteId &&
          o.blocks?.some((b) => b.id === block.id || b.id === noteId)),
    )
  )
    return state;
  const note = live || {
    ...forgetRecoveryOrigin(snapshot),
    boardId,
    parentId: parent?.id || null,
    blocks: [],
    ...(!parent && snapshot.parentId
      ? {
          recoveryOrigin: {
            parentId: snapshot.parentId,
            x: snapshot.x,
            y: snapshot.y,
          },
        }
      : {}),
  };
  const restored = mergeRestoredNote(note, { ...snapshot, blocks: [block] });
  return normalizeLayout({
    ...state,
    objects: live
      ? state.objects.map((o) => (o.id === noteId ? restored : o))
      : [...state.objects, restored],
    trash: state.trash.filter((t) => t.id !== batch.id),
  });
}
