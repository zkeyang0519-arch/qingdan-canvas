import { parseBackup as parseLegacy } from "../store.js";
import { defaultView, bounds } from "./geometry.js";
import { validateImageData } from "./images.js";
import { primaryCollection } from "./collectionDock.js";
import {
  normalizeLayout,
  descendantIds,
  selectionRoots,
  ancestors,
  effectivelyLocked,
  frameDragBarriers,
  constrainFrameMove,
  placeBoardObjects,
} from "./layout.js";
import { isInspirationBoard } from "./inspirationBoards.js";
import {
  restoreTask,
  mergeRestoredNote,
  forgetRecoveryOrigin,
} from "./taskRecords.js";
export { setTaskRemark, deleteTask } from "./taskRecords.js";

export const id = (prefix = "o") =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)}`;
export const now = () => new Date().toISOString();
export const makeBlock = (text = "", done = false) => ({
  id: id("b"),
  runs: [{ type: "text", text }],
  done,
  createdAt: now(),
  completedAt: done ? now() : null,
});
export const blockText = (block) =>
  block.runs
    .map((r) => (r.type === "text" ? r.text : `[[${r.label}]]`))
    .join("");
export const objectText = (object) =>
  object.type === "note"
    ? object.blocks.map(blockText).join("\n")
    : object.title || object.alt || "";
export const objectLabel = (object) =>
  objectText(object)
    .split("\n")
    .find((s) => s.trim())
    ?.slice(0, 48) ||
  { note: "空白便签", image: "图片", frame: "分组", collection: "收纳框" }[
    object.type
  ];
export const isComplete = (o) =>
  o.type === "note" &&
  o.noteKind === "checklist" &&
  o.blocks.some((b) => blockText(b).trim()) &&
  o.blocks.filter((b) => blockText(b).trim()).every((b) => b.done);
export const isContainer = (o) => o.type === "frame" || o.type === "collection";
export const getProjectType = (state, boardId) =>
  state.boards.find((b) => b.id === boardId)?.type ||
  state.preferences.views[boardId]?.mode ||
  "canvas";
export const getView = (state, boardId) => ({
  ...defaultView(),
  ...state.preferences.views[boardId],
  mode: getProjectType(state, boardId),
});

// Older backups stored a switchable view mode. Migrate it once to the project.
export function ensureProjectTypes(state) {
  if (!state) return state;
  const missingTypes = state.boards.some((b) => b.type === undefined);
  const legacyViews = Object.values(state.preferences.views).some(
    (view) => "mode" in view,
  );
  if (!missingTypes && !legacyViews) return state;
  return {
    ...state,
    boards: missingTypes
      ? state.boards.map((b) =>
          b.type === undefined
            ? { ...b, type: getProjectType(state, b.id) }
            : b,
        )
      : state.boards,
    preferences: legacyViews
      ? {
          ...state.preferences,
          views: Object.fromEntries(
            Object.entries(state.preferences.views).map(([key, view]) => {
              const { mode, ...navigation } = view;
              return [key, navigation];
            }),
          ),
        }
      : state.preferences,
  };
}

export function createWorkspace() {
  const board = {
    id: id("board"),
    name: "我的画布",
    type: "canvas",
    description: "",
    createdAt: now(),
  };
  return {
    version: 2,
    revision: 0,
    boards: [board],
    objects: [],
    assets: {},
    trash: [],
    preferences: {
      activeBoardId: board.id,
      views: { [board.id]: defaultView() },
    },
  };
}
export function createObject(boardId, type, point = { x: 0, y: 0 }) {
  const base = {
    id: id(),
    boardId,
    type,
    x: point.x,
    y: point.y,
    width: 280,
    height: 190,
    zIndex: Date.now(),
    parentId: null,
    locked: false,
    createdAt: now(),
    updatedAt: now(),
  };
  if (type === "note")
    return { ...base, noteKind: "text", color: "paper", blocks: [makeBlock()] };
  if (type === "frame")
    return {
      ...base,
      width: 160,
      height: 104,
      zIndex: -Date.now(),
      title: "未命名分组",
      collapsed: false,
    };
  if (type === "collection")
    return {
      ...base,
      width: 64,
      height: 64,
      title: "收纳框",
      collapsed: false,
    };
  return {
    ...base,
    assetId: "",
    alt: "图片",
    naturalWidth: 280,
    naturalHeight: 190,
    crop: null,
    rotation: 0,
    flipX: false,
    annotations: [],
  };
}
export function ensureProjectCollections(state) {
  const missing = state.boards.filter(
    (board) => !primaryCollection(state, board.id),
  );
  return normalizeLayout(
    missing.length
      ? {
          ...state,
          objects: [
            ...state.objects,
            ...missing.map((board) => createObject(board.id, "collection")),
          ],
        }
      : state,
  );
}

export function migrateV1(value) {
  const legacy = parseLegacy(JSON.stringify(value));
  if (!legacy.projects.length) return createWorkspace();
  const state = createWorkspace();
  state.boards = legacy.projects.map((p) => ({
    id: p.id,
    name: p.name,
    type: "canvas",
    description: p.description,
    createdAt: p.createdAt,
  }));
  state.preferences = {
    activeBoardId: state.boards[0].id,
    views: Object.fromEntries(
      state.boards.map((b) => [
        b.id,
        { ...defaultView(), hideCompleted: legacy.hideCompleted },
      ]),
    ),
  };
  state.objects = legacy.projects.flatMap((p) =>
    legacy.tasks
      .filter((t) => t.projectId === p.id)
      .map((t, i) => ({
        ...createObject(p.id, "note", {
          x: 80 + (i % 3) * 320,
          y: 80 + Math.floor(i / 3) * 240,
        }),
        noteKind: "checklist",
        createdAt: t.createdAt,
        blocks: [
          {
            ...makeBlock(t.text, t.completed),
            id: t.id,
            createdAt: t.createdAt,
            completedAt: t.completedAt,
          },
        ],
      })),
  );
  return state;
}
const requireValue = (valid, message) => {
  if (!valid) throw new Error(message);
};
const record = (v) => v && typeof v === "object" && !Array.isArray(v);
const string = (v) => typeof v === "string";
const date = (v) => string(v) && Number.isFinite(Date.parse(v));
export function validateWorkspace(value) {
  requireValue(record(value) && value.version === 2, "不支持的工作区版本。");
  requireValue(
    Array.isArray(value.boards) &&
      Array.isArray(value.objects) &&
      Array.isArray(value.trash) &&
      record(value.assets),
    "工作区结构不完整。",
  );
  requireValue(
    Number.isSafeInteger(value.revision) && value.revision >= 0,
    "保存版本无效。",
  );
  const ids = new Set(),
    boardIds = new Set(),
    names = new Set();
  let scopeIds = ids;
  const identities = new Map();
  const identity = (key, kind) => {
    requireValue(
      !identities.has(key) || identities.get(key) === kind,
      "回收记录的标识与现有对象冲突。",
    );
    identities.set(key, kind);
  };
  const unique = (key) => {
    requireValue(
      string(key) && key.length > 0 && key.length <= 200 && !scopeIds.has(key),
      "存在无效或重复标识。",
    );
    scopeIds.add(key);
  };
  for (const b of value.boards) {
    requireValue(record(b), "项目无效。");
    requireValue(
      b.type === undefined || ["canvas", "arranged"].includes(b.type),
      "项目类型无效。",
    );
    unique(b.id);
    identity(b.id, "project");
    requireValue(
      string(b.name) &&
        b.name.trim() &&
        b.name.length <= 80 &&
        !names.has(b.name.trim()),
      "项目名称无效或重复。",
    );
    names.add(b.name.trim());
    boardIds.add(b.id);
    requireValue(date(b.createdAt), "项目日期无效。");
  }
  const checkObject = (o, archived = false) => {
    requireValue(record(o), "对象无效。");
    unique(o.id);
    identity(o.id, `object:${o.type}`);
    requireValue(
      ["note", "image", "frame", "collection"].includes(o.type),
      "未知的对象类型。",
    );
    requireValue(
      string(o.boardId) && (archived || boardIds.has(o.boardId)),
      "对象所属项目不存在。",
    );
    requireValue(
      ["x", "y", "width", "height", "zIndex"].every((k) =>
        Number.isFinite(o[k]),
      ) &&
        o.width > 0 &&
        o.height > 0,
      "对象位置或尺寸无效。",
    );
    requireValue(
      typeof o.locked === "boolean" &&
        (o.parentId === null || string(o.parentId)),
      "对象属性无效。",
    );
    requireValue(date(o.createdAt) && date(o.updatedAt), "对象日期无效。");
    if (isContainer(o))
      requireValue(
        string(o.title) && typeof o.collapsed === "boolean",
        "容器属性无效。",
      );
    if (o.type === "frame")
      requireValue(
        o.fixedBounds === undefined || typeof o.fixedBounds === "boolean",
        "灵感板尺寸属性无效。",
      );
    if (o.type === "note") {
      requireValue(
        o.blockOrder === undefined ||
          (Array.isArray(o.blockOrder) &&
            o.blockOrder.every(string) &&
            new Set(o.blockOrder).size === o.blockOrder.length),
        "清单顺序无效。",
      );
      requireValue(
        o.recoveryOrigin === undefined ||
          (record(o.recoveryOrigin) &&
            string(o.recoveryOrigin.parentId) &&
            Number.isFinite(o.recoveryOrigin.x) &&
            Number.isFinite(o.recoveryOrigin.y)),
        "清单恢复位置无效。",
      );
      requireValue(
        o.layoutHeight === undefined ||
          (Number.isFinite(o.layoutHeight) && o.layoutHeight > 0),
        "便签显示尺寸无效。",
      );
      requireValue(
        ["text", "checklist"].includes(o.noteKind) &&
          ["paper", "sage", "sand", "rose", "blue", "lavender"].includes(
            o.color,
          ) &&
          Array.isArray(o.blocks),
        "便签结构无效。",
      );
      for (const b of o.blocks) {
        requireValue(record(b), "清单条目无效。");
        unique(b.id);
        identity(b.id, `block:${o.id}`);
        requireValue(
          b.remark === undefined ||
            (record(b.remark) &&
              string(b.remark.text) &&
              date(b.remark.updatedAt)),
          "待办备注无效。",
        );
        requireValue(
          Array.isArray(b.runs) &&
            typeof b.done === "boolean" &&
            date(b.createdAt) &&
            (b.done ? date(b.completedAt) : b.completedAt === null),
          "清单条目无效。",
        );
        for (const r of b.runs)
          requireValue(
            record(r) &&
              (r.type === "text"
                ? string(r.text)
                : r.type === "ref" && string(r.targetId) && string(r.label)),
            "文字或引用片段无效。",
          );
      }
    }
    if (o.type === "image") {
      requireValue(
        record(value.assets[o.assetId]) &&
          string(o.alt) &&
          Number.isFinite(o.naturalWidth) &&
          o.naturalWidth > 0 &&
          Number.isFinite(o.naturalHeight) &&
          o.naturalHeight > 0,
        "图片缺少资源或尺寸无效。",
      );
      validateImageData(o);
    }
  };
  value.objects.forEach((o) => checkObject(o));
  for (const batch of value.trash) {
    requireValue(
      record(batch) && Array.isArray(batch.objects) && date(batch.deletedAt),
      "回收站无效。",
    );
    unique(batch.id);
    identity(batch.id, "trash");
    // Recovery snapshots may share a note identity with a shell restored by a task.
    // Live identities and identities within each archive remain strictly unique.
    scopeIds = new Set();
    if (batch.kind === "task") {
      requireValue(
        record(batch.task) &&
          record(batch.task.note) &&
          batch.task.note.type === "note" &&
          batch.task.noteId === batch.task.note.id &&
          batch.task.note.blocks?.length === 0 &&
          batch.objects.length === 0 &&
          record(batch.task.block),
        "待办回收记录无效。",
      );
      checkObject({ ...batch.task.note, blocks: [batch.task.block] }, true);
    }
    batch.objects.forEach((o) => checkObject(o, true));
    scopeIds = ids;
  }
  const byId = new Map(value.objects.map((o) => [o.id, o]));
  for (const o of value.objects)
    if (o.parentId) {
      const p = byId.get(o.parentId);
      requireValue(
        p && isContainer(p) && p.boardId === o.boardId,
        "对象容器归属无效。",
      );
      const seen = new Set([o.id]);
      let cursor = p;
      while (cursor) {
        requireValue(!seen.has(cursor.id), "分组不能循环嵌套。");
        seen.add(cursor.id);
        cursor = byId.get(cursor.parentId);
      }
    }
  for (const [key, a] of Object.entries(value.assets)) {
    requireValue(
      record(a) &&
        a.id === key &&
        string(a.mime) &&
        /^image\/(png|jpeg|webp|gif|avif|bmp|svg\+xml)$/.test(a.mime) &&
        Number.isSafeInteger(a.byteLength) &&
        a.byteLength > 0,
      "图片资源元数据无效。",
    );
  }
  requireValue(
    record(value.preferences) &&
      record(value.preferences.views) &&
      (value.boards.length === 0 ||
        boardIds.has(value.preferences.activeBoardId)),
    "项目视角设置无效。",
  );
  for (const [key, v] of Object.entries(value.preferences.views)) {
    requireValue(
      boardIds.has(key) &&
        record(v) &&
        ["x", "y", "scale"].every((k) => Number.isFinite(v[k])) &&
        v.scale >= 0.1 &&
        v.scale <= 4 &&
        (v.mode === undefined || ["canvas", "arranged"].includes(v.mode)) &&
        (v.arrangedScroll === undefined ||
          (Number.isFinite(v.arrangedScroll) && v.arrangedScroll >= 0)) &&
        ["hideCompleted", "gridVisible", "snapEnabled"].every(
          (k) => typeof v[k] === "boolean",
        ),
      "视角设置无效。",
    );
  }
  return ensureProjectTypes(structuredClone(value));
}
export function parseWorkspace(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("文件不是有效的 JSON。");
  }
  return value.version === 1 ? migrateV1(value) : validateWorkspace(value);
}
export const patchObjects = (state, patches) =>
  normalizeLayout({
    ...state,
    objects: state.objects.map((o) =>
      patches[o.id]
        ? {
            ...(["x", "y", "parentId", "boardId"].some(
              (k) => k in patches[o.id],
            )
              ? forgetRecoveryOrigin(o)
              : o),
            ...patches[o.id],
            updatedAt: now(),
          }
        : o,
    ),
  });
export function movableIds(state, selected) {
  const result = new Set();
  for (const key of selectionRoots(state.objects, selected)) {
    const o = state.objects.find((x) => x.id === key);
    if (!o || effectivelyLocked(state.objects, key)) continue;
    const children = descendantIds(state.objects, [key]);
    if (state.objects.some((c) => children.has(c.id) && c.locked)) continue;
    children.forEach((key) => result.add(key));
  }
  return result;
}
export function moveObjects(
  state,
  selected,
  delta,
  { constrainBoards = true } = {},
) {
  const ids = movableIds(state, selected);
  if (!ids.size) return state;
  if (constrainBoards) {
    const roots = state.objects.filter(
      (o) => selected.includes(o.id) && ids.has(o.id) && isInspirationBoard(o),
    );
    const barriers = frameDragBarriers(state.objects, roots).filter(
      ({ frame }) => isInspirationBoard(frame),
    );
    if (barriers.length)
      delta = constrainFrameMove(barriers, { x: 0, y: 0 }, delta, {
        snap: false,
      });
  }
  return normalizeLayout({
    ...state,
    objects: state.objects.map((o) =>
      ids.has(o.id)
        ? {
            ...forgetRecoveryOrigin(o),
            x: o.x + delta.x,
            y: o.y + delta.y,
            updatedAt: now(),
          }
        : o,
    ),
  });
}
export function collectObjects(state, selected, containerId) {
  const box = state.objects.find((o) => o.id === containerId);
  if (
    !box ||
    box.type !== "collection" ||
    effectivelyLocked(state.objects, box.id)
  )
    return state;
  const roots = selectionRoots(state.objects, selected);
  // Only reparent roots: selecting a group and a child must retain its tree.
  const moving = movableIds(state, roots);
  const allowed = new Set(
    roots.filter((key) => {
      const o = state.objects.find((item) => item.id === key);
      return (
        moving.has(key) && o.boardId === box.boardId && o.parentId !== box.id
      );
    }),
  );
  if (!allowed.size) return state;
  if (descendantIds(state.objects, [...allowed]).has(containerId)) return state;
  return normalizeLayout({
    ...state,
    objects: state.objects.map((o) =>
      allowed.has(o.id)
        ? {
            ...forgetRecoveryOrigin(o),
            parentId: containerId,
            updatedAt: now(),
          }
        : o,
    ),
  });
}
export function takeOutObject(state, key, point, boardId) {
  const object = state.objects.find((o) => o.id === key);
  if (
    !object ||
    (boardId && object.boardId !== boardId) ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !ancestors(state.objects, key).some((o) => o.type === "collection")
  )
    return state;
  const moving = movableIds(state, [key]);
  if (!moving.has(key)) return state;
  const dx = point.x - object.x,
    dy = point.y - object.y;
  return normalizeLayout(
    placeBoardObjects(
      {
        ...state,
        objects: state.objects.map((o) =>
          moving.has(o.id)
            ? {
                ...forgetRecoveryOrigin(o),
                x: o.x + dx,
                y: o.y + dy,
                parentId: o.id === key ? null : o.parentId,
                updatedAt: now(),
              }
            : o,
        ),
      },
      [key],
    ),
  );
}
export function reparentObjects(state, selected, frameId) {
  const frame = state.objects.find((o) => o.id === frameId);
  if (
    frameId &&
    (!frame ||
      frame.type !== "frame" ||
      effectivelyLocked(state.objects, frameId))
  )
    return state;
  const roots = selectionRoots(state.objects, selected),
    all = descendantIds(state.objects, roots);
  if (all.has(frameId)) return state;
  const allowed = new Set(
    roots.filter((key) => {
      const o = state.objects.find((o) => o.id === key);
      return (
        !effectivelyLocked(state.objects, key) &&
        (!frame || (o.boardId === frame.boardId && o.type !== "frame"))
      );
    }),
  );
  if (!allowed.size) return state;
  return normalizeLayout({
    ...state,
    objects: state.objects.map((o) =>
      allowed.has(o.id)
        ? {
            ...forgetRecoveryOrigin(o),
            parentId: frameId || null,
            updatedAt: now(),
          }
        : o,
    ),
  });
}
export function groupObjects(state, selected) {
  const roots = new Set(selectionRoots(state.objects, selected));
  const members = state.objects.filter(
    (o) => roots.has(o.id) && !effectivelyLocked(state.objects, o.id),
  );
  if (
    !members.length ||
    members.some(
      (o) =>
        o.type === "frame" ||
        ancestors(state.objects, o.id).some((p) => p.type === "frame"),
    ) ||
    members.some((o) => o.boardId !== members[0].boardId)
  )
    return state;
  const rect = bounds(members);
  const frame = {
    ...createObject(members[0].boardId, "frame", {
      x: rect.x - 24,
      y: rect.y - 48,
    }),
    width: rect.width + 48,
    height: rect.height + 72,
    parentId:
      ancestors(state.objects, members[0].id).find(
        (p) =>
          p.type === "frame" &&
          members.every((o) =>
            ancestors(state.objects, o.id).some((a) => a.id === p.id),
          ),
      )?.id || null,
  };
  return normalizeLayout({
    ...state,
    objects: [
      ...state.objects.map((o) =>
        members.some((m) => m.id === o.id)
          ? { ...forgetRecoveryOrigin(o), parentId: frame.id }
          : o,
      ),
      frame,
    ],
  });
}
export function deleteCollectedObjects(state, containerId, selected = null) {
  const container = state.objects.find((o) => o.id === containerId);
  if (
    !container ||
    !isContainer(container) ||
    (container.type !== "collection" &&
      !ancestors(state.objects, containerId).some(
        (o) => o.type === "collection",
      ))
  )
    return state;
  const members = state.objects.filter(
    (o) =>
      o.parentId === containerId &&
      o.boardId === container.boardId &&
      (!selected || selected.includes(o.id)),
  );
  const movable = movableIds(
    state,
    members.map((o) => o.id),
  );
  return deleteObjects(
    state,
    members.filter((o) => movable.has(o.id)).map((o) => o.id),
    true,
  );
}

export function deleteObjects(
  state,
  selected,
  withContents = false,
  releaseOrigins = {},
) {
  const targets = state.objects.filter(
    (o) => selected.includes(o.id) && !effectivelyLocked(state.objects, o.id),
  );
  const remove = new Set(targets.map((o) => o.id));
  if (withContents)
    for (const key of descendantIds(state.objects, [...remove]))
      if (!effectivelyLocked(state.objects, key)) remove.add(key);
  if (!remove.size) return state;
  const archived = state.objects.filter((o) => remove.has(o.id));
  const releases = [];
  let objects = state.objects
    .filter((o) => !remove.has(o.id))
    .map((o) => {
      if (!remove.has(o.parentId)) return o;
      const p = state.objects.find((t) => t.id === o.parentId);
      const survivingParent = ancestors(state.objects, o.id).find(
        (a) => !remove.has(a.id),
      );
      const index = state.objects
        .filter((x) => x.parentId === o.parentId)
        .findIndex((x) => x.id === o.id);
      if (p?.type === "collection" && movableIds(state, [o.id]).has(o.id))
        releases.push({
          id: o.id,
          x:
            (releaseOrigins[p.id] || p).x +
            (releaseOrigins[p.id] || p).width +
            24 +
            (index % 3) * 32 -
            o.x,
          y: (releaseOrigins[p.id] || p).y + index * 32 - o.y,
        });
      return {
        ...o,
        parentId: survivingParent?.id || null,
      };
    });
  for (const release of releases) {
    const moving = descendantIds(objects, [release.id]);
    objects = objects.map((o) =>
      moving.has(o.id) ? { ...o, x: o.x + release.x, y: o.y + release.y } : o,
    );
  }
  return normalizeLayout({
    ...state,
    objects,
    trash: [
      { id: id("trash"), objects: archived, deletedAt: now() },
      ...state.trash,
    ],
  });
}
export function restoreTrash(state, batchId) {
  const batch = state.trash.find((t) => t.id === batchId);
  if (!batch) return state;
  let boards = state.boards,
    preferences = state.preferences;
  if (!boards.length) {
    const fresh = createWorkspace();
    boards = fresh.boards;
    preferences = fresh.preferences;
  }
  if (batch.kind === "task")
    return restoreTask(
      boards === state.boards ? state : { ...state, boards, preferences },
      batch,
    );
  const boardIds = new Set(boards.map((b) => b.id));
  const restored = batch.objects.map((o) => ({
    ...o,
    boardId: boardIds.has(o.boardId) ? o.boardId : boards[0].id,
  }));
  const existingIdentities = new Map(
    state.objects.flatMap((o) => [
      [o.id, `object:${o.type}`],
      ...(o.blocks || []).map((b) => [b.id, `block:${o.id}`]),
    ]),
  );
  for (const o of restored) {
    if (
      existingIdentities.has(o.id) &&
      existingIdentities.get(o.id) !== `object:${o.type}`
    )
      return state;
    for (const b of o.blocks || [])
      if (
        existingIdentities.has(b.id) &&
        existingIdentities.get(b.id) !== `block:${o.id}`
      )
        return state;
  }
  if (
    restored.some(
      (o) =>
        state.objects.some((live) => live.id === o.id) &&
        effectivelyLocked(state.objects, o.id),
    )
  )
    return state;
  const all = [
    ...state.objects.map((o) => {
      const archived = restored.find((r) => r.id === o.id);
      return o.type === "note" && archived?.type === "note"
        ? mergeRestoredNote(o, archived)
        : o;
    }),
    ...restored.filter((o) => !state.objects.some((live) => live.id === o.id)),
  ];
  const objects = all.map((o) => {
    const origin = o.recoveryOrigin;
    if (
      origin &&
      o.parentId === null &&
      o.x === origin.x &&
      o.y === origin.y &&
      all.some(
        (p) =>
          p.id === origin.parentId && isContainer(p) && p.boardId === o.boardId,
      )
    )
      return { ...forgetRecoveryOrigin(o), parentId: origin.parentId };
    return o.parentId &&
      !all.some((p) => p.id === o.parentId && p.boardId === o.boardId)
      ? { ...o, parentId: null }
      : o;
  });
  return normalizeLayout(
    placeBoardObjects(
      {
        ...state,
        boards,
        preferences,
        objects,
        trash: state.trash.filter((t) => t.id !== batchId),
      },
      restored.map((o) => o.id),
    ),
  );
}
export function duplicateObjects(state, selected, offset = { x: 24, y: 24 }) {
  const chosen = descendantIds(state.objects, selected);
  const originals = state.objects.filter((o) => chosen.has(o.id));
  const mapping = new Map(originals.map((o) => [o.id, id()]));
  const copies = originals.map((o) => ({
    ...structuredClone(o),
    id: mapping.get(o.id),
    locked: false,
    x: o.x + offset.x,
    y: o.y + offset.y,
    zIndex: o.type === "frame" ? o.zIndex : Date.now(),
    parentId: mapping.get(o.parentId) || null,
    createdAt: now(),
    updatedAt: now(),
    ...(o.type === "note"
      ? {
          blocks: o.blocks.map((b) => ({
            ...b,
            id: id("b"),
            runs: b.runs.map((r) =>
              r.type === "ref"
                ? { ...r, targetId: mapping.get(r.targetId) || r.targetId }
                : { ...r },
            ),
          })),
        }
      : {}),
  }));
  return normalizeLayout(
    placeBoardObjects(
      { ...state, objects: [...state.objects, ...copies] },
      copies.map((o) => o.id),
    ),
  );
}
export function createImageNote(state, imageId) {
  const image = state.objects.find(
    (o) => o.id === imageId && o.type === "image",
  );
  if (!image || image.locked) return state;
  const reference = {
    ...makeBlock(),
    runs: [
      {
        type: "ref",
        targetId: image.id,
        label: `图片：${image.alt || "未命名图片"}`,
      },
    ],
  };
  const note = {
    ...createObject(image.boardId, "note", {
      x: image.x + image.width + 32,
      y: image.y,
    }),
    color: "sand",
    blocks: [reference, makeBlock()],
  };
  return { ...state, objects: [...state.objects, note] };
}

export const convertNote = (note, kind) =>
  note.type === "note" && ["text", "checklist"].includes(kind)
    ? {
        ...note,
        noteKind: kind,
        blocks: note.blocks.map((b) =>
          kind === "checklist" && !blockText(b).trim()
            ? { ...b, spacer: true }
            : b,
        ),
        updatedAt: now(),
      }
    : note;
export function addBoard(state, name, type = "canvas") {
  if (!["canvas", "arranged"].includes(type)) throw new Error("项目类型无效。");
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed.length > 80 ||
    state.boards.some((b) => b.name === trimmed)
  )
    throw new Error("项目名不能为空、重复或超过 80 字。");
  const board = {
    id: id("board"),
    name: trimmed,
    type,
    description: "",
    createdAt: now(),
  };
  const collection = createObject(board.id, "collection");
  board.primaryCollectionId = collection.id;
  return {
    ...state,
    boards: [...state.boards, board],
    objects: [...state.objects, collection],
    preferences: {
      ...state.preferences,
      activeBoardId: board.id,
      views: { ...state.preferences.views, [board.id]: defaultView() },
    },
  };
}
export function removeBoard(state, boardId) {
  const members = state.objects.filter((o) => o.boardId === boardId);
  const boards = state.boards.filter((b) => b.id !== boardId);
  const views = { ...state.preferences.views };
  delete views[boardId];
  const next = {
    ...state,
    boards,
    objects: state.objects.filter((o) => o.boardId !== boardId),
    trash: members.length
      ? [
          { id: id("trash"), deletedAt: now(), objects: members },
          ...state.trash,
        ]
      : state.trash,
    preferences: {
      ...state.preferences,
      activeBoardId: boards[0]?.id || "",
      views,
    },
  };
  return boards.length ? next : addBoard(next, "我的画布");
}
export function moveToBoard(state, selected, boardId) {
  if (!state.boards.some((b) => b.id === boardId)) return state;
  const chosen = movableIds(state, selected);
  // The frame keeps its identity when moved; only its containing project changes.
  // Agent session history and immutable dispatch scopes stay at their original keys.
  const codexBindings =
    state.codexBindings &&
    Object.fromEntries(
      Object.entries(state.codexBindings).map(([key, binding]) => {
        const [source, page] = JSON.parse(key);
        const moved = state.objects.some(
          (o) => o.id === page && o.boardId === source && chosen.has(o.id),
        );
        return [moved ? JSON.stringify([boardId, page]) : key, binding];
      }),
    );
  return normalizeLayout(
    placeBoardObjects(
      {
        ...state,
        ...(codexBindings ? { codexBindings } : {}),
        objects: state.objects.map((o) =>
          chosen.has(o.id)
            ? {
                ...o,
                boardId,
                parentId: chosen.has(o.parentId) ? o.parentId : null,
              }
            : o,
        ),
      },
      [...chosen],
    ),
  );
}
