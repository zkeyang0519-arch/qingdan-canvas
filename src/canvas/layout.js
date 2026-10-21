import { bounds, contains } from "./geometry.js";
import { retainCollectionDocks } from "./collectionDock.js";
import {
  isInspirationBoard,
  boardsOverlap,
  BOARD_GAP,
} from "./inspirationBoards.js";

export const FRAME_PADDING = 24,
  FRAME_TOP = 48,
  COLLECTION_SIZE = 64;
const index = (objects) =>
  objects instanceof Map ? objects : new Map(objects.map((o) => [o.id, o]));
export function ancestors(objects, key) {
  const map = index(objects),
    result = [],
    seen = new Set([key]);
  let o = map.get(key);
  while (o?.parentId && !seen.has(o.parentId)) {
    seen.add(o.parentId);
    o = map.get(o.parentId);
    if (o) result.push(o);
  }
  return result;
}
export function descendantIds(objects, selected) {
  const children = new Map(),
    map = index(objects);
  for (const o of map.values()) {
    const list = children.get(o.parentId) || [];
    list.push(o.id);
    children.set(o.parentId, list);
  }
  const result = new Set(),
    queue = [...selected];
  while (queue.length) {
    const key = queue.pop();
    if (result.has(key) || !map.has(key)) continue;
    result.add(key);
    queue.push(...(children.get(key) || []));
  }
  return result;
}
export function selectionRoots(objects, selected) {
  const map = index(objects),
    chosen = new Set(selected);
  return [...chosen].filter(
    (key) => map.has(key) && !ancestors(map, key).some((o) => chosen.has(o.id)),
  );
}
export const effectivelyLocked = (objects, key) => {
  const map = index(objects);
  return !!map.get(key)?.locked || ancestors(map, key).some((o) => o.locked);
};
export const hiddenByAncestor = (objects, key) =>
  ancestors(objects, key).some((o) => o.type === "collection" || o.collapsed);
export const visibleInspirationBoards = (objects, boardId) =>
  objects.filter(
    (o) =>
      o.boardId === boardId &&
      isInspirationBoard(o) &&
      !hiddenByAncestor(objects, o.id),
  );

// New copies/restored boards keep their content offsets and shift together to
// the first free space to the right. Stored boards do not occupy canvas space.
export function placeBoardObjects(state, selected) {
  const moving = descendantIds(state.objects, selected);
  const boards = state.objects.filter(
    (o) =>
      moving.has(o.id) &&
      isInspirationBoard(o) &&
      !hiddenByAncestor(state.objects, o.id),
  );
  if (!boards.length) return state;
  const obstacles = state.objects.filter(
    (o) =>
      !moving.has(o.id) &&
      isInspirationBoard(o) &&
      !hiddenByAncestor(state.objects, o.id),
  );
  let dx = 0;
  for (let pass = 0; pass <= obstacles.length * boards.length; pass++) {
    let next = dx;
    for (const board of boards)
      for (const obstacle of obstacles) {
        if (
          board.boardId === obstacle.boardId &&
          boardsOverlap({ ...board, x: board.x + dx }, obstacle)
        )
          next = Math.max(
            next,
            obstacle.x + obstacle.width + BOARD_GAP - board.x,
          );
      }
    if (next === dx) break;
    dx = next;
  }
  if (!dx) return state;
  return {
    ...state,
    objects: state.objects.map((o) =>
      moving.has(o.id) ? { ...o, x: o.x + dx } : o,
    ),
  };
}
export const displayRect = (o) => ({
  ...o,
  height:
    o.type === "frame" && o.collapsed
      ? 56
      : o.type === "note"
        ? o.layoutHeight || o.height
        : o.height,
});
export function frameBounds(frame, members) {
  if (frame.fixedBounds === true)
    return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
  if (!members.length)
    return { x: frame.x, y: frame.y, width: 160, height: 104 };
  const b = bounds(members.map(displayRect));
  return {
    x: b.x - FRAME_PADDING,
    y: b.y - FRAME_TOP,
    width: b.width + FRAME_PADDING * 2,
    height: b.height + FRAME_TOP + FRAME_PADDING,
  };
}
export function normalizeLayout(state) {
  if (!state) return state;
  const map = index(state.objects),
    children = new Map(),
    done = new Map(),
    visiting = new Set();
  for (const o of state.objects) {
    const list = children.get(o.parentId) || [];
    list.push(o);
    children.set(o.parentId, list);
  }
  const fit = (o) => {
    if (done.has(o.id)) return done.get(o.id);
    if (visiting.has(o.id)) return o;
    visiting.add(o.id);
    let patch = null;
    if (o.type === "collection")
      patch = { width: COLLECTION_SIZE, height: COLLECTION_SIZE };
    if (o.type === "frame")
      patch = frameBounds(o, (children.get(o.id) || []).map(fit));
    const next =
      patch &&
      Object.entries(patch).some(([k, v]) => Math.abs(o[k] - v) > 0.001)
        ? { ...o, ...patch }
        : o;
    visiting.delete(o.id);
    done.set(o.id, next);
    return next;
  };
  const objects = state.objects.map(fit);
  return retainCollectionDocks(
    objects.some((o, i) => o !== state.objects[i])
      ? { ...state, objects }
      : state,
  );
}
const enclosed = (outer, inner) =>
  contains(outer, inner) &&
  contains(outer, { x: inner.x + inner.width, y: inner.y + inner.height });
export function marqueeRoots(
  objects,
  rect,
  isVisible = () => true,
  { promoteGroups = true } = {},
) {
  const map = index(objects),
    selected = new Set(
      objects
        .filter(
          (o) =>
            isVisible(o) &&
            !hiddenByAncestor(map, o.id) &&
            enclosed(rect, displayRect(o)),
        )
        .map((o) => o.id),
    );
  const frames = (promoteGroups ? objects : [])
    .filter((o) => o.type === "frame")
    .sort((a, b) => ancestors(map, b.id).length - ancestors(map, a.id).length);
  for (const f of frames) {
    const children = objects.filter((o) => o.parentId === f.id);
    if (children.length && children.every((o) => selected.has(o.id)))
      selected.add(f.id);
  }
  return selectionRoots(objects, [...selected]);
}
export const ALIGNMENT_SNAP_RELEASE_PX = 12;
const ALIGNMENT_PAUSE_MS = 160;
export function snapMove(
  rect,
  targets,
  scale = 1,
  previous = {},
  { pause = false, now = Date.now(), previousRect } = {},
) {
  const candidates = { x: [], y: [] };
  const gap = (a, b, size) =>
    Math.max(a[size === "width" ? "x" : "y"], b[size === "width" ? "x" : "y"]) -
    Math.min(
      a[size === "width" ? "x" : "y"] + a[size],
      b[size === "width" ? "x" : "y"] + b[size],
    );
  for (const target of targets) {
    for (const [axis, size, cross, crossSize] of [
      ["x", "width", "y", "height"],
      ["y", "height", "x", "width"],
    ]) {
      if (!pause && gap(rect, target, crossSize) > 48 / scale) continue;
      for (const ownEdge of [0, 1])
        for (const edge of [0, 1]) {
          const at = target[axis] + target[size] * edge;
          const position = at - rect[size] * ownEdge;
          candidates[axis].push({
            id: target.id,
            edge,
            ownEdge,
            position,
            delta: position - rect[axis],
            axis,
            at,
            from: Math.min(rect[cross], target[cross]) - 8 / scale,
            to:
              Math.max(
                rect[cross] + rect[crossSize],
                target[cross] + target[crossSize],
              ) +
              8 / scale,
          });
        }
    }
  }
  const pick = (axis) => {
    const held = pause && previous?.[axis];
    const retained =
      held &&
      candidates[axis].find(
        (candidate) =>
          candidate.id === held.id &&
          candidate.edge === held.edge &&
          candidate.ownEdge === held.ownEdge &&
          Math.abs(candidate.delta) <=
            (now < held.holdUntil ? 32 : ALIGNMENT_SNAP_RELEASE_PX) / scale,
      );
    if (retained) return { ...retained, holdUntil: held.holdUntil };
    const nearest = candidates[axis].reduce((best, candidate) => {
      const distance = Math.abs(candidate.delta);
      const before = previousRect?.[axis],
        after = rect[axis];
      const crossed =
        pause &&
        candidate.position !== held?.position &&
        ((before < candidate.position && after >= candidate.position) ||
          (before > candidate.position && after <= candidate.position));
      const captures =
        distance <= 8 / scale || (crossed && distance <= 32 / scale);
      return captures && (!best || distance < Math.abs(best.delta))
        ? candidate
        : best;
    }, null);
    return nearest
      ? { ...nearest, holdUntil: pause ? now + ALIGNMENT_PAUSE_MS : undefined }
      : null;
  };
  const sx = pick("x"),
    sy = pick("y");
  return {
    x: rect.x + (sx?.delta || 0),
    y: rect.y + (sy?.delta || 0),
    guides: [sx, sy].filter(Boolean),
    snaps: { x: sx, y: sy },
  };
}
export function snapResize(
  rect,
  targets,
  scale = 1,
  previous = {},
  { now = Date.now(), previousRect, minWidth = 160, minHeight = 70 } = {},
) {
  const candidates = { x: [], y: [] };
  for (const target of targets) {
    // Resize guides span the canvas, so distant edges are useful references too.
    candidates.x.push(
      { id: target.id, edge: "left", at: target.x },
      { id: target.id, edge: "right", at: target.x + target.width },
    );
    candidates.y.push(
      { id: target.id, edge: "top", at: target.y },
      { id: target.id, edge: "bottom", at: target.y + target.height },
    );
  }
  const pick = (axis, edge, minimum, oldEdge) => {
    const allowed = candidates[axis].filter(
      (candidate) => candidate.at >= minimum,
    );
    const held = previous?.[axis];
    const retained =
      held &&
      allowed.find(
        (candidate) =>
          candidate.id === held.id &&
          candidate.edge === held.edge &&
          Math.abs(candidate.at - edge) <=
            (now < held.holdUntil ? 32 : ALIGNMENT_SNAP_RELEASE_PX) / scale,
      );
    if (retained) return { ...retained, holdUntil: held.holdUntil };
    const nearest = allowed.reduce((best, candidate) => {
      const distance = Math.abs(candidate.at - edge);
      const crossed =
        candidate.at !== held?.at &&
        ((oldEdge < candidate.at && edge >= candidate.at) ||
          (oldEdge > candidate.at && edge <= candidate.at));
      // Catch an edge skipped between samples, but allow a decisive pull through.
      const captures =
        distance <= 8 / scale || (crossed && distance <= 32 / scale);
      return captures && (!best || distance < Math.abs(best.at - edge))
        ? candidate
        : best;
    }, null);
    return nearest ? { ...nearest, holdUntil: now + ALIGNMENT_PAUSE_MS } : null;
  };
  const x = pick(
    "x",
    rect.x + rect.width,
    rect.x + minWidth,
    previousRect && previousRect.x + previousRect.width,
  );
  const y = pick(
    "y",
    rect.y + rect.height,
    rect.y + minHeight,
    previousRect && previousRect.y + previousRect.height,
  );
  return {
    width: x ? x.at - rect.x : rect.width,
    height: y ? y.at - rect.y : rect.height,
    snaps: { x, y },
  };
}
const frameDepth = (objects, key) =>
  ancestors(objects, key).filter((o) => o.type === "frame").length;

// Ungrouped roots may deliberately enter any group. Existing members must not
// move down a hierarchy merely because their pointer crosses a nested frame.
export function canDragIntoFrame(objects, object, frame) {
  return (
    object.type !== "frame" &&
    (!object.parentId ||
      frameDepth(objects, frame.id) < frameDepth(objects, object.id))
  );
}

export function frameDragBarriers(objects, roots) {
  const map = index(objects),
    moving = descendantIds(
      map,
      roots.map((o) => o.id),
    );
  const children = new Map();
  for (const object of objects) {
    const members = children.get(object.parentId) || [];
    members.push(object);
    children.set(object.parentId, members);
  }
  // A partially selected frame grows around both stationary and moving members.
  // Preserve those two contributions instead of treating that frame as absent
  // (or stationary) when another selected object approaches it from outside.
  const contributions = (object) => {
    const members = children.get(object.id) || [];
    if (
      object.type !== "frame" ||
      isInspirationBoard(object) ||
      object.collapsed ||
      moving.has(object.id) ||
      !members.length
    )
      return [
        {
          ...(isInspirationBoard(object) ? object : displayRect(object)),
          moving: moving.has(object.id),
        },
      ];
    return members.flatMap(contributions).map((rect) => ({
      ...rect,
      x: rect.x - FRAME_PADDING,
      y: rect.y - FRAME_TOP,
      width: rect.width + FRAME_PADDING * 2,
      height: rect.height + FRAME_TOP + FRAME_PADDING,
    }));
  };
  const frames = objects.filter(
    (o) =>
      o.type === "frame" && !moving.has(o.id) && !hiddenByAncestor(map, o.id),
  );
  return roots.flatMap((object) =>
    frames
      .filter(
        (frame) =>
          frame.boardId === object.boardId &&
          !ancestors(map, object.id).some((parent) => parent.id === frame.id) &&
          !canDragIntoFrame(map, object, frame),
      )
      .flatMap((frame) => {
        const parts = contributions(frame),
          fixed = parts.filter((rect) => !rect.moving),
          translated = parts.filter((rect) => rect.moving);
        // Entirely moving frames keep a constant offset to every selected root.
        if (!fixed.length) return [];
        return [
          {
            object: isInspirationBoard(object) ? object : displayRect(object),
            frame: isInspirationBoard(frame) ? frame : displayRect(frame),
            fixedFrame: bounds(fixed),
            movingFrame: translated.length ? bounds(translated) : null,
          },
        ];
      }),
  );
}

// Sweep the entire pointer segment, then slide along the first padded boundary.
// Testing only the final rectangle would let a fast drag tunnel through a group.
export function constrainFrameMove(
  pairs,
  previous,
  desired,
  { scale = 1, snap = true } = {},
) {
  const epsilon = 1e-7;
  const obstacles = pairs.map(
    ({ object, frame, fixedFrame = frame, movingFrame: moved }) => ({
      minX:
        moved && object.x + object.width > moved.x - FRAME_PADDING + epsilon
          ? -Infinity
          : fixedFrame.x - FRAME_PADDING - object.width - object.x,
      maxX:
        moved && object.x < moved.x + moved.width + FRAME_PADDING - epsilon
          ? Infinity
          : fixedFrame.x + fixedFrame.width + FRAME_PADDING - object.x,
      minY:
        moved && object.y + object.height > moved.y - FRAME_PADDING + epsilon
          ? -Infinity
          : fixedFrame.y - FRAME_PADDING - object.height - object.y,
      maxY:
        moved && object.y < moved.y + moved.height + FRAME_PADDING - epsilon
          ? Infinity
          : fixedFrame.y + fixedFrame.height + FRAME_PADDING - object.y,
    }),
  );
  const sweep = (from, to) => {
    const point = { x: from.x, y: from.y };
    let remaining = { x: to.x - from.x, y: to.y - from.y };
    for (let step = 0; step < 3; step++) {
      let hit = null;
      for (const box of obstacles) {
        // Existing overlapping layouts can be moved out; do not teleport them.
        if (
          point.x > box.minX + epsilon &&
          point.x < box.maxX - epsilon &&
          point.y > box.minY + epsilon &&
          point.y < box.maxY - epsilon
        )
          continue;
        const slab = (position, delta, min, max) => {
          if (Math.abs(delta) < epsilon)
            return position > min + epsilon && position < max - epsilon
              ? [-Infinity, Infinity]
              : null;
          const a = (min - position) / delta,
            b = (max - position) / delta;
          return [Math.min(a, b), Math.max(a, b)];
        };
        const tx = slab(point.x, remaining.x, box.minX, box.maxX),
          ty = slab(point.y, remaining.y, box.minY, box.maxY);
        if (!tx || !ty) continue;
        const enter = Math.max(tx[0], ty[0]),
          leave = Math.min(tx[1], ty[1]);
        if (
          enter < -epsilon ||
          enter > 1 ||
          leave <= Math.max(0, enter) + epsilon
        )
          continue;
        const collision = {
          t: Math.max(0, enter),
          x: Math.abs(tx[0] - enter) < epsilon,
          y: Math.abs(ty[0] - enter) < epsilon,
        };
        if (!hit || collision.t < hit.t - epsilon) hit = collision;
        else if (Math.abs(collision.t - hit.t) < epsilon) {
          hit.x ||= collision.x;
          hit.y ||= collision.y;
        }
      }
      if (!hit) {
        point.x += remaining.x;
        point.y += remaining.y;
        break;
      }
      point.x += remaining.x * hit.t;
      point.y += remaining.y * hit.t;
      remaining = {
        x: hit.x ? 0 : remaining.x * (1 - hit.t),
        y: hit.y ? 0 : remaining.y * (1 - hit.t),
      };
      if (Math.abs(remaining.x) < epsilon && Math.abs(remaining.y) < epsilon)
        break;
    }
    return point;
  };
  let result = sweep(previous, desired);
  const contacts = (point, tolerance, visit) => {
    for (const [i, pair] of pairs.entries()) {
      const { object, movingFrame } = pair;
      const obstacle = obstacles[i];
      const frame = movingFrame
        ? bounds([
            pair.fixedFrame,
            {
              ...movingFrame,
              x: movingFrame.x + point.x,
              y: movingFrame.y + point.y,
            },
          ])
        : pair.frame;
      const x = object.x + point.x,
        y = object.y + point.y,
        left = frame.x - FRAME_PADDING,
        right = frame.x + frame.width + FRAME_PADDING,
        top = frame.y - FRAME_PADDING,
        bottom = frame.y + frame.height + FRAME_PADDING;
      const edge = (axis, at, distance, direction, from, to) => {
        if (distance >= -epsilon && distance <= tolerance + epsilon)
          visit({ axis, at, delta: distance * direction, from, to });
      };
      if (y < bottom - epsilon && y + object.height > top + epsilon) {
        edge(
          "x",
          object.x + object.width + obstacle.minX,
          obstacle.minX - point.x,
          1,
          Math.min(y, frame.y),
          Math.max(y + object.height, frame.y + frame.height),
        );
        edge(
          "x",
          object.x + obstacle.maxX,
          point.x - obstacle.maxX,
          -1,
          Math.min(y, frame.y),
          Math.max(y + object.height, frame.y + frame.height),
        );
      }
      if (x < right - epsilon && x + object.width > left + epsilon) {
        edge(
          "y",
          object.y + object.height + obstacle.minY,
          obstacle.minY - point.y,
          1,
          Math.min(x, frame.x),
          Math.max(x + object.width, frame.x + frame.width),
        );
        edge(
          "y",
          object.y + obstacle.maxY,
          point.y - obstacle.maxY,
          -1,
          Math.min(x, frame.x),
          Math.max(x + object.width, frame.x + frame.width),
        );
      }
    }
  };
  if (snap) {
    const nearest = {};
    contacts(result, 8 / scale, (g) => {
      if (
        !nearest[g.axis] ||
        Math.abs(g.delta) < Math.abs(nearest[g.axis].delta)
      )
        nearest[g.axis] = g;
    });
    const target = { ...result };
    for (const axis of ["x", "y"]) {
      const guide = nearest[axis];
      if (guide) target[axis] += guide.delta;
    }
    result = sweep(result, target);
  }
  const guides = [];
  contacts(result, epsilon, (g) => {
    if (!guides.some((p) => p.axis === g.axis && p.at === g.at)) guides.push(g);
  });
  return { ...result, guides };
}

export function placementInFrame(
  frame,
  object,
  members,
  desired,
  { surrounding = [], ancestors: parentFrames = [] } = {},
) {
  const left = frame.x + FRAME_PADDING,
    top = frame.y + FRAME_TOP,
    w = object.width,
    h = object.height;
  const xs = new Set([left, Math.max(left, desired.x)]),
    ys = new Set([top, Math.max(top, desired.y)]);
  const overlaps = (a, b) =>
    a.x < b.x + b.width + FRAME_PADDING &&
    a.x + a.width + FRAME_PADDING > b.x &&
    a.y < b.y + b.height + FRAME_PADDING &&
    a.y + a.height + FRAME_PADDING > b.y;
  // Do not grow a nested frame across an outside sibling. Existing overlaps
  // remain editable, and all four directions are available for safe expansion.
  const obstacles = surrounding
    .map(displayRect)
    .filter((o) => !overlaps(frame, o));
  const layers = parentFrames.map((layer) => ({
    ...layer,
    obstacles: layer.surrounding
      .map(displayRect)
      .filter((o) => !overlaps(layer.frame, o)),
  }));
  if (obstacles.length) {
    xs.add(left - w - FRAME_PADDING);
    ys.add(top - h - FRAME_PADDING);
    for (const o of obstacles) {
      xs.add(o.x - w - FRAME_PADDING * 2);
      xs.add(o.x + o.width + FRAME_PADDING * 2);
      ys.add(o.y - h - FRAME_PADDING * 2);
      ys.add(o.y + o.height + FRAME_PADDING + FRAME_TOP);
    }
  }
  for (const o of members.map(displayRect)) {
    xs.add(Math.max(left, o.x));
    xs.add(o.x + o.width + 24);
    if (o.x - w - 24 >= left) xs.add(o.x - w - 24);
    ys.add(Math.max(top, o.y));
    ys.add(o.y + o.height + 24);
    if (o.y - h - 24 >= top) ys.add(o.y - h - 24);
  }
  const nearest = (values, to) =>
    [...values]
      .sort((a, b) => Math.abs(a - to) - Math.abs(b - to))
      .slice(0, 40);
  let best = null,
    score = Infinity;
  const candidates = [];
  for (const x of nearest(xs, desired.x))
    for (const y of nearest(ys, desired.y))
      candidates.push({ x, y, width: w, height: h });
  // An uncapped fallback ensures a large packed group always has a free slot.
  candidates.push({
    x: Math.max(left, ...members.map((o) => o.x + o.width + 24)),
    y: top,
    width: w,
    height: h,
  });
  for (const p of candidates) {
    if (
      members.some((raw) => {
        const o = displayRect(raw);
        return (
          p.x < o.x + o.width + 24 &&
          p.x + w + 24 > o.x &&
          p.y < o.y + o.height + 24 &&
          p.y + h + 24 > o.y
        );
      })
    )
      continue;
    const expanded = frameBounds(frame, [...members, p]);
    if (obstacles.some((o) => overlaps(expanded, o))) continue;
    let parentBounds = expanded,
      obstructed = false;
    for (const layer of layers) {
      parentBounds = frameBounds(layer.frame, [...layer.members, parentBounds]);
      if (layer.obstacles.some((o) => overlaps(parentBounds, o))) {
        obstructed = true;
        break;
      }
    }
    if (obstructed) continue;
    const growX =
        Math.max(0, frame.x - expanded.x) +
        Math.max(0, expanded.x + expanded.width - frame.x - frame.width),
      growY =
        Math.max(0, frame.y - expanded.y) +
        Math.max(0, expanded.y + expanded.height - frame.y - frame.height);
    const value =
      (p.x - desired.x) ** 2 +
      (p.y - desired.y) ** 2 +
      (growX ** 2 + growY ** 2) * 0.4;
    if (value < score) {
      score = value;
      best = p;
    }
  }
  return best;
}
