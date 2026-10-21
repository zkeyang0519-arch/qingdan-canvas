import {
  duplicateObjects,
  groupObjects,
  patchObjects,
  deleteObjects,
  collectObjects,
  convertNote,
  reparentObjects,
  isContainer,
} from "./model.js";
import {
  ancestors,
  descendantIds,
  effectivelyLocked,
  selectionRoots,
} from "./layout.js";
import { primaryCollection } from "./collectionDock.js";

export const noteColors = [
  ["paper", "白纸"],
  ["sage", "鼠尾草"],
  ["sand", "暖沙"],
  ["rose", "浅玫瑰"],
  ["blue", "雾蓝"],
  ["lavender", "浅紫"],
];

export function buildCanvasMenu({
  state,
  context,
  selection,
  boardId,
  readOnly = false,
}) {
  const object = state.objects.find(
    (o) => o.id === context.objectId && o.boardId === boardId,
  );
  // The right-click target determines the menu, even when a previous selection remains.
  const ids = object
    ? (selection.includes(object.id) ? selection : [object.id]).filter((id) =>
        state.objects.some((o) => o.id === id && o.boardId === boardId),
      )
    : [];
  const target = { ids, objectId: object?.id, point: context.world };
  const item = (id, label, options = {}) => ({
    id,
    label,
    target,
    disabled: readOnly,
    ...options,
  });
  const locked = object && effectivelyLocked(state.objects, object.id);
  const dock = primaryCollection(state, boardId);
  const includesDock = ids.includes(dock?.id);
  const items = [
    item("new-note", "在此新建便签", {
      shortcut: "N",
      disabled: readOnly || (object?.type === "frame" && locked),
    }),
    item("new-checklist", "在此新建清单", {
      disabled: readOnly || (object?.type === "frame" && locked),
    }),
    item("paste", "在此粘贴", { shortcut: "Ctrl V" }),
    item("image", "添加图片"),
    { separator: true },
  ];
  if (!object)
    return [
      ...items,
      item("fit", "适应全部内容", { disabled: false }),
      item("help", "使用帮助", { disabled: false }),
    ];
  const disabled = readOnly || locked;
  if (object.type === "note")
    items.push(
      item("edit", "编辑文字", { disabled, shortcut: "Enter" }),
      item("convert", object.noteKind === "text" ? "转为清单" : "转为文字", {
        disabled,
      }),
      item("reference", "插入便签引用", { disabled }),
      item("backlinks", "查看反向引用", { disabled: false }),
      item("colors", "便签颜色", { disabled }),
    );
  if (isContainer(object)) items.push(item("rename", "重命名", { disabled }));
  items.push(
    item("duplicate", "制作副本", {
      shortcut: "Ctrl D",
      disabled: readOnly || includesDock,
    }),
  );
  const roots = selectionRoots(state.objects, ids).map((id) =>
    state.objects.find((o) => o.id === id),
  );
  if (!includesDock && roots.every((o) => o.type !== "frame")) {
    if (
      roots.every(
        (o) => !ancestors(state.objects, o.id).some((p) => p.type === "frame"),
      )
    ) {
      items.push(
        item("group", "创建分组框", {
          disabled:
            readOnly ||
            roots.every((o) => effectivelyLocked(state.objects, o.id)),
        }),
      );
    }
    items.push(
      item("join", "加入现有分组", {
        disabled: readOnly || !groupTargets(state, ids, boardId).length,
      }),
    );
  }
  if (object.parentId) items.push(item("detach", "移出容器", { disabled }));
  items.push(
    { separator: true },
    item("front", "置于顶层", { disabled: disabled || includesDock }),
    item("back", "置于底层", { disabled: disabled || includesDock }),
    item(object.locked ? "unlock" : "lock", object.locked ? "解锁" : "锁定", {
      disabled:
        readOnly || ancestors(state.objects, object.id).some((o) => o.locked),
    }),
    { separator: true },
  );
  if (isContainer(object))
    items.push(
      item("dissolve", "解散并保留内容", {
        disabled: disabled || includesDock,
        danger: true,
      }),
    );
  items.push(
    item(
      "delete",
      ids.length > 1 ? `删除 ${ids.length} 个元素` : "删除此元素",
      {
        disabled:
          disabled ||
          includesDock ||
          !dock ||
          effectivelyLocked(state.objects, dock.id),
        danger: true,
      },
    ),
  );
  return items;
}

export function groupTargets(state, ids, boardId) {
  const roots = selectionRoots(state.objects, ids).map((id) =>
    state.objects.find((o) => o.id === id),
  );
  if (
    !roots.length ||
    roots.some(
      (o) =>
        o.type === "frame" || o.id === primaryCollection(state, boardId)?.id,
    )
  )
    return [];
  const moving = roots.filter(
    (o) => o.boardId === boardId && !effectivelyLocked(state.objects, o.id),
  );
  if (!moving.length) return [];
  const descendants = descendantIds(state.objects, ids);
  return state.objects.filter(
    (o) =>
      o.boardId === boardId &&
      o.type === "frame" &&
      !effectivelyLocked(state.objects, o.id) &&
      !descendants.has(o.id) &&
      moving.some((m) => m.parentId !== o.id),
  );
}

// Re-read objects and locks when an action runs; a collaborator may have edited
// them while the menu or its dialog was open.
export function applyCanvasMenuAction(
  state,
  action,
  { boardId, readOnly = false },
) {
  if (readOnly || !action?.target) return state;
  const dockId = primaryCollection(state, boardId)?.id;
  const chosen = state.objects.filter(
    (o) => action.target.ids.includes(o.id) && o.boardId === boardId,
  );
  const editable = chosen.filter(
    (o) => !effectivelyLocked(state.objects, o.id),
  );
  const movable = editable.filter((o) => o.id !== dockId);
  const ids = movable.map((o) => o.id);
  const object = editable.find((o) => o.id === action.target.objectId);
  const patch = (objects, changes) =>
    objects.length
      ? patchObjects(
          state,
          Object.fromEntries(objects.map((o) => [o.id, changes])),
        )
      : state;
  switch (action.id) {
    case "convert": {
      if (object?.type !== "note") return state;
      const next = convertNote(
        object,
        object.noteKind === "text" ? "checklist" : "text",
      );
      return patch([object], { noteKind: next.noteKind, blocks: next.blocks });
    }
    case "colors":
      return noteColors.some(([color]) => color === action.value)
        ? patch(
            editable.filter((o) => o.type === "note"),
            { color: action.value },
          )
        : state;
    case "rename":
      return object && isContainer(object) && typeof action.value === "string"
        ? patch([object], {
            title: action.value.trim().slice(0, 80) || "未命名",
          })
        : state;
    case "duplicate":
      return duplicateObjects(
        state,
        chosen.filter((o) => o.id !== dockId).map((o) => o.id),
      );
    case "group":
      return groupObjects(state, ids);
    case "join":
      return groupTargets(state, ids, boardId).some(
        (o) => o.id === action.value,
      )
        ? reparentObjects(state, ids, action.value)
        : state;
    case "detach":
      return reparentObjects(state, ids, null);
    case "front":
    case "back": {
      const layers = state.objects
        .filter((o) => o.boardId === boardId)
        .map((o) => o.zIndex);
      return patch(movable, {
        zIndex:
          action.id === "front"
            ? Math.max(0, ...layers) + 1
            : Math.min(0, ...layers) - 1,
      });
    }
    case "lock":
    case "unlock":
      return patch(
        chosen.filter(
          (o) => !ancestors(state.objects, o.id).some((p) => p.locked),
        ),
        { locked: action.id === "lock" },
      );
    case "dissolve":
      return deleteObjects(
        state,
        movable.filter(isContainer).map((o) => o.id),
      );
    case "delete":
      return collectObjects(state, ids, dockId);
    default:
      return state;
  }
}
