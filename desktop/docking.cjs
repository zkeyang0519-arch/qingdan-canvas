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

function compactSize(dock, appearance, empty = false) {
  if (appearance === "jade-twins")
    return side(dock)
      ? { width: 80, height: empty ? 127 : 161 }
      : { width: 400, height: 72 };
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

function placementAtPoint(point, offset, work, appearance, empty = false) {
  const dock = dockAtPoint(point, work);
  const { width, height } = compactSize(dock, appearance, empty);
  const requested = { width, height, dock };
  if (appearance) requested.appearance = appearance;
  const anchor = side(dock)
    ? { x: point.x - width / 2, y: point.y - height / 2, width, height, dock }
    : {
        x: point.x - offset.x,
        y: point.y - offset.y,
        width,
        height,
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
        ? work.y - (layout.appearance === "jade" ? 12 : 0)
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
    const edge =
      squareSide === "top" && row < r
        ? 0
        : distance
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
  if (layout.appearance === "jade-twins") {
    const width = Math.max(1, bounds.width - 24);
    if (layout.expanded)
      return roundedRect(12, 12, width, Math.max(1, bounds.height - 24), 25);
    if (side(layout.dock)) {
      const height = layout.empty ? 52 : 86;
      return roundedRect(12, 12, width, height, layout.peek ? 25 : 28).concat(
        roundedRect(
          layout.dock === "left" ? 12 : bounds.width - 68,
          12 + height + 7,
          56,
          44,
          22,
        ),
      );
    }
    const height = layout.peek ? 64 : 48;
    return roundedRect(
      12,
      12,
      width - 83,
      height,
      layout.peek ? 26 : 24,
    ).concat(
      roundedRect(bounds.width - 86, 12 + (height - 48) / 2, 74, 48, 24),
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
