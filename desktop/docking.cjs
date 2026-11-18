"use strict";
const { fitWindowBounds, islandShape } = require("./window-policy.cjs");
const twin = require("../shared/island-size.json");
const clamp = (n, min, max) => Math.max(min, Math.min(n, Math.max(min, max)));
const side = (dock) => dock === "left" || dock === "right";

function dockAtPoint(point, work) {
  const x = (point.x - work.x - work.width / 2) / (work.width / 2);
  const y = (point.y - work.y - work.height / 2) / (work.height / 2);
  // Direction is relative to this display's center, independent of its aspect
  // ratio. The lower half belongs to the sides; there is no settled free state.
  if (y <= 0 && -y >= Math.abs(x)) return "top";
  return x < 0 ? "left" : "right";
}

function compactSize(dock, appearance, empty = false, size) {
  if (appearance === "jade-twins") {
    const width = side(dock) ? twin.side.width + 24 : twin.top.width + 107;
    const height = side(dock)
      ? (empty ? twin.side.emptyHeight : twin.side.height) + 75
      : twin.top.height + 24;
    return {
      width: width + (size?.extraWidth ?? 0),
      height: height + (size?.extraHeight ?? 0),
    };
  }
  return side(dock)
    ? { width: 64, height: 160 }
    : {
        width: appearance === "jade" ? 314 : 354,
        height: appearance === "jade" ? 64 : 76,
      };
}

function restorePlacement(saved, work, appearance, empty = false) {
  const center = saved
    ? { x: saved.x + saved.width / 2, y: saved.y + saved.height / 2 }
    : { x: work.x + work.width / 2, y: work.y };
  const dock = ["top", "left", "right"].includes(saved?.dock)
    ? saved.dock
    : dockAtPoint(center, work);
  const layout = { dock, ...compactSize(dock, appearance, empty) };
  if (appearance) layout.appearance = appearance;
  const anchor = {
    x: center.x - layout.width / 2,
    y: center.y - layout.height / 2,
    ...layout,
  };
  return { ...fitDockBounds(anchor, layout, work), dock };
}

function placementAtPoint(
  point,
  offset,
  work,
  appearance,
  empty = false,
  size,
) {
  const dock = dockAtPoint(point, work);
  const { width, height } = compactSize(dock, appearance, empty);
  const requested = { width, height, dock };
  if (appearance) requested.appearance = appearance;
  const extraWidth = size?.extraWidth ?? 0,
    extraHeight = size?.extraHeight ?? 0;
  // Save the original-size anchor. Growing a capsule extends its inward
  // edge, so moving it or restoring its size cannot accumulate position drift.
  const towardsLeft =
    point.x - offset.x + (width + extraWidth) / 2 > work.x + work.width / 2;
  const towardsTop = point.y > work.y + work.height / 2;
  const anchor = side(dock)
    ? {
        x: point.x - width / 2,
        y: point.y - height / 2 + ((towardsTop ? 1 : -1) * extraHeight) / 2,
        width,
        height,
        dock,
      }
    : {
        x: point.x - offset.x + (towardsLeft ? extraWidth : 0),
        y: point.y - offset.y,
        width,
        height,
        dock,
      };
  return { ...fitDockBounds(anchor, requested, work), dock };
}

function resizeCorner(anchor, dock, work) {
  return {
    resizeLeft:
      dock === "right" ||
      (dock === "top" &&
        !!anchor &&
        anchor.x + anchor.width / 2 > work.x + work.width / 2),
    resizeUp:
      side(dock) &&
      !!anchor &&
      anchor.y + anchor.height / 2 > work.y + work.height / 2,
  };
}

function fitDockBounds(anchor, layout, work) {
  if (!layout.dock) return fitWindowBounds(anchor, layout, work);
  const dock = anchor?.dock || layout.dock;
  // Reserve the list width before hover so an open/close never moves the native window sideways.
  const extraWidth = layout.size?.extraWidth ?? 0;
  const extraHeight = layout.size?.extraHeight ?? 0;
  const corner = resizeCorner(anchor, dock, work);
  const frameWidth =
    layout.fixedFrame && layout.dock !== "free"
      ? side(dock)
        ? Math.max(384, 342 + extraWidth)
        : Math.max(444, 436 + extraWidth)
      : 0;
  const width = Math.min(
    Math.max(frameWidth, Math.round(layout.width)),
    work.width,
  );
  const height = Math.min(Math.round(layout.height), work.height);
  const centerX =
    (anchor ? anchor.x + anchor.width / 2 : work.x + work.width / 2) +
    (dock === "top" ? ((corner.resizeLeft ? -1 : 1) * extraWidth) / 2 : 0);
  const centerY = anchor
    ? anchor.y + anchor.height / 2
    : work.y + work.height / 2;
  const anchorHeight =
    layout.retained || (side(dock) && layout.size)
      ? compactSize(dock, layout.appearance, layout.empty).height
      : height;
  return {
    x: Math.round(
      dock === "left"
        ? work.x - 12
        : dock === "right"
          ? work.x + work.width - width + 12
          : clamp(centerX - width / 2, work.x, work.x + work.width - width),
    ),
    y: Math.round(
      dock === "top"
        ? work.y - (layout.appearance === "jade" ? 12 : 0)
        : clamp(
            side(dock)
              ? centerY - anchorHeight / 2 - (corner.resizeUp ? extraHeight : 0)
              : (anchor?.y ?? work.y + 12),
            work.y,
            work.y + work.height - height,
          ),
    ),
    width,
    height,
  };
}

function retainedCompactBounds(anchor, layout, work) {
  return fitDockBounds(
    anchor,
    {
      dock: layout.dock,
      appearance: layout.appearance,
      size: layout.size,
      empty: layout.empty,
      ...compactSize(layout.dock, layout.appearance, layout.empty, layout.size),
    },
    work,
  );
}

function retainedHeaderOffset(anchor, bounds, layout, work) {
  const compact = retainedCompactBounds(anchor, layout, work);
  return clamp(compact.x - bounds.x, 0, bounds.width - compact.width);
}

function placementState(anchor, bounds, work, dragging = false, layout = {}) {
  const retained = layout.appearance === "jade-twins" && layout.retained;
  const compact = retained && retainedCompactBounds(anchor, layout, work);
  return {
    dock: dragging ? "free" : restorePlacement(anchor, work).dock,
    dragging,
    ...(layout.appearance === "jade-twins"
      ? resizeCorner(anchor, anchor?.dock ?? layout.dock, work)
      : {}),
    railOffset: Math.round(
      clamp(
        (anchor ? anchor.y + anchor.height / 2 : bounds.y + bounds.height / 2) -
          bounds.y -
          68,
        12,
        bounds.height - 148,
      ),
    ),
    // Prefer scrolling the list to moving a capsule away from a hovering
    // pointer. At the very bottom reserve enough room for usable controls.
    maxHeight: retained
      ? Math.min(work.height, Math.max(400, work.y + work.height - compact.y))
      : work.height,
    maxWidth: work.width,
    ...(retained
      ? { headerOffset: retainedHeaderOffset(anchor, bounds, layout, work) }
      : {}),
  };
}

function roundedRect(
  x,
  y,
  width,
  height,
  radius,
  squareSide,
  roundInset = Math.ceil,
) {
  const rows = [],
    r = Math.min(radius, Math.floor(width / 2), Math.floor(height / 2));
  for (let row = 0; row < height; row++) {
    const distance =
      row < r
        ? r - row - 0.5
        : row >= height - r
          ? row - (height - r) + 0.5
          : 0;
    const edge =
      squareSide === "top" && row < r
        ? 0
        : distance
          ? Math.max(0, roundInset(r - Math.sqrt(r * r - distance * distance)))
          : 0;
    const left = squareSide === "left" ? 0 : edge,
      right = squareSide === "right" ? 0 : edge;
    if (width - left - right > 0)
      rows.push({
        x: x + left,
        y: y + row,
        width: width - left - right,
        height: 1,
      });
  }
  return rows;
}

function surfaceShape(x, y, width, height, radius) {
  // setShape clips painting as well as mouse input. Leave transparent space
  // around the CSS edge so native integer scanlines cannot cut its antialiasing
  // at fractional display scales. Two DIP still leave both capsule gaps open.
  const outset = 2;
  return roundedRect(
    x - outset,
    y - outset,
    width + outset * 2,
    height + outset * 2,
    radius + outset,
    undefined,
    Math.floor,
  );
}

function dockShape(bounds, layout, anchor, work) {
  if (layout.appearance === "jade-twins") {
    const width = Math.max(1, bounds.width - 24);
    if (layout.expanded && !layout.retained)
      return surfaceShape(12, 12, width, Math.max(1, bounds.height - 24), 25);
    const vertical = side(layout.dock);
    const right = layout.dock === "right";
    const peek = layout.peek && !layout.expanded;
    const baseHeight = vertical
      ? layout.empty
        ? twin.side.emptyHeight
        : twin.side.height
      : peek
        ? 64
        : twin.top.height;
    const height = baseHeight + (layout.size?.extraHeight ?? 0);
    const baseWidth = vertical
      ? peek
        ? 318
        : twin.side.width
      : peek
        ? 412
        : 376;
    const fixed =
      layout.expanded || (layout.fixedFrame && layout.dock !== "free");
    const headerWidth = fixed
      ? Math.min(width, baseWidth + (layout.size?.extraWidth ?? 0))
      : width;
    const offset = vertical
      ? right
        ? width - headerWidth
        : 0
      : fixed
        ? clamp(
            retainedHeaderOffset(anchor, bounds, layout, work) -
              (peek ? 18 : 0),
            0,
            width - headerWidth,
          )
        : 0;
    const smallX = vertical
      ? right
        ? bounds.width - 68
        : 12
      : 12 + offset + headerWidth - 74;
    const smallY = vertical
      ? 12 + height + 7
      : 12 + Math.floor((height - 48) / 2);
    const shape = surfaceShape(
      12 + offset,
      12,
      vertical ? headerWidth : headerWidth - 83,
      height,
      vertical ? (peek ? 25 : 28) : 26,
    ).concat(
      surfaceShape(
        smallX,
        smallY,
        vertical ? 56 : 74,
        vertical ? 44 : 48,
        vertical ? 22 : 24,
      ),
    );
    if (!layout.expanded) return shape;
    const panelY = 12 + height + (vertical ? 51 : 0) + 10;
    const panelWidth = Math.min(width, vertical ? 360 : 420);
    const panelX =
      12 +
      (vertical
        ? right
          ? width - panelWidth
          : 0
        : Math.round((width - panelWidth) / 2));
    return shape.concat(
      surfaceShape(
        panelX,
        panelY,
        panelWidth,
        Math.max(1, bounds.height - panelY - 12),
        25,
      ),
    );
  }
  if (layout.appearance === "jade" && !side(layout.dock)) {
    const width = Math.min(290, bounds.width - 24);
    const capsule = roundedRect(
      Math.round((bounds.width - width) / 2),
      12,
      width,
      40,
      24,
      layout.dock === "top" ? "top" : undefined,
    );
    if (!layout.expanded) return capsule;
    return capsule.concat(
      roundedRect(
        12,
        69,
        Math.max(1, bounds.width - 24),
        Math.max(1, bounds.height - 81),
        23,
      ),
    );
  }
  if (!side(layout.dock)) return islandShape(bounds.width, bounds.height);
  const left = layout.dock === "left",
    railX = left ? 12 : bounds.width - 52;
  const railY = layout.expanded
    ? placementState(anchor, bounds, work).railOffset
    : 12;
  const rail = roundedRect(
    railX,
    railY,
    40,
    Math.min(136, bounds.height - 24),
    20,
    layout.dock,
  );
  if (!layout.expanded) return rail;
  return rail.concat(
    roundedRect(
      left ? 60 : 12,
      12,
      Math.max(1, bounds.width - 72),
      Math.max(1, bounds.height - 24),
      24,
    ),
  );
}

module.exports = {
  compactSize,
  dockAtPoint,
  restorePlacement,
  placementAtPoint,
  fitDockBounds,
  placementState,
  dockShape,
};
