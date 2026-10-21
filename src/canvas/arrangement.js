// Display-only rectangles. Canvas coordinates and parent relationships stay intact.
export function arrangeObjects(
  objects,
  viewportWidth,
  measurements = new Map(),
) {
  const gap = 26;
  const width = Math.max(160, viewportWidth);
  const margin = width >= 720 ? 80 : 20;
  const available = Math.min(1440, width - margin * 2);
  const columns = Math.max(
    1,
    Math.min(4, Math.floor((available + gap) / (220 + gap))),
  );
  const columnWidth = (available - gap * (columns - 1)) / columns;
  const left = (width - available) / 2;
  const rects = new Map(),
    ids = new Set(objects.map((o) => o.id)),
    children = new Map();
  for (const object of objects) {
    const key = ids.has(object.parentId) ? object.parentId : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(object);
  }
  const place = (object, right, top, limit) => {
    const itemWidth =
      object.type === "frame"
        ? limit
        : Math.min(
            object.type === "note" || object.type === "image"
              ? 280
              : object.width,
            limit,
          );
    let height;
    const measured = measurements.get(object.id);
    if (object.type === "note") {
      const charsPerLine = Math.max(1, Math.floor((itemWidth - 34) / 9));
      const lines = object.blocks.reduce(
        (total, block) =>
          total +
          Math.max(
            1,
            block.runs
              .map((r) => r.text || r.label || "")
              .join("")
              .split("\n")
              .reduce(
                (n, line) =>
                  n + Math.max(1, Math.ceil(line.length / charsPerLine)),
                0,
              ),
          ),
        0,
      );
      height =
        measured && Math.abs(measured.width - itemWidth) < 1
          ? Math.max(108, measured.height)
          : Math.max(
              108,
              34 + lines * 27.2 + (object.noteKind === "checklist" ? 34 : 0),
            );
    } else if (object.type === "frame") {
      height = 56;
      if (!object.collapsed) {
        // Keep very deep groups usable even on a narrow viewport.
        const padding = Math.min(16, Math.max(2, limit * 0.07));
        let nextY = top + 48;
        for (const child of children.get(object.id) || []) {
          const childRect = place(
            child,
            right - padding,
            nextY,
            limit - 2 * padding,
          );
          nextY = childRect.y + childRect.height + gap;
        }
        height = Math.max(80, nextY - top - gap + padding);
      }
    } else height = (object.height * itemWidth) / object.width;
    const rect = { x: right - itemWidth, y: top, width: itemWidth, height };
    rects.set(object.id, rect);
    return rect;
  };
  const bottoms = Array(columns).fill(92);
  (children.get(null) || []).forEach((object, index) => {
    const column = index % columns;
    const rect = place(
      object,
      left + (column + 1) * columnWidth + column * gap,
      bottoms[column],
      columnWidth,
    );
    bottoms[column] = rect.y + rect.height + gap;
  });
  return { rects, columns, height: Math.max(280, ...bottoms) + 180 };
}
