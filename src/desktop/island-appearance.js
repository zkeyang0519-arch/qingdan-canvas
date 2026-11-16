// Appearance belongs to this desktop, not to a shared board or its task data.
export const islandAppearanceKey = "qingdan.desktop.island-appearance.v1";
export const defaultIslandAppearance = Object.freeze({
  color: "#55b961",
  transparency: 70,
});

export const islandAppearanceColors = [
  { name: "青色", color: "#53c7c2" },
  { name: "青绿", color: "#55b961" },
  { name: "冰青", color: "#83dce5" },
  { name: "雾蓝", color: "#7caad4" },
];

export function normalizeIslandAppearance(value) {
  return {
    color:
      typeof value?.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color)
        ? value.color.toLowerCase()
        : defaultIslandAppearance.color,
    transparency: Number.isFinite(value?.transparency)
      ? Math.round(Math.max(0, Math.min(100, value.transparency)))
      : defaultIslandAppearance.transparency,
  };
}

export function loadIslandAppearance(storage = window.localStorage) {
  const saved = storage.getItem(islandAppearanceKey);
  return normalizeIslandAppearance(saved === null ? null : JSON.parse(saved));
}

export function saveIslandAppearance(value, storage = window.localStorage) {
  const appearance = normalizeIslandAppearance(value);
  storage.setItem(islandAppearanceKey, JSON.stringify(appearance));
  return appearance;
}

export function islandAppearanceStyle(value) {
  const appearance = normalizeIslandAppearance(value);
  const [r, g, b] = [1, 3, 5].map(
    (offset) => parseInt(appearance.color.slice(offset, offset + 2), 16) / 255,
  );
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const delta = max - min,
    lightness = (max + min) / 2;
  let hue = 0,
    saturation = 0;
  if (delta) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    hue =
      max === r
        ? ((g - b) / delta) % 6
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return {
    "--island-glass-color": appearance.color,
    "--island-glass-hue": hue.toFixed(2),
    "--island-glass-saturation": `${(saturation * 64).toFixed(2)}%`,
    "--island-glass-alpha": ((100 - appearance.transparency) / 100).toFixed(2),
  };
}
