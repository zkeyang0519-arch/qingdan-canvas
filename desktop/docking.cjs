"use strict";
const { fitWindowBounds, islandShape } = require("./window-policy.cjs");
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

function restorePlacement(saved, work) {
  const center = saved
    ? { x: saved.x + saved.width / 2, y: saved.y + saved.height / 2 }
    : { x: work.x + work.width / 2, y: work.y };
  const dock = ["top", "left", "right"].includes(saved?.dock)
    ? saved.dock
    : dockAtPoint(center, work);
  const layout = side(dock)
    ? { dock, width: 64, height: 160 }
    : { dock, width: 354, height: 76 };
  const anchor = {
    x: center.x - layout.width / 2,
    y: center.y - layout.height / 2,
    ...layout,
  };
  return { ...fitDockBounds(anchor, layout, work), dock };
}

function placementAtPoint(point, offset, work) {
  const dock = dockAtPoint(point, work);
  const requested = side(dock)
    ? { width: 64, height: 160, dock }
    : { width: 354, height: 76, dock };
  const anchor = side(dock)
    ? { x: point.x - 32, y: point.y - 80, width: 64, height: 160, dock }
    : {
        x: point.x - offset.x,
        y: point.y - offset.y,
        width: 354,
        height: 76,
        dock,
      };
  return { ...fitDockBounds(anchor, requested, work), dock };
}

function fitDockBounds(anchor, layout, work) {
  if (!layout.dock) return fitWindowBounds(anchor, layout, work);
  const dock = anchor?.dock || layout.dock;
  const width = Math.min(Math.round(layout.width), work.width);
  const height = Math.min(Math.round(layout.height), work.height);
  const centerX = anchor
    ? anchor.x + anchor.width / 2
    : work.x + work.width / 2;
  const centerY = anchor
    ? anchor.y + anchor.height / 2
    : work.y + work.height / 2;
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
        ? work.y
        : clamp(
            side(dock) ? centerY - height / 2 : (anchor?.y ?? work.y + 12),
            work.y,
            work.y + work.height - height,
          ),
    ),
    width,
    height,
  };
}

function placementState(anchor, bounds, work, dragging = false) {
  return {
    dock: dragging ? "free" : restorePlacement(anchor, work).dock,
    dragging,
    railOffset: Math.round(
      clamp(
        (anchor ? anchor.y + anchor.height / 2 : bounds.y + bounds.height / 2) -
          bounds.y -
          68,
        12,
        bounds.height - 148,
      ),
    ),
    maxHeight: work.height,
    maxWidth: work.width,
  };
}

function roundedRect(x, y, width, height, radius, squareSide) {
  const rows = [],
    r = Math.min(radius, Math.floor(width / 2), Math.floor(height / 2));
  for (let row = 0; row < height; row++) {
    const distance =
      row < r
        ? r - row - 0.5
        : row >= height - r
          ? row - (height - r) + 0.5
          : 0;
    const edge = distance
      ? Math.max(0, Math.ceil(r - Math.sqrt(r * r - distance * distance)))
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

function dockShape(bounds, layout, anchor, work) {
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
  dockAtPoint,
  restorePlacement,
  placementAtPoint,
  fitDockBounds,
  placementState,
  dockShape,
};
