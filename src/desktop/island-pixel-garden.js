// One design pixel is the smallest painted unit. Every shape is scan-converted
// into integer spans; the scene uses no sampled images or sprite sheets.
export const gridHeight = 32;
export const planeNames = ["far", "mid", "near"];
const period = { far: 288, mid: 256, near: 224 };
const tiles = new Map();
const wrap = (x, w) => ((x % w) + w) % w;
const palettes = [
  {
    sky: ["#afcfd7", "#d8e3d6", "#f8e6cd"],
    cloud: ["#f7ecd9", "#d5d7ce"],
    sun: "#ffe3a3",
    ridge: ["#b9c4c1", "#9fafad", "#859f98", "#93ac94"],
    iceCap: "#e2ded4",
    field: ["#91b17b", "#a8c987", "#d2d997", "#859f70"],
    water: ["#83b9ae", "#a6cfc0", "#d9eacd", "#709989"],
    bark: ["#6e554c", "#987366"],
    canopy: ["#937581", "#bb818e", "#dd99a3", "#f4bcc1", "#ffe1d0"],
    leaves: ["#556f51", "#769353", "#a2b66c"],
    soil: ["#536e4e", "#769653", "#aac376"],
    flora: ["#d78e98", "#f1b7b5", "#fff0cd", "#e7b457"],
    wood: ["#866d55", "#b39b71"],
  },
  {
    sky: ["#86c4d1", "#b7deda", "#e0ebca"],
    cloud: ["#fff1cd", "#cbded0"],
    sun: "#ffe3a0",
    ridge: ["#94b9ba", "#79a6a5", "#65938f", "#78a38a"],
    iceCap: "#c7d7bd",
    field: ["#72a36c", "#9dbf73", "#cee29a", "#688d64"],
    water: ["#448e9c", "#65b4b1", "#a3dbc5", "#3e7686"],
    bark: ["#5b5842", "#91825a"],
    canopy: ["#295a51", "#38765a", "#51905d", "#76ae62", "#a8c96e"],
    leaves: ["#36634f", "#578353", "#86af68"],
    soil: ["#376c54", "#5a925b", "#a2bc66"],
    flora: ["#686a99", "#8793c6", "#c3c5e4", "#e1cb7c"],
    wood: ["#795e4b", "#c6a675"],
  },
  {
    sky: ["#e5b389", "#f0cda1", "#f4ddaa"],
    cloud: ["#fae6bd", "#dfc4aa"],
    sun: "#ffe8ae",
    ridge: ["#c3aa9c", "#ae9a8d", "#938b7b", "#a29c75"],
    iceCap: "#e4c6a4",
    field: ["#a99d62", "#c2ae6b", "#e3c480", "#8e895e"],
    water: ["#879f92", "#a9b69a", "#dfd7a7", "#718c80"],
    bark: ["#735145", "#a17b58"],
    canopy: ["#8e554a", "#b25f43", "#ce7a44", "#e79b4c", "#f7c171"],
    leaves: ["#876644", "#aea04c", "#ceab59"],
    soil: ["#7e7049", "#aa9051", "#d4b366"],
    flora: ["#a45a43", "#ce7442", "#efab5a", "#f4ce80"],
    wood: ["#856647", "#bc986a"],
  },
  {
    sky: ["#a9c5d9", "#cbdde5", "#e9e9dc"],
    cloud: ["#edf2ea", "#c9d8df"],
    sun: "#fff0ca",
    ridge: ["#b4c7d2", "#9db5c6", "#829cae", "#a1b6bf"],
    iceCap: "#e7eff0",
    field: ["#b4c7cf", "#d7e2e1", "#eef1e8", "#9fb5c0"],
    water: ["#92b7c7", "#b3d3d9", "#dfebdf", "#82a2b4"],
    bark: ["#6e797f", "#9d9e99"],
    canopy: ["#45676a", "#618281", "#879e9d", "#c5d4ce", "#eef1e6"],
    leaves: ["#718b91", "#9babb1", "#d8e7df"],
    soil: ["#98afbd", "#bececf", "#edf2e9"],
    flora: ["#827e7e", "#a79a86", "#eaf0e8", "#c5d9dd"],
    wood: ["#83888a", "#bdc8c6"],
  },
];
function random(seed) {
  let value = seed | 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
function pixelSurface(width) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = gridHeight;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  function rect(x, y, w, h, fill) {
    x = wrap(Math.round(x), width);
    y = Math.round(y);
    w = Math.round(w);
    h = Math.round(h);
    if (w <= 0 || h <= 0 || y >= gridHeight || y + h <= 0) return;
    ctx.fillStyle = fill;
    const head = Math.min(w, width - x);
    ctx.fillRect(x, y, head, h);
    if (w > head) ctx.fillRect(0, y, w - head, h);
  }
  function line(x0, y0, x1, y1, fill) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0),
      sx = x0 < x1 ? 1 : -1,
      dy = -Math.abs(y1 - y0),
      sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      rect(x0, y0, 1, 1, fill);
      if (x0 === x1 && y0 === y1) return;
      const e = err * 2;
      if (e >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
  function oval(x, y, rx, ry, fill) {
    rx = Math.max(1, Math.round(rx));
    ry = Math.max(1, Math.round(ry));
    for (let row = -ry; row <= ry; row++) {
      const half = Math.floor(
        rx * Math.sqrt(Math.max(0, 1 - (row / (ry + 0.22)) ** 2)),
      );
      rect(x - half, y + row, half * 2 + 1, 1, fill);
    }
  }
  function poly(points, fill) {
    const ys = points.map((p) => p[1]);
    for (
      let row = Math.max(0, Math.floor(Math.min(...ys)));
      row <= Math.min(gridHeight - 1, Math.ceil(Math.max(...ys)));
      row++
    ) {
      const at = row + 0.5,
        xs = [];
      for (let j = 0; j < points.length; j++) {
        const a = points[j],
          b = points[(j + 1) % points.length];
        if ((a[1] <= at && b[1] > at) || (b[1] <= at && a[1] > at))
          xs.push(a[0] + ((at - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let j = 0; j + 1 < xs.length; j += 2) {
        const low = Math.ceil(xs[j] - 0.5),
          end = Math.ceil(xs[j + 1] - 0.5);
        rect(low, row, end - low, 1, fill);
      }
    }
  }
  return { canvas, width, rect, line, oval, poly };
}
function cloud(s, x, y, span, p) {
  s.rect(x + 2, y + 2, span - 2, 1, p.cloud[1]);
  s.rect(x, y + 1, span, 1, p.cloud[0]);
  s.rect(x + 2, y, span - 5, 1, p.cloud[0]);
  s.rect(x + 4, y - 1, Math.ceil(span * 0.36), 2, p.cloud[0]);
  if (span > 12) s.rect(x + 7, y - 2, 4, 1, p.cloud[0]);
}
function ridge(s, knots, fill) {
  s.poly([...knots, [s.width, gridHeight + 1], [0, gridHeight + 1]], fill);
}
function distant(s, p, season) {
  const w = s.width;
  s.rect(0, 0, w, 32, p.sky[0]);
  s.rect(0, 6, w, 26, p.sky[1]);
  s.rect(0, 15, w, 17, p.sky[2]);
  const sunX = [167, 175, 161, 177][season];
  s.oval(sunX, 5, 4, 4, p.sun);
  cloud(s, 16, 4, 14, p);
  cloud(s, 59, 6, 21, p);
  cloud(s, 126, 3, 12, p);
  cloud(s, 213, 5, 17, p);
  cloud(s, 264, 3, 13, p);
  const back = [
    [0, 13],
    [12, 12],
    [26, 7],
    [32, 9],
    [44, 4],
    [57, 12],
    [66, 10],
    [79, 15],
    [91, 12],
    [109, 7],
    [115, 8],
    [124, 5],
    [139, 12],
    [146, 10],
    [157, 13],
    [172, 9],
    [184, 5],
    [196, 11],
    [207, 10],
    [218, 14],
    [233, 9],
    [246, 5],
    [260, 12],
    [269, 10],
    [w, 13],
  ];
  ridge(s, back, p.ridge[0]);
  for (const [x, y, width] of [
    [26, 7, 6],
    [44, 4, 13],
    [109, 7, 5],
    [124, 5, 14],
    [184, 5, 12],
    [246, 5, 15],
  ]) {
    s.poly(
      [
        [x, y],
        [x + width, y + 8],
        [x + 3, y + 6],
        [x + 4, y + 5],
        [x + 1, y + 3],
      ],
      p.ridge[1],
    );
    if (season === 3)
      s.poly(
        [
          [x - 5, y + 3],
          [x, y - 0.35],
          [x + 5, y + 3],
          [x + 2, y + 2],
          [x + 1, y + 3],
          [x - 1, y + 2],
          [x - 3, y + 3],
        ],
        p.iceCap,
      );
  }
  ridge(
    s,
    [
      [0, 16],
      [15, 13],
      [30, 16],
      [44, 13],
      [54, 14],
      [68, 10],
      [79, 15],
      [91, 16],
      [104, 12],
      [120, 15],
      [132, 13],
      [141, 16],
      [154, 12],
      [166, 11],
      [181, 16],
      [194, 13],
      [206, 14],
      [215, 10],
      [229, 15],
      [240, 13],
      [256, 17],
      [274, 13],
      [w, 16],
    ],
    p.ridge[2],
  );
  const rng = random(529);
  for (let x = 0; x < w; x += 2 + Math.floor(rng() * 3)) {
    const y = 18 + Math.round(1.15 * Math.sin((x / w) * Math.PI * 6));
    const h = 2 + Math.floor(rng() * 3);
    s.rect(x, y - h, 1, h, p.ridge[3]);
    s.rect(x - 1, y - h + 2, 3, h - 1, p.ridge[3]);
    s.rect(x - 2, y, 5, 12, p.ridge[3]);
  }
}
function branch(s, x, y, size, p) {
  s.rect(x - 1, y - size, 2, size, p.bark[0]);
  s.rect(x - 1, y - size + 2, 1, Math.max(1, size - 3), p.bark[1]);
  s.line(x, y - size * 0.34, x - size * 0.35, y - size * 0.73, p.bark[0]);
  s.line(x + 1, y - size * 0.48, x + size * 0.39, y - size * 0.86, p.bark[0]);
}
function crown(s, x, y, z, p, variant, season) {
  const o = (dx, dy, a, b, c) =>
    s.oval(x + dx * z, y + dy * z, a * z, b * z, c);
  const paleBlossom = season === 0 && (variant === 2 || variant === 7);
  const c = paleBlossom
    ? ["#858d7b", "#bbab99", "#d7c9ac", "#efe1be", "#fff1d6"]
    : p.canopy;
  // Overlapping, asymmetrical leaf clusters have a common upper-left light.
  o(-4, 1, 5, 3, c[0]);
  o(1, 1, 6, 4, c[0]);
  o(6, 1, 4, 3, c[0]);
  o(2, -2, 6, 4, c[1]);
  o(-5, -1, 5, 3, c[1]);
  o(5, 0, 4, 3, c[1]);
  o(-1, -3, 5, 3, c[2]);
  o(-6, -1, 4, 2, c[2]);
  o(3, -1, 4, 2, c[2]);
  o(-2, -4, 4, 2, c[3]);
  o(-6, -2, 2, 1, c[3]);
  s.rect(x - 4 * z, y - 5 * z, 3 * z, 1, c[4]);
  s.rect(x - 6 * z, y - 4 * z, 2, 1, c[4]);
  s.rect(x + 2 * z, y - 2 * z, 3, 1, c[3]);
  s.rect(x + 4 * z, y, 2, 1, c[3]);
  s.rect(x - 4 * z, y + 2 * z, 2, 1, c[1]);
  s.rect(x + 2 * z, y + 3 * z, 3, 1, c[1]);
  if (season === 0) {
    const rng = random(variant * 23 + 81);
    for (let j = 0; j < 9; j++) {
      const dx = Math.round((rng() - 0.5) * 12 * z),
        dy = Math.round((rng() - 0.5) * 4 * z);
      s.rect(x + dx, y + dy, j % 4 === 0 ? 2 : 1, 1, j % 3 === 0 ? c[4] : c[3]);
    }
  }
  if (season === 1) {
    const tails = [
      [-8, 1, 4],
      [-5, 3, 4],
      [3, 3, 3],
      [7, 2, 5],
      [9, 1, 4],
    ];
    for (const [dx, dy, length] of tails) {
      const ax = x + Math.round(dx * z),
        ay = y + Math.round(dy * z);
      s.rect(ax, ay, 1, length * z, c[1]);
      s.rect(ax - 1, ay, 1, Math.max(1, length * z - 2), c[2]);
    }
  }
}
function slenderTree(s, x, base, z, p, season) {
  const height = Math.round(11 + z * 4),
    mid = base - height * 0.55,
    top = base - height;
  const c =
    season === 2 ? ["#936c47", "#c08b43", "#dfaa53", "#f5c978"] : p.canopy;
  s.rect(x, top + 2, 1, height - 2, p.bark[0]);
  if (season === 2) s.rect(x - 1, base - 4, 1, 4, "#d2bb8d");
  s.poly(
    [
      [x, top],
      [x + 2, top + 3],
      [x + 2, mid - 1],
      [x + 4, mid + 2],
      [x + 2, base - 3],
      [x - 1, base - 2],
      [x - 3, base - 4],
      [x - 3, mid],
      [x - 1, top + 3],
    ],
    c[0],
  );
  s.poly(
    [
      [x, top],
      [x + 1, top + 4],
      [x + 2, mid],
      [x + 1, base - 4],
      [x - 2, base - 3],
      [x - 3, mid + 1],
      [x - 1, top + 3],
    ],
    c[2],
  );
  s.rect(x - 1, top + 3, 2, 3, c[3]);
  s.rect(x - 2, mid + 1, 2, 1, c[3]);
  s.rect(x + 1, mid + 2, 1, 2, c[1]);
}
function maple(s, x, y, z, p, alternate) {
  const c = alternate
    ? ["#946541", "#b77c40", "#d49a44", "#edb557", "#f7cf7d"]
    : p.canopy;
  const shape = (pts, color) =>
    s.poly(
      pts.map(([dx, dy]) => [x + dx * z, y + dy * z]),
      color,
    );
  shape(
    [
      [-10, 2],
      [-8, -2],
      [-5, -3],
      [-4, -6],
      [-1, -5],
      [1, -8],
      [4, -5],
      [6, -5],
      [7, -2],
      [10, 0],
      [9, 3],
      [5, 4],
      [3, 6],
      [-2, 5],
      [-4, 6],
      [-7, 3],
    ],
    c[0],
  );
  shape(
    [
      [-9, 1],
      [-6, -2],
      [-4, -5],
      [-1, -4],
      [1, -7],
      [3, -4],
      [6, -4],
      [6, -1],
      [9, 0],
      [6, 3],
      [2, 4],
      [-3, 3],
      [-6, 3],
    ],
    c[2],
  );
  shape(
    [
      [-8, 0],
      [-4, -4],
      [-2, -4],
      [0, -5],
      [1, -6],
      [3, -4],
      [2, -2],
      [-2, -2],
      [-4, 0],
    ],
    c[3],
  );
  shape(
    [
      [0, 2],
      [4, 0],
      [6, -1],
      [8, 0],
      [6, 2],
      [3, 3],
    ],
    c[1],
  );
  s.rect(x - 3 * z, y - 4 * z, 3, 1, c[4]);
  s.rect(x - 6 * z, y - 2 * z, 2, 1, c[4]);
  s.rect(x + 1, y, 2, 1, c[3]);
}
function spruce(s, x, base, size, p) {
  const c = p.canopy,
    top = base - size;
  s.rect(x - 1, base - 4, 2, 4, p.bark[0]);
  for (const [t, r, ht] of [
    [0.37, 0.37, 0.46],
    [0.18, 0.29, 0.43],
    [0, 0.21, 0.39],
  ]) {
    const y = top + size * t,
      w = Math.max(2, Math.round(size * r)),
      h = Math.max(4, Math.round(size * ht));
    s.poly(
      [
        [x, y],
        [x + w + 1, y + h],
        [x + 2, y + h - 1],
        [x + 2, y + h + 1],
        [x - 2, y + h],
        [x - w, y + h],
      ],
      c[0],
    );
    s.poly(
      [
        [x, y],
        [x + 2, y + h - 1],
        [x - 2, y + h - 2],
        [x - w + 1, y + h - 1],
      ],
      c[2],
    );
    s.poly(
      [
        [x, y - 1],
        [x + w - 1, y + h - 2],
        [x + 2, y + h - 3],
        [x, y + h - 2],
        [x - 2, y + h - 3],
        [x - w, y + h - 1],
      ],
      c[3],
    );
    s.poly(
      [
        [x, y - 1],
        [x + 1, y + h - 3],
        [x - 1, y + h - 3],
        [x - w, y + h - 1],
      ],
      c[4],
    );
  }
}
function birch(s, x, y, size, p) {
  s.rect(x - 1, y - size, 2, size, p.bark[0]);
  s.rect(x - 1, y - size, 1, size - 1, p.canopy[4]);
  for (const [dx, dy, len] of [
    [-1, 0.4, 4],
    [1, 0.58, 5],
    [-1, 0.72, 3],
  ]) {
    const by = y - size * dy;
    s.line(x, by, x + dx * len, by - len + 1, p.bark[0]);
    s.line(
      x + dx * len,
      by - len + 1,
      x + dx * (len + 2),
      by - len + 1,
      p.canopy[4],
    );
  }
  s.rect(x - 1, y - 4, 1, 1, p.bark[0]);
}
function bridge(s, x, y, p, season) {
  const shadow = p.wood[0],
    light = p.wood[1],
    cap = season === 3 ? p.canopy[4] : light;
  s.rect(x + 2, y - 1, 1, 6, shadow);
  s.rect(x + 13, y - 1, 1, 6, shadow);
  s.rect(x, y + 1, 17, 2, shadow);
  s.rect(x + 1, y, 15, 1, cap);
  s.rect(x + 2, y - 3, 1, 4, shadow);
  s.rect(x + 8, y - 4, 1, 4, shadow);
  s.rect(x + 14, y - 3, 1, 4, shadow);
  s.rect(x + 2, y - 3, 4, 1, light);
  s.rect(x + 6, y - 4, 6, 1, cap);
  s.rect(x + 12, y - 3, 3, 1, light);
}
function grove(s, p, season) {
  const w = s.width,
    rng = random(801 + season);
  const edge = (x) =>
    19 +
    Math.round(
      1.0 * Math.sin((x / w) * Math.PI * 4) +
        0.65 * Math.sin((x / w) * Math.PI * 8 + 0.6),
    );
  const bank = (x) =>
    23 +
    Math.round(
      1.1 * Math.sin((x / w) * Math.PI * 4 + 0.7) +
        0.7 * Math.sin((x / w) * Math.PI * 6 - 0.5),
    );
  for (let x = 0; x < w; x++) {
    const y = edge(x),
      water = bank(x);
    s.rect(x, y, 1, 32 - y, p.field[0]);
    s.rect(x, y, 1, 1, p.field[1]);
    s.rect(x, y + 1, 1, Math.max(1, water - y - 1), p.field[1]);
    s.rect(x, water - 1, 1, 1, p.field[3]);
    s.rect(x, water, 1, 32 - water, p.water[0]);
    s.rect(x, water, 1, 1, p.water[3]);
  }
  for (let j = 0; j < 45; j++) {
    const x = Math.floor(rng() * w),
      y = bank(x) + 1 + Math.floor(rng() * 5);
    s.rect(
      x,
      y,
      2 + Math.floor(rng() * 5),
      1,
      j % 4 === 0 ? p.water[2] : p.water[1],
    );
  }
  for (const [x, z, v] of [
    [12, 0.83, 1],
    [35, 0.58, 2],
    [69, 0.9, 3],
    [87, 0.64, 4],
    [118, 0.59, 5],
    [145, 1.13, 6],
    [166, 0.74, 7],
    [215, 0.96, 8],
    [235, 0.63, 9],
  ]) {
    const y = edge(x) + 1;
    s.rect(x - 4 * z, y, 8 * z, 1, p.field[3]);
    if (season === 3) {
      if (v === 2 || v === 5 || v === 7)
        birch(s, x, y, Math.round(12 * z + 2), p);
      else spruce(s, x, y, Math.round(14 * z + 3), p);
    } else if (
      (season === 1 || season === 2) &&
      (v === 2 || v === 5 || v === 7)
    ) {
      slenderTree(s, x, y, z, p, season);
    } else {
      const cy = y - Math.round(8 * z);
      branch(s, x, y, Math.round(10 * z), p);
      if (season === 2) maple(s, x, cy, z, p, v % 3 === 1);
      else crown(s, x, cy, z, p, v, season);
    }
  }
  for (const [x, length] of [
    [14, 4],
    [69, 6],
    [143, 8],
    [216, 5],
  ]) {
    const y = bank(x) + 1;
    s.rect(x - length / 2, y, length, 1, p.water[3]);
    s.rect(x - 1, y + 2, Math.max(2, length - 3), 1, p.water[1]);
  }
  for (let j = 0; j < 24; j++) {
    const x = Math.floor(rng() * w),
      y = edge(x) + 1;
    s.rect(x, y, 2, 1, p.field[2]);
  }
  if (season === 1 || season === 3) bridge(s, 179, bank(185) - 1, p, season);
  else {
    for (const [dx, dy, sz] of [
      [0, 0, 4],
      [6, 1, 3],
      [10, 2, 4],
      [17, 2, 3],
    ]) {
      s.rect(178 + dx, bank(183) + dy, sz, 2, p.water[3]);
      s.rect(178 + dx, bank(183) + dy, sz - 1, 1, p.field[2]);
    }
  }
  if (season === 3)
    for (let j = 0; j < 9; j++) {
      const x = Math.floor(rng() * w),
        y = bank(x) + 2 + Math.floor(rng() * 3);
      s.line(x, y, x + 3, y - 1, p.water[2]);
      s.rect(x + 4, y - 1, 2, 1, p.water[2]);
    }
}
function grass(s, x, y, z, p) {
  s.line(x, y, x - 3 * z, y - 3 * z, p.leaves[0]);
  s.line(x, y, x - 1 * z, y - 4 * z, p.leaves[1]);
  s.line(x + 1, y, x + 3 * z, y - 3 * z, p.leaves[1]);
  s.rect(x + 2 * z, y - 3 * z, 1, 1, p.leaves[2]);
}
function daisy(s, x, y, p, pink) {
  s.line(x, y + 5, x, y, p.leaves[0]);
  s.rect(x - 2, y + 3, 2, 1, p.leaves[1]);
  const petal = pink ? p.flora[1] : p.flora[2];
  s.rect(x - 1, y - 1, 2, 1, petal);
  s.rect(x - 2, y, 4, 1, petal);
  s.rect(x, y + 1, 1, 1, petal);
  s.rect(x, y, 1, 1, p.flora[3]);
}
function hydrangea(s, x, y, p, flip) {
  s.line(x, y + 5, x, y, p.leaves[0]);
  s.oval(x + 2, y + 3, 2, 1, p.leaves[1]);
  s.oval(x - 2, y + 2, 2, 1, p.leaves[0]);
  s.oval(x, y, 3, 2, p.flora[0]);
  s.oval(x - 1, y - 1, 2, 1, p.flora[1]);
  s.rect(x + 1, y, 2, 1, p.flora[1]);
  s.rect(x - 2, y - 1, 1, 1, p.flora[2]);
  s.rect(x + 1, y - (flip ? 1 : 2), 1, 1, p.flora[2]);
}
function wheat(s, x, y, n, p, frost) {
  const stem = frost ? p.flora[1] : p.leaves[0],
    ear = frost ? p.flora[2] : p.flora[3];
  s.line(x, y, x + 2, y - n, stem);
  s.rect(x + 2, y - n - 1, 1, 1, ear);
  s.rect(x, y - n + 1, 2, 1, ear);
  s.rect(x + 2, y - n + 2, 2, 1, frost ? p.flora[3] : p.flora[2]);
}
function verge(s, p, season) {
  const w = s.width,
    rng = random(901 + season);
  const edge = (x) =>
    29 +
    Math.round(
      1.2 * Math.sin((x / w) * Math.PI * 6 + 0.8) +
        0.85 * Math.sin((x / w) * Math.PI * 10),
    );
  for (let x = 0; x < w; x++) {
    const y = edge(x);
    s.rect(x, y, 1, 32 - y, p.soil[1]);
    s.rect(x, y, 1, 1, p.soil[2]);
    if (y + 2 < 32) s.rect(x, y + 2, 1, 32 - y - 2, p.soil[0]);
  }
  for (let j = 0; j < 29; j++) {
    const x = Math.floor(rng() * w),
      y = edge(x) + 1;
    if (season !== 3) grass(s, x, y, 0.45 + rng() * 0.43, p);
    else
      s.rect(x, y, 2 + Math.floor(rng() * 5), 1, j % 3 ? p.soil[2] : p.soil[0]);
  }
  for (const [x, height, side] of [
    [5, 3, 1],
    [22, 5, -1],
    [48, 3, 1],
    [77, 5, -1],
    [101, 3, 1],
    [126, 4, 1],
    [151, 4, -1],
    [176, 5, 1],
    [203, 4, -1],
  ]) {
    const y = edge(x);
    if (season === 0) {
      daisy(s, x, y - height, p, side === 1);
      daisy(s, x + 4, y - height + 1, p, side !== 1);
      if (height === 5) daisy(s, x - 4, y - 2, p, false);
    } else if (season === 1) {
      if (height >= 4) {
        hydrangea(s, x, y - height + 1, p, side === 1);
        hydrangea(s, x + 5, y - 2, p, side !== 1);
      } else grass(s, x, y, 1.3, p);
    } else if (season === 2) {
      wheat(s, x, y, height + 1, p, false);
      wheat(s, x - 3, y + 1, height - 1, p, false);
      s.line(x + 5, y - 1, x + 8, y - 3, p.flora[1]);
      s.rect(x + 6, y - 2, 2, 1, p.flora[2]);
    } else {
      if (height >= 4) {
        wheat(s, x, y, height, p, true);
        s.line(x - 1, y, x - 3, y - 3, p.flora[1]);
        s.rect(x - 4, y - 3, 2, 1, p.flora[2]);
      }
      s.rect(x + 4, y - 1, 4, 1, p.soil[2]);
    }
  }
}
export function pixelTile(season, kind) {
  const key = season + "/" + kind;
  if (!tiles.has(key)) {
    const surface = pixelSurface(period[kind]);
    const draw = { far: distant, mid: grove, near: verge }[kind];
    draw(surface, palettes[season], season);
    tiles.set(key, surface.canvas);
  }
  return tiles.get(key);
}
