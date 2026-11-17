// The same flowing color field as the approved palette preview. Glass changes
// only the sampling at the rim and adds reflected light; it never tints the field.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

export function createIslandColorField({
  width,
  height,
  radius,
  profile,
  design,
  small = false,
}) {
  const fw = Math.max(1, Math.min(216, Math.round(width)));
  const fh = Math.max(1, Math.min(86, Math.round(height)));
  const palette = (small ? [profile.smallColor] : profile.colors).map(rgb);
  const strength = design === "glass" ? profile.glassStrength : 0;
  const r = clamp(radius, 0, Math.min(width, height) / 2);
  const map = new Float32Array(fw * fh * 4);
  for (let y = 0; y < fh; y++)
    for (let x = 0; x < fw; x++) {
      const px = ((x + 0.5) * width) / fw,
        py = ((y + 0.5) * height) / fh;
      const dx = px - width / 2,
        dy = py - height / 2;
      const qx = Math.abs(dx) - (width / 2 - r),
        qy = Math.abs(dy) - (height / 2 - r);
      let nx, ny, depth;
      if (qx > 0 && qy > 0) {
        const length = Math.hypot(qx, qy);
        nx = (Math.sign(dx) * qx) / length;
        ny = (Math.sign(dy) * qy) / length;
        depth = r - length;
      } else if (qx > qy) {
        nx = Math.sign(dx);
        ny = 0;
        depth = r - qx;
      } else {
        nx = 0;
        ny = Math.sign(dy);
        depth = r - qy;
      }
      depth = Math.max(0, depth);
      const light = Math.max(0, -ny * 0.88 - nx * 0.38);
      const bottom = Math.max(0, ny * 0.85 + nx * 0.2);
      const shift = 13.5 * Math.exp(-depth / 4.8) * strength;
      const white =
        (0.028 +
          0.68 * light ** 2.8 * Math.exp(-depth / 2.5) +
          0.14 * bottom * Math.exp(-depth / 2) +
          0.1 * light * Math.exp(-(((depth - 1.2) / 0.9) ** 2))) *
        strength;
      const i = (y * fw + x) * 4;
      map[i] = clamp((px - nx * shift) / width, 0, 1);
      map[i + 1] = clamp((py - ny * shift) / height, 0, 1);
      map[i + 2] = Math.min(0.85, white);
      map[i + 3] = 0.08 * bottom * Math.exp(-depth / 3.5) * strength;
    }
  return {
    width: fw,
    height: fh,
    render(phase, pixels = new Uint8ClampedArray(fw * fh * 4)) {
      const n = palette.length,
        sharpness = 4.4 + Math.max(0, n - 3) * 1.8;
      const pools = palette.map((_, i) => [
        (n === 1 ? 1.3 : 0.35 + (2 * i) / (n - 1)) +
          0.52 * Math.sin(phase * (0.73 + 0.07 * (i % 4)) + i * 1.1),
        0.5 + 0.47 * Math.cos(phase * (0.83 + 0.06 * (i % 3)) + i * 1.7),
      ]);
      for (let i = 0; i < pixels.length; i += 4) {
        const u = map[i],
          v = map[i + 1],
          white = map[i + 2],
          shade = map[i + 3];
        const fx =
          u * 2.6 +
          0.31 * Math.sin(v * 3.4 + phase) +
          0.16 * Math.sin(u * 5.3 - phase * 0.71);
        const fy =
          v +
          0.28 * Math.sin(u * 5 - phase * 0.87) +
          0.1 * Math.cos(v * 4.1 + phase * 0.63);
        let total = 0,
          red = 0,
          green = 0,
          blue = 0;
        for (let c = 0; c < n; c++) {
          const weight = Math.exp(
            -sharpness *
              ((fx - pools[c][0]) ** 2 + (fy - pools[c][1]) ** 2 * 0.68),
          );
          total += weight;
          red += palette[c][0] * weight;
          green += palette[c][1] * weight;
          blue += palette[c][2] * weight;
        }
        const factor = ((1 - shade) * (1 - white)) / total;
        pixels[i] = red * factor + 255 * white;
        pixels[i + 1] = green * factor + 255 * white;
        pixels[i + 2] = blue * factor + 255 * white;
        // The parent clips at device resolution, not this lower-resolution buffer.
        pixels[i + 3] = 255;
      }
      return pixels;
    },
  };
}
