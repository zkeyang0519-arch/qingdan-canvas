import { ancestors, effectivelyLocked } from "./layout.js";
import { createObject, makeBlock, blockText, id, now } from "./model.js";
import { primaryCollection } from "./collectionDock.js";
export function setBoardMode(state, boardId, mode) {
  if (!["canvas", "arranged"].includes(mode)) throw new Error("视图无效");
  if (state.boards.find((b) => b.id === boardId)?.type === mode) return state;
  return {
    ...state,
    boards: state.boards.map((b) =>
      b.id === boardId ? { ...b, type: mode } : b,
    ),
  };
}
export function flattenGroups(state) {
  // A collection is opaque; a stored group is independent of the board around its box.
  const frameParents = (key) => {
    const chain = ancestors(state.objects, key);
    const stop = chain.findIndex((p) => p.type === "collection");
    return (stop < 0 ? chain : chain.slice(0, stop)).filter(
      (p) => p.type === "frame",
    );
  };
  const nested = state.objects.filter(
    (o) => o.type === "frame" && frameParents(o.id).length,
  );
  if (!nested.length) return state;
  const removed = new Map(nested.map((o) => [o.id, o]));
  const outer = (id) => frameParents(id).at(-1)?.id;
  const redirect = new Map(nested.map((o) => [o.id, outer(o.id)]));
  const objects = state.objects
    .filter((o) => !removed.has(o.id))
    .map((o) => {
      let next = removed.has(o.parentId)
        ? {
            ...o,
            parentId: redirect.get(o.parentId),
            locked: o.locked || effectivelyLocked(state.objects, o.id),
          }
        : o;
      if (
        o.type === "note" &&
        o.blocks.some((b) =>
          b.runs.some((r) => r.type === "ref" && redirect.has(r.targetId)),
        )
      )
        next = {
          ...next,
          blocks: o.blocks.map((b) => ({
            ...b,
            runs: b.runs.map((r) =>
              r.type === "ref" && redirect.has(r.targetId)
                ? { ...r, targetId: redirect.get(r.targetId) }
                : r,
            ),
          })),
        };
      return next;
    });
  return {
    ...state,
    objects,
    trash: [
      ...(state.trash || []),
      {
        id: id("trash"),
        deletedAt: now(),
        objects: nested.map((o) => ({ ...o, parentId: null })),
      },
    ],
  };
}
export function todoPages(state, boardId) {
  const dockId = primaryCollection(state, boardId)?.id;
  const visible = state.objects.filter(
    (o) =>
      o.boardId === boardId &&
      !ancestors(state.objects, o.id).some((p) => p.type === "collection"),
  );
  const groups = visible.filter(
    (o) =>
      o.type === "frame" &&
      !ancestors(visible, o.id).some((p) => p.type === "frame"),
  );
  const pages = groups.map((g) => ({
    id: g.id,
    title: g.title || "未命名分组",
    group: g,
    objects: [],
    tasks: [],
  }));
  const loose = {
    id: "ungrouped",
    title: "未分组",
    group: null,
    objects: [],
    tasks: [],
  };
  for (const o of visible) {
    if (o.type === "frame" || o.id === dockId) continue;
    const parent = ancestors(visible, o.id)
      .filter((p) => p.type === "frame")
      .at(-1);
    const page = pages.find((p) => p.id === parent?.id) || loose;
    page.objects.push(o);
    if (o.type === "note")
      o.blocks.forEach((b, i) => {
        page.tasks.push({
          key: b.id,
          note: o,
          block: b,
          index: i,
          locked: effectivelyLocked(state.objects, o.id),
        });
      });
  }
  if (loose.objects.length || !pages.length) pages.push(loose);
  return pages;
}
export function addPageTodo(state, boardId, pageId, text) {
  const group = state.objects.find(
    (o) => o.id === pageId && o.type === "frame" && o.boardId === boardId,
  );
  if (pageId !== "ungrouped" && !group) return state;
  if (group && effectivelyLocked(state.objects, group.id)) return state;
  const members = state.objects.filter(
    (o) => o.boardId === boardId && o.parentId === (group?.id || null),
  );
  const point = group
    ? {
        x: group.x + 24,
        y: Math.max(
          group.y + 48,
          ...members.map((o) => o.y + (o.layoutHeight || o.height) + 24),
        ),
      }
    : {
        x: 80 + (members.length % 4) * 306,
        y: 100 + Math.floor(members.length / 4) * 220,
      };
  const note = {
    ...createObject(boardId, "note", point),
    parentId: group?.id || null,
    noteKind: "checklist",
    blocks: [makeBlock(text)],
  };
  return { ...state, objects: [...state.objects, note] };
}
