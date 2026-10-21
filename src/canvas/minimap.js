import { bounds } from "./geometry.js";
export function minimapTransform(objects, view, size) {
  const viewport = {
    x: -view.x / view.scale,
    y: -view.y / view.scale,
    width: size.width / view.scale,
    height: size.height / view.scale,
  };
  const b = bounds([...objects, viewport]);
  const scale = Math.min(
    200 / Math.max(1, b.width),
    130 / Math.max(1, b.height),
  );
  return {
    scale,
    x: (220 - b.width * scale) / 2 - b.x * scale,
    y: (150 - b.height * scale) / 2 - b.y * scale,
  };
}
export const mapPoint = (p, t) => ({
  x: p.x * t.scale + t.x,
  y: p.y * t.scale + t.y,
});
export const unmapPoint = (p, t) => ({
  x: (p.x - t.x) / t.scale,
  y: (p.y - t.y) / t.scale,
});
export const centerView = (p, v, s) => ({
  ...v,
  x: s.width / 2 - p.x * v.scale,
  y: s.height / 2 - p.y * v.scale,
});
