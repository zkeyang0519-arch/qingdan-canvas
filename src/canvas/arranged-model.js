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
import { validDeadline, validDeadlineRange } from "../../shared/deadline.js";

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

function savedArrangedView(state, boardId) {
  const view = state.preferences.views[boardId]?.arranged?.view;
  return ["list", "calendar"].includes(view) ? { view } : {};
}

export function setSurface(state, boardId, surface) {
  if (!["canvas", "arranged"].includes(surface)) return state;
  if (surface === "arranged") {
    const { page, active } = panePages(state, boardId);
    return changeView(state, boardId, {
      surface,
      arranged: {
        ...savedArrangedView(state, boardId),
        pageId: page?.id,
        active,
      },
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
    view: saved.view === "calendar" ? "calendar" : "list",
  };
}

export function choosePanePage(state, boardId, side, pageId) {
  const resolved = panePages(state, boardId);
  if (
    !["left", "right"].includes(side) ||
    !resolved.pages.some((p) => p.id === pageId)
  )
    return state;
  return changeView(state, boardId, {
    arranged: { ...savedArrangedView(state, boardId), pageId, active: side },
  });
}

export function setArrangedView(state, boardId, view) {
  if (!["list", "calendar"].includes(view)) return state;
  if (panePages(state, boardId).view === view) return state;
  return changeView(state, boardId, {
    arranged: { ...state.preferences.views[boardId]?.arranged, view },
  });
}

export function activatePane(state, boardId, side) {
  const { page, active } = panePages(state, boardId);
  if (active === side || !["left", "right"].includes(side)) return state;
  return changeView(state, boardId, {
    arranged: {
      ...savedArrangedView(state, boardId),
      pageId: page?.id,
      active: side,
    },
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
  { dueStartAt = null, expectedDueStartAt = null } = {},
) {
  if (dueAt !== null && !validDeadline(dueAt)) return state;
  if (!validDeadlineRange(dueStartAt, dueAt)) return state;
  const task = pageTask(state, boardId, pageId, noteId, blockId);
  if (!task) return state;
  if ((task.block.dueAt ?? null) === dueAt && (task.block.dueStartAt ?? null) === dueStartAt) return state;
  if ((task.block.dueAt ?? null) !== (expectedDueAt ?? null)) return state;
  if ((task.block.dueStartAt ?? null) !== expectedDueStartAt) return state;
  return patchObjects(state, {
    [noteId]: {
      blocks: task.note.blocks.map((block) =>
        block.id === blockId ? { ...block, dueAt, dueStartAt } : block,
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
  // Equal ranks keep the note's physical block order. New lines stay next to
  // their source without rewriting other notes (including locked notes).
  const inserted = extra.map((block) =>
    task.block.arrangedOrder === undefined || task.block.done
      ? block
      : { ...block, arrangedOrder: task.block.arrangedOrder },
  );
  blocks.splice(
    task.index,
    1,
    { ...task.block, runs: edited.runs },
    ...inserted,
  );
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

function pendingPageTasks(state, boardId, pageId) {
  if (!writablePage(state, boardId, pageId)) return null;
  const page = panePages(state, boardId).pages.find((p) => p.id === pageId);
  const tasks = page.tasks.filter((task) => !task.block.done);
  // Ordering writes task metadata, so a locked list must remain untouched.
  return tasks.some((task) => task.locked) ? null : tasks;
}

function savePendingOrder(state, previous, ordered) {
  if (ordered.every((task, index) => task.key === previous[index].key))
    return state;
  const ranks = new Map(ordered.map((task, index) => [task.key, index]));
  const patches = {};
  for (const { note } of ordered) {
    if (
      patches[note.id] ||
      !note.blocks.some(
        (block) =>
          ranks.has(block.id) && block.arrangedOrder !== ranks.get(block.id),
      )
    )
      continue;
    patches[note.id] = {
      blocks: note.blocks.map((block) =>
        ranks.has(block.id)
          ? { ...block, arrangedOrder: ranks.get(block.id) }
          : block,
      ),
    };
  }
  if (Object.keys(patches).length > 200)
    throw new Error("一次最多调整 200 张便签，请分批整理后再排序。");
  const updatedAt = now();
  return {
    ...state,
    objects: state.objects.map((object) =>
      patches[object.id]
        ? { ...object, ...patches[object.id], updatedAt }
        : object,
    ),
  };
}

export function sortPendingPageTasks(state, boardId, pageId) {
  const tasks = pendingPageTasks(state, boardId, pageId);
  if (!tasks || tasks.length < 2) return state;
  const deadline = (task) =>
    validDeadline(task.block.dueAt) ? Date.parse(task.block.dueAt) : Infinity;
  return savePendingOrder(
    state,
    tasks,
    [...tasks].sort((a, b) => deadline(a) - deadline(b)),
  );
}

export function movePendingPageTask(
  state,
  boardId,
  pageId,
  taskId,
  targetId,
  placement = "before",
) {
  if (taskId === targetId || !["before", "after"].includes(placement))
    return state;
  const tasks = pendingPageTasks(state, boardId, pageId);
  const moving = tasks?.find((task) => task.key === taskId);
  if (!moving || !tasks.some((task) => task.key === targetId)) return state;
  const ordered = tasks.filter((task) => task.key !== taskId);
  const index = ordered.findIndex((task) => task.key === targetId);
  ordered.splice(index + (placement === "after" ? 1 : 0), 0, moving);
  return savePendingOrder(state, tasks, ordered);
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
