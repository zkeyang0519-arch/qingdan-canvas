// Geometry in world coordinates. Moving cards are placed above their siblings.
export const isInspirationBoard = (o) =>
  o?.type === "frame" && o.fixedBounds === true;
export const BOARD_GAP = 24;
export const boardsOverlap = (a, b) =>
  a.x < b.x + b.width + BOARD_GAP - 1e-7 &&
  a.x + a.width + BOARD_GAP > b.x + 1e-7 &&
  a.y < b.y + b.height + BOARD_GAP - 1e-7 &&
  a.y + a.height + BOARD_GAP > b.y + 1e-7;
const height = (o) =>
  o.type === "note" ? o.layoutHeight || o.height : o.height;
const rect = (o) => ({ ...o, height: height(o) });
export const boardLeftLimit = (frame, object) =>
  Math.max(
    frame.x + 12 - object.width / 2,
    object.type === "note" ? frame.x - object.width / 4 : -Infinity,
  );
export function coverageArea(a, others) {
  const cuts = others
    .map((b) => ({
      x: Math.max(a.x, b.x),
      y: Math.max(a.y, b.y),
      right: Math.min(a.x + a.width, b.x + b.width),
      bottom: Math.min(a.y + a.height, b.y + b.height),
    }))
    .filter((r) => r.right > r.x && r.bottom > r.y);
  const xs = [...new Set(cuts.flatMap((r) => [r.x, r.right]))].sort(
    (a, b) => a - b,
  );
  let area = 0;
  for (let i = 1; i < xs.length; i++) {
    const rows = cuts
      .filter((r) => r.x < xs[i] && r.right > xs[i - 1])
      .sort((a, b) => a.y - b.y);
    let end = -Infinity,
      total = 0;
    for (const r of rows) {
      total += Math.max(0, r.bottom - Math.max(r.y, end));
      end = Math.max(end, r.bottom);
    }
    area += (xs[i] - xs[i - 1]) * total;
  }
  return area;
}
export function boardResize(frame, width, height, members, obstacles = []) {
  const size = {
    width: Math.max(
      240,
      width,
      ...members.map((o) => o.x + o.width / 2 + 12 - frame.x),
    ),
    height: Math.max(
      180,
      height,
      ...members.map((o) => o.y + rect(o).height / 6 + 12 - frame.y),
    ),
  };
  for (const obstacle of obstacles) {
    if (!boardsOverlap({ ...frame, ...size }, obstacle)) continue;
    const maxWidth = obstacle.x - BOARD_GAP - frame.x;
    const maxHeight = obstacle.y - BOARD_GAP - frame.y;
    const fromRight = frame.width <= maxWidth + 1e-7;
    const fromBelow = frame.height <= maxHeight + 1e-7;
    if (fromRight && fromBelow) {
      // At a diagonal neighbor, stop the edge that enters last; the other
      // dimension remains free to grow along its boundary.
      const tx = (maxWidth - frame.width) / (size.width - frame.width);
      const ty = (maxHeight - frame.height) / (size.height - frame.height);
      if (tx >= ty) size.width = Math.min(size.width, maxWidth);
      else size.height = Math.min(size.height, maxHeight);
    } else if (fromRight) size.width = Math.min(size.width, maxWidth);
    else if (fromBelow) size.height = Math.min(size.height, maxHeight);
    else {
      // Older overlapping layouts can shrink or move apart, never grow further.
      size.width = Math.min(size.width, frame.width);
      size.height = Math.min(size.height, frame.height);
    }
  }
  return size;
}
export function boardPlacement(frame, object, objects) {
  const card = rect(object),
    siblings = objects
      .filter((o) => o.parentId === frame.id && o.id !== card.id)
      .map(rect)
      .sort((a, b) => a.zIndex - b.zIndex);
  const loX = boardLeftLimit(frame, card),
    hiX = frame.x + frame.width - 12 - card.width / 2,
    loY = frame.y + 58 - card.height / 6,
    hiY = frame.y + frame.height - 12 - card.height / 6;
  if (hiX < loX || hiY < loY) return null;
  const desired = {
    x: Math.max(loX, Math.min(hiX, card.x)),
    y: Math.max(loY, Math.min(hiY, card.y)),
  };
  const valid = (p) => {
    const cards = [...siblings, { ...card, ...p }];
    for (let i = 0; i < cards.length - 1; i++) {
      const a = cards[i],
        above = cards.slice(i + 1);
      if (coverageArea(a, above) > a.width * a.height * 0.2 + 0.01)
        return false;
      if (
        a.type === "note" &&
        coverageArea({ ...a, height: Math.min(34, a.height) }, above) > 0.01
      )
        return false;
    }
    return true;
  };
  if (valid(desired)) return desired;
  // Bounded search keeps oversized boards responsive on drop.
  const step = Math.max(12, Math.sqrt(((hiX - loX) * (hiY - loY)) / 4096));
  let best = null,
    distance = Infinity;
  for (let y = loY; y <= hiY; y += step)
    for (let x = loX; x <= hiX; x += step) {
      const d = (x - desired.x) ** 2 + (y - desired.y) ** 2;
      if (d < distance && valid({ x, y })) {
        best = { x, y };
        distance = d;
      }
    }
  return best;
}
