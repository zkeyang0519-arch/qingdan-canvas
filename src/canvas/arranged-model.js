import {
  createObject,
  createInspirationBoard,
  patchObjects,
  movableIds,
  takeOutObject,
  now,
} from "./model.js";
import { todoPages } from "./todoPages.js";
import { ancestors, effectivelyLocked, normalizeLayout } from "./layout.js";
import { deleteTask } from "./taskRecords.js";
import { validDeadline } from "../../shared/deadline.js";

function changeView(state, boardId, change) {
  const views = state.preferences.views;
  return {
    ...state,
    preferences: {
      ...state.preferences,
      views: { ...views, [boardId]: { ...views[boardId], ...change } },
    },
  };
}

export function setSurface(state, boardId, surface) {
  if (!["canvas", "arranged"].includes(surface)) return state;
  if (surface === "arranged") {
    const { page, active } = panePages(state, boardId);
    return changeView(state, boardId, {
      surface,
      arranged: { pageId: page?.id, active },
    });
  }
  return changeView(state, boardId, { surface });
}

export function panePages(state, boardId) {
  // Storage snapshots can enumerate objects in a different order after reconnect.
  const objects = [...state.objects].sort(
    (a, b) =>
      (a.createdAt || "").localeCompare(b.createdAt || "") ||
      a.id.localeCompare(b.id),
  );
  const pages = todoPages({ ...state, objects }, boardId);
  const saved = state.preferences.views[boardId]?.arranged || {};
  // Migrate the old two-project view using the last active pane's project.
  const preferred = saved.pageId
    ? [saved.pageId]
    : [
        saved[saved.active === "right" ? "right" : "left"],
        saved.left,
        saved.right,
      ];
  const page =
    preferred.map((key) => pages.find((p) => p.id === key)).find(Boolean) ||
    pages[0] ||
    null;
  return {
    pages,
    page,
    left: page,
    right: page,
    active: saved.active === "right" ? "right" : "left",
  };
}

export function choosePanePage(state, boardId, side, pageId) {
  const resolved = panePages(state, boardId);
  if (
    !["left", "right"].includes(side) ||
    !resolved.pages.some((p) => p.id === pageId)
  )
    return state;
  return changeView(state, boardId, { arranged: { pageId, active: side } });
}

export function activatePane(state, boardId, side) {
  const { page, active } = panePages(state, boardId);
  if (active === side || !["left", "right"].includes(side)) return state;
  return changeView(state, boardId, {
    arranged: { pageId: page?.id, active: side },
  });
}

export function createChecklistPage(state, boardId, title) {
  if (!state.boards.some((b) => b.id === boardId) || !title.trim())
    return state;
  const objects = state.objects.filter(
    (o) => o.boardId === boardId && !o.parentId && o.type !== "collection",
  );
  const frame = createInspirationBoard(
    boardId,
    {
      x: objects.length
        ? Math.max(...objects.map((o) => o.x + o.width)) + 80
        : 80,
      y: 80,
    },
    title.trim().slice(0, 80),
  );
  return { ...state, objects: [...state.objects, frame] };
}

export function writablePage(state, boardId, pageId) {
  const page = todoPages(state, boardId).find((p) => p.id === pageId);
  return page &&
    (!page.group || !effectivelyLocked(state.objects, page.group.id))
    ? page
    : null;
}

function insertionPoint(state, boardId, page) {
  const members = state.objects.filter(
    (o) =>
      o.boardId === boardId &&
      o.parentId === (page.group?.id || null) &&
      o.type !== "collection",
  );
  return page.group
    ? {
        x: page.group.x + 24,
        y: Math.max(
          page.group.y + 48,
          ...members.map((o) => o.y + (o.layoutHeight || o.height) + 24),
        ),
      }
    : {
        x: 80 + (members.length % 4) * 306,
        y: members.length
          ? Math.max(
              ...members.map((o) => o.y + (o.layoutHeight || o.height)),
            ) + 24
          : 100,
      };
}

function fitPage(state, pageId) {
  const frame = state.objects.find((o) => o.id === pageId);
  if (!frame?.fixedBounds) return normalizeLayout(state);
  const members = state.objects.filter((o) => o.parentId === pageId);
  const width = Math.max(
    frame.width,
    ...members.map((o) => o.x + o.width + 24 - frame.x),
  );
  const height = Math.max(
    frame.height,
    ...members.map((o) => o.y + (o.layoutHeight || o.height) + 24 - frame.y),
  );
  return width === frame.width && height === frame.height
    ? state
    : patchObjects(state, { [pageId]: { width, height } });
}

export function appendPageObjects(state, boardId, pageId, entries) {
  const page = writablePage(state, boardId, pageId);
  if (!page || !entries.length) return state;
  const point = insertionPoint(state, boardId, page),
    ids = new Set(state.objects.map((o) => o.id));
  const added = [];
  for (const object of entries) {
    if (
      object.boardId !== boardId ||
      ids.has(object.id) ||
      !["note", "image"].includes(object.type)
    )
      continue;
    ids.add(object.id);
    added.push({
      ...object,
      x: point.x,
      y: point.y,
      parentId: page.group?.id || null,
    });
    point.y += (object.layoutHeight || object.height) + 24;
  }
  if (!added.length) return state;
  return fitPage({ ...state, objects: [...state.objects, ...added] }, pageId);
}

function pageTask(state, boardId, pageId, noteId, blockId) {
  return writablePage(state, boardId, pageId)?.tasks.find(
    (t) => t.note.id === noteId && t.key === blockId && !t.locked,
  );
}

export function setPageDeadline(
  state,
  boardId,
  pageId,
  noteId,
  blockId,
  dueAt,
  expectedDueAt = null,
) {
  if (dueAt !== null && !validDeadline(dueAt)) return state;
  const task = pageTask(state, boardId, pageId, noteId, blockId);
  if (!task || (task.block.dueAt ?? null) === dueAt) return state;
  if ((task.block.dueAt ?? null) !== (expectedDueAt ?? null)) return state;
  return patchObjects(state, {
    [noteId]: {
      blocks: task.note.blocks.map((block) =>
        block.id === blockId ? { ...block, dueAt } : block,
      ),
    },
  });
}

export function editPageBlock(state, boardId, pageId, noteId, blockId, runs) {
  const task = pageTask(state, boardId, pageId, noteId, blockId);
  if (!task) return state;
  // Only the editor-owned text changes. Concurrent completion and remarks survive.
  return patchObjects(state, {
    [noteId]: {
      blocks: task.note.blocks.map((b) =>
        b.id === blockId ? { ...b, runs } : b,
      ),
    },
  });
}

export function insertPageBlocks(
  state,
  boardId,
  pageId,
  noteId,
  blockId,
  edited,
  extra,
) {
  const task = pageTask(state, boardId, pageId, noteId, blockId);
  if (!task) return state;
  const blocks = [...task.note.blocks];
  blocks.splice(task.index, 1, { ...task.block, runs: edited.runs }, ...extra);
  return patchObjects(state, { [noteId]: { blocks } });
}

export function deletePageTasks(state, boardId, pageId, keys) {
  const page = writablePage(state, boardId, pageId);
  if (!page) return state;
  const selected = new Set(keys);
  return page.tasks
    .filter((t) => selected.has(t.key))
    .reduce((next, t) => deleteTask(next, t.note.id, t.key), state);
}

export function clearCompletedPageTasks(state, boardId, pageId) {
  const page = writablePage(state, boardId, pageId);
  if (!page) return state;
  return deletePageTasks(
    state,
    boardId,
    pageId,
    page.tasks.filter((t) => t.block.done && !t.locked).map((t) => t.key),
  );
}

export function takeOutToPage(state, boardId, pageId, objectId) {
  const page = writablePage(state, boardId, pageId),
    object = state.objects.find(
      (o) => o.id === objectId && o.boardId === boardId,
    );
  if (
    !page ||
    !object ||
    !ancestors(state.objects, objectId).some((o) => o.type === "collection")
  )
    return state;
  const moving = movableIds(state, [objectId]);
  if (!moving.has(objectId) || moving.has(pageId)) return state;
  const point = insertionPoint(state, boardId, page);
  // A collected inspiration board remains its own page when restored.
  if (object.type === "frame")
    return takeOutObject(state, objectId, point, boardId);
  const dx = point.x - object.x,
    dy = point.y - object.y;
  const next = {
    ...state,
    objects: state.objects.map((o) =>
      moving.has(o.id)
        ? {
            ...o,
            x: o.x + dx,
            y: o.y + dy,
            parentId: o.id === objectId ? page.group?.id || null : o.parentId,
            updatedAt: now(),
          }
        : o,
    ),
  };
  return fitPage(next, pageId);
}
