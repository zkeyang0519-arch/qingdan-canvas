// Local appearance only: never write shared boards, task data or input drafts.
export const legacyIslandAppearanceKey = "qingdan.desktop.island-appearance.v1";
export const islandAppearanceKey = "qingdan.desktop.island-appearance.v2";
export const islandAppearanceVersions = [
  { id: "meadow", name: "四季草地", detail: "春花、夏荫、秋叶与冬雪" },
  { id: "glass", name: "清透玻璃", detail: "边缘折射与高光" },
  { id: "flow", name: "色块流动", detail: "保留原版配色" },
];
export const islandAppearancePalettes = [
  {
    id: "moss",
    name: "林间苔绿",
    colors: ["#dae5cd", "#aec59a", "#8aaa76"],
    smallColor: "#cbd9bf",
  },
  {
    id: "spring",
    name: "春芽微光",
    colors: ["#dff1cc", "#b9e9a0", "#99bc75"],
    smallColor: "#d0e1bf",
  },
  {
    id: "sage",
    name: "雾感鼠尾草",
    colors: ["#e3e9dc", "#bfceb3", "#9caa91"],
    smallColor: "#d6dfcf",
  },
  {
    id: "matcha",
    name: "抹茶奶绿",
    colors: ["#edf1d8", "#cdd9a6", "#a6bb77"],
    smallColor: "#dfe5c5",
  },
  {
    id: "original",
    name: "你调的原色",
    colors: ["#b9e9a0", "#c1d2a3", "#b2d373"],
    smallColor: "#c7d8bc",
  },
];
const defaultProfile = Object.freeze({
  colors: Object.freeze([...islandAppearancePalettes[0].colors]),
  smallColor: "#cbd9bf",
  cycle: 9,
  motion: true,
  glassStrength: 0.9,
});
const meadowProfile = Object.freeze({ ...defaultProfile, scrollSpeed: 24 });
export const defaultIslandAppearance = Object.freeze({
  version: 2,
  design: "glass",
  profiles: Object.freeze({
    glass: defaultProfile,
    flow: defaultProfile,
    meadow: meadowProfile,
  }),
});

export function normalizeIslandColor(value, fallback = null) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : fallback;
}
function bounded(value, fallback, min, max, scale = 1) {
  return Number.isFinite(value)
    ? Math.round(Math.max(min, Math.min(max, value)) * scale) / scale
    : fallback;
}
function normalizeProfile(value, meadow = false) {
  const colors = Array.isArray(value?.colors)
    ? value.colors
        .slice(0, 8)
        .map((color) => normalizeIslandColor(color))
        .filter(Boolean)
    : [];
  return {
    colors: colors.length ? colors : [...defaultProfile.colors],
    smallColor: normalizeIslandColor(
      value?.smallColor,
      defaultProfile.smallColor,
    ),
    cycle: bounded(value?.cycle, 9, 3, 12, 10),
    motion: typeof value?.motion === "boolean" ? value.motion : true,
    glassStrength: bounded(value?.glassStrength, 0.9, 0, 1, 100),
    ...(meadow ? { scrollSpeed: bounded(value?.scrollSpeed, 24, 8, 60) } : {}),
  };
}
export function normalizeIslandAppearance(value) {
  return {
    version: 2,
    design: ["flow", "meadow"].includes(value?.design) ? value.design : "glass",
    profiles: {
      glass: normalizeProfile(value?.profiles?.glass),
      flow: normalizeProfile(value?.profiles?.flow),
      meadow: normalizeProfile(value?.profiles?.meadow, true),
    },
  };
}
export function patchIslandAppearance(value, patch) {
  const next = normalizeIslandAppearance({ ...value, ...patch });
  if (patch?.profile)
    next.profiles[next.design] = normalizeProfile(
      {
        ...next.profiles[next.design],
        ...patch.profile,
      },
      next.design === "meadow",
    );
  return next;
}
export function activeIslandAppearance(value) {
  const normalized = normalizeIslandAppearance(value);
  return normalized.profiles[normalized.design];
}
export function loadIslandAppearance(storage = window.localStorage) {
  const saved = storage.getItem(islandAppearanceKey);
  // Leave the earlier single-color appearance intact for older clients.
  return normalizeIslandAppearance(saved === null ? null : JSON.parse(saved));
}
export function saveIslandAppearance(value, storage = window.localStorage) {
  const appearance = normalizeIslandAppearance(value);
  storage.setItem(islandAppearanceKey, JSON.stringify(appearance));
  return appearance;
}
function luminance(color) {
  const channels = [1, 3, 5].map((i) => {
    const v = parseInt(color.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function readable(colors) {
  const choices = ["#26352a", "#fcfff6"]
    .map((color) => {
      const l = luminance(color);
      return {
        color,
        contrast: Math.min(
          ...colors.map((c) => {
            const b = luminance(c);
            return (Math.max(l, b) + 0.05) / (Math.min(l, b) + 0.05);
          }),
        ),
      };
    })
    .sort((a, b) => b.contrast - a.contrast);
  return choices[0];
}
export function islandAppearanceStyle(value) {
  const profile = activeIslandAppearance(value);
  const main = readable(
      value?.design === "meadow" ? ["#e4edcf"] : profile.colors,
    ),
    small = readable([profile.smallColor]);
  const colors =
    profile.colors.length > 1
      ? profile.colors
      : [...profile.colors, ...profile.colors];
  return {
    "--island-field-fill": `linear-gradient(120deg, ${colors.join(", ")})`,
    "--island-small-color": profile.smallColor,
    "--island-main-text": main.contrast >= 4.5 ? main.color : "#26352a",
    "--island-summary-fill": main.contrast >= 4.5 ? "transparent" : "#fcfbf7eb",
    "--island-small-text": small.color,
    "--island-glass-strength": profile.glassStrength,
    "--island-flow-cycle": `${profile.cycle}s`,
  };
}
