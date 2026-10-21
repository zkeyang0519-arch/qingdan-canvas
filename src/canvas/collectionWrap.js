import { bounds, intersects } from "./geometry.js";
export const collectionTouches = (rects, target) =>
  rects.some((r) => intersects(r, target));
export function collectionEnvelope(rects, target, scale = 1) {
  const pad = 8 / scale;
  return bounds([
    target,
    ...rects.map((r) => ({
      x: r.x - pad,
      y: r.y - pad,
      width: r.width + pad * 2,
      height: r.height + pad * 2,
    })),
  ]);
}
