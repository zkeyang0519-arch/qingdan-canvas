export const defaultView = () => ({
  x: 0,
  y: 0,
  scale: 1,
  gridVisible: true,
  snapEnabled: false,
  hideCompleted: false,
  arrangedScroll: 0,
});
export const screenToWorld = (point, view) => ({
  x: (point.x - view.x) / view.scale,
  y: (point.y - view.y) / view.scale,
});
export const worldToScreen = (point, view) => ({
  x: point.x * view.scale + view.x,
  y: point.y * view.scale + view.y,
});
export function zoomAt(view, point, scale) {
  const next = Math.max(0.1, Math.min(4, scale));
  const world = screenToWorld(point, view);
  return {
    ...view,
    scale: next,
    x: point.x - world.x * next,
    y: point.y - world.y * next,
  };
}
export function bounds(objects) {
  if (!objects.length) return { x: 0, y: 0, width: 280, height: 190 };
  const x = Math.min(...objects.map((o) => o.x)),
    y = Math.min(...objects.map((o) => o.y));
  return {
    x,
    y,
    width: Math.max(...objects.map((o) => o.x + o.width)) - x,
    height: Math.max(...objects.map((o) => o.y + o.height)) - y,
  };
}
export const intersects = (a, b) =>
  a.x <= b.x + b.width &&
  a.x + a.width >= b.x &&
  a.y <= b.y + b.height &&
  a.y + a.height >= b.y;
export const contains = (r, p) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
export function fitView(objects, width, height, view = defaultView()) {
  const box = bounds(objects);
  const scale = Math.max(
    0.1,
    Math.min(1.4, (width - 100) / box.width, (height - 100) / box.height),
  );
  return {
    ...view,
    scale,
    x: width / 2 - (box.x + box.width / 2) * scale,
    y: height / 2 - (box.y + box.height / 2) * scale,
  };
}
