import { useCallback, useEffect, useRef, useState } from "react";
import {
  collectObjects,
  id,
  movableIds,
  patchObjects,
  takeOutObject,
} from "./model.js";
import {
  ancestors,
  descendantIds,
  effectivelyLocked,
  hiddenByAncestor,
  selectionRoots,
} from "./layout.js";
import { collectionTouches } from "./collectionWrap.js";
import { COLLECTION_DOCK } from "./collectionDock.js";

// Arranged dragging changes presentation only. Ownership is committed once on drop.
export default function useArrangedCollection({
  enabled,
  boardId,
  blocked,
  toolsHidden,
  workspace,
  arrangement,
  viewport,
  dockedCollectionId,
  selection,
  setSelection,
  onExit,
  onToast,
  suppressClick,
}) {
  const gesture = useRef(null),
    timer = useRef(null),
    latest = useRef(null);
  const [session, setSession] = useState(null);
  latest.current = {
    enabled,
    boardId,
    blocked,
    toolsHidden,
    workspace,
    arrangement,
    dockedCollectionId,
    onExit,
    onToast,
    setSelection,
  };
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    const g = gesture.current;
    if (g && viewport.current?.hasPointerCapture(g.pointerId))
      viewport.current.releasePointerCapture(g.pointerId);
    gesture.current = null;
    setSession(null);
    latest.current.arrangement.release();
  }, [viewport]);
  useEffect(() => {
    cancel();
  }, [enabled, boardId, blocked, toolsHidden, cancel]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const g = gesture.current;
    if (!g) return;
    if (g.phase === "collecting") {
      if (
        g.ids.some(
          (key) =>
            workspace.state.objects.find((o) => o.id === key)?.parentId !==
            g.target.id,
        )
      )
        cancel();
    } else if (g.sourceObjects !== workspace.state.objects) cancel();
  }, [workspace.state.objects, cancel]);

  const after = (ms) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      cancel,
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : ms,
    );
  };
  const makeSession = (keys, anchorId) => {
    const state = workspace.current.current;
    const moving = movableIds(state, keys);
    const ids = selectionRoots(state.objects, keys).filter(
      (key) =>
        moving.has(key) &&
        key !== dockedCollectionId &&
        arrangement.layout?.rects.has(key) &&
        state.objects.find((o) => o.id === key)?.boardId === boardId,
    );
    if (!ids.length) return null;
    const snapshot = state.objects.map((o) => {
      const r = arrangement.layout.rects.get(o.id);
      return r ? { ...o, ...r, layoutHeight: r.height, fixedHeight: false } : o;
    });
    const roots = ids.map((key) => ({
      object: snapshot.find((o) => o.id === key),
      screen: arrangement.screenRect(key),
      // Images, including those inside a group snapshot, retain their size.
      scale: 1,
    }));
    const allIds = descendantIds(state.objects, ids);
    const anchorRoot =
      roots.find(({ object }) =>
        descendantIds(state.objects, [object.id]).has(anchorId),
      ) || roots[0];
    const anchor = arrangement.screenRect(anchorId) || anchorRoot.screen;
    return {
      token: id("arranged-collect"),
      ids,
      allIds,
      roots,
      snapshot,
      visibleIds: new Set(arrangement.layout.rects.keys()),
      sourceObjects: state.objects,
      boardId,
      phase: "pending",
      delta: { x: 0, y: 0 },
      anchor: {
        x:
          anchorRoot.screen.x +
          (anchor.x - anchorRoot.screen.x) * anchorRoot.scale,
        y:
          anchorRoot.screen.y +
          (anchor.y - anchorRoot.screen.y) * anchorRoot.scale,
      },
    };
  };
  const targetAt = (g) => {
    const state = workspace.current.current;
    const rects = g.roots.map(({ screen, scale }) => ({
      x: screen.x + g.delta.x,
      y: screen.y + g.delta.y,
      width: screen.width * scale,
      height: screen.height * scale,
    }));
    return (
      state.objects
        .filter(
          (o) =>
            o.type === "collection" &&
            o.boardId === boardId &&
            !g.allIds.has(o.id) &&
            !effectivelyLocked(state.objects, o.id) &&
            (o.id === dockedCollectionId || arrangement.layout.rects.has(o.id)),
        )
        .map((o) => ({
          ...o,
          ...(o.id === dockedCollectionId
            ? COLLECTION_DOCK
            : arrangement.screenRect(o.id)),
        }))
        .sort(
          (a, b) =>
            Number(b.id === dockedCollectionId) -
            Number(a.id === dockedCollectionId),
        )
        .find((r) => collectionTouches(rects, r)) || null
    );
  };
  const returnOrigins = (keys, containerId) => {
    const ctx = latest.current;
    if (!ctx.enabled) return;
    const scroll = viewport.current?.scrollTop || 0;
    const candidates = [
      containerId,
      ...ancestors(ctx.workspace.current.current.objects, containerId)
        .filter((o) => o.type === "collection")
        .map((o) => o.id),
    ];
    const visibleBox = candidates.find(
      (key) =>
        key &&
        (key === ctx.dockedCollectionId ||
          ctx.arrangement.layout?.rects.has(key)),
    );
    const origin =
      (visibleBox === ctx.dockedCollectionId
        ? COLLECTION_DOCK
        : ctx.arrangement.screenRect(visibleBox)) || COLLECTION_DOCK;
    for (const rootId of keys) {
      const all = descendantIds(ctx.workspace.current.current.objects, [
        rootId,
      ]);
      for (const key of all)
        ctx.arrangement.queueBirth(
          key,
          {
            x: origin.x + origin.width / 2,
            y: origin.y + origin.height / 2 + scroll,
          },
          { scale: 0.06, duration: 400, rootId, reveal: key === keys[0] },
        );
    }
  };
  const commit = (g, target) => {
    if (blocked || !enabled) {
      cancel();
      return false;
    }
    const before = workspace.current.current;
    const next = collectObjects(before, g.ids, target.id);
    if (next === before) {
      cancel();
      return false;
    }
    const accepted = g.ids.filter(
      (key) => next.objects.find((o) => o.id === key)?.parentId === target.id,
    );
    const finished = {
      ...g,
      ids: accepted,
      roots: g.roots.filter((r) => accepted.includes(r.object.id)),
      phase: "collecting",
      target,
    };
    gesture.current = finished;
    setSession(finished);
    workspace.update(next);
    setSelection([]);
    let undone = false;
    onToast(`已收纳 ${accepted.length} 个元素`, {
      label: "撤销",
      run: () => {
        const ctx = latest.current;
        if (undone || ctx.blocked || ctx.boardId !== g.boardId) return;
        undone = true;
        cancel();
        ctx.onExit();
        const current = ctx.workspace.current.current;
        if (ctx.workspace.undoIfLast?.(before)) {
          returnOrigins(accepted, target.id);
          ctx.setSelection(accepted);
          return;
        }
        // A toast can outlive another edit: reverse only this ownership change.
        const patches = {};
        for (const key of accepted) {
          const object = current.objects.find((o) => o.id === key);
          if (
            object?.parentId !== target.id ||
            !movableIds(current, [key]).has(key)
          )
            continue;
          const oldParentId = before.objects.find(
            (o) => o.id === key,
          )?.parentId;
          const parent = current.objects.find((o) => o.id === oldParentId);
          const safeParent =
            parent?.type === "frame" &&
            parent.boardId === g.boardId &&
            !effectivelyLocked(current.objects, parent.id) &&
            !hiddenByAncestor(current.objects, parent.id) &&
            !descendantIds(current.objects, [key]).has(parent.id);
          patches[key] = { parentId: safeParent ? parent.id : null };
        }
        const restored = Object.keys(patches);
        if (!restored.length) return;
        returnOrigins(restored, target.id);
        ctx.workspace.update(patchObjects(current, patches));
        ctx.setSelection(restored);
      },
    });
    after(400);
    return true;
  };
  const collect = (keys = selection) => {
    if (!enabled || blocked || toolsHidden || !dockedCollectionId) return false;
    cancel();
    onExit();
    const g = makeSession(keys, keys[0]);
    if (!g) return false;
    arrangement.freeze();
    const target = { ...COLLECTION_DOCK, id: dockedCollectionId };
    return commit({ ...g, startScale: 1 }, target);
  };
  const start = (event, key, keys, point) => {
    if (!enabled || blocked || toolsHidden || event.pointerType === "touch")
      return;
    const object = workspace.current.current.objects.find((o) => o.id === key);
    if (
      !object ||
      event.target.closest(
        ".note-blocks,.add-line,.image-editor,button:not(.collection-icon),input,textarea,[contenteditable=true]",
      )
    )
      return;
    if (object.type === "frame" && !event.target.closest(".frame-heading"))
      return;
    cancel();
    const g = makeSession(keys, key);
    if (!g || !g.allIds.has(key)) return;
    event.preventDefault();
    gesture.current = {
      ...g,
      start: point,
      pointerId: event.pointerId,
    };
    viewport.current.setPointerCapture(event.pointerId);
  };
  const move = (event, point) => {
    const g = gesture.current;
    if (
      !g ||
      !["pending", "dragging"].includes(g.phase) ||
      event.pointerId !== g.pointerId
    )
      return false;
    const delta = { x: point.x - g.start.x, y: point.y - g.start.y };
    if (g.phase === "pending") {
      if (Math.hypot(delta.x, delta.y) < 6) return false;
      arrangement.freeze();
    }
    event.preventDefault();
    const next = { ...g, phase: "dragging", delta };
    next.target = event.altKey ? null : targetAt(next);
    gesture.current = next;
    setSession(next);
    return true;
  };
  const up = (event, point) => {
    const pending = gesture.current;
    if (
      !pending ||
      event.pointerId !== pending.pointerId ||
      !["pending", "dragging"].includes(pending.phase)
    )
      return;
    move(event, point);
    const g = gesture.current;
    if (viewport.current.hasPointerCapture(event.pointerId))
      viewport.current.releasePointerCapture(event.pointerId);
    if (g.phase === "pending") {
      cancel();
      return;
    }
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    if (g.target) commit(g, g.target);
    else {
      const returning = { ...g, phase: "returning" };
      gesture.current = returning;
      setSession(returning);
      after(180);
    }
  };
  const takeOut = (key, containerId) => {
    if (!enabled || blocked) return false;
    cancel();
    onExit();
    const state = workspace.current.current;
    const object = state.objects.find((o) => o.id === key);
    if (!object) return false;
    const next = takeOutObject(
      state,
      key,
      { x: object.x, y: object.y },
      boardId,
    );
    if (next === state) return false;
    const boxId =
      containerId ||
      ancestors(state.objects, key).find((o) => o.type === "collection")?.id;
    returnOrigins([key], boxId);
    workspace.update(next);
    setSelection([key]);
    return true;
  };
  return {
    session,
    start,
    move,
    up,
    cancel,
    collect,
    takeOut,
    hiddenIds: session?.allIds || new Set(),
    receiving: ["dragging", "collecting"].includes(session?.phase)
      ? session.target?.id
      : null,
  };
}
