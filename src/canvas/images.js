export const fullCrop = () => ({ x: 0, y: 0, width: 1, height: 1 });
export const clamp = (value, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));
const escapeXml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );

// The same source-to-display transform is used by SVG, hit testing and PNG export.
export function imageFrame(object) {
  const crop = object.crop || fullCrop();
  const w = crop.width * object.naturalWidth,
    h = crop.height * object.naturalHeight;
  const rotation = object.rotation || 0;
  const [a, b, c, d, e, f] = {
    0: [1, 0, 0, 1, 0, 0],
    90: [0, 1, -1, 0, h, 0],
    180: [-1, 0, 0, -1, w, h],
    270: [0, -1, 1, 0, 0, w],
  }[rotation];
  const flip = object.flipX ? -1 : 1;
  const tx = -crop.x * object.naturalWidth;
  const ty = -crop.y * object.naturalHeight;
  return {
    width: rotation % 180 ? h : w,
    height: rotation % 180 ? w : h,
    matrix: [
      a * flip,
      b,
      c * flip,
      d,
      flip * (a * tx + c * ty + e) +
        (object.flipX ? (rotation % 180 ? h : w) : 0),
      b * tx + d * ty + f,
    ],
  };
}
export function sourcePoint(object, point) {
  const {
    width,
    height,
    matrix: [a, b, c, d, e, f],
  } = imageFrame(object);
  const x = clamp(point.x) * width - e,
    y = clamp(point.y) * height - f,
    det = a * d - b * c;
  return {
    x: clamp((d * x - c * y) / det / object.naturalWidth),
    y: clamp((-b * x + a * y) / det / object.naturalHeight),
  };
}
export function imageTransformPatch(object, changes) {
  const before = imageFrame(object),
    after = imageFrame({ ...object, ...changes });
  const scale = Math.max(
    object.width / before.width,
    40 / after.width,
    40 / after.height,
  );
  return {
    ...changes,
    width: after.width * scale,
    height: after.height * scale,
  };
}
export function validateImageData(object) {
  const unit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
  if (object.crop != null) {
    const c = object.crop;
    if (
      !["x", "y", "width", "height"].every((k) => unit(c[k])) ||
      c.width <= 0 ||
      c.height <= 0 ||
      c.x + c.width > 1 + 1e-9 ||
      c.y + c.height > 1 + 1e-9
    )
      throw new Error("图片裁剪区域无效。");
  }
  if (
    object.rotation !== undefined &&
    ![0, 90, 180, 270].includes(object.rotation)
  )
    throw new Error("图片旋转角度无效。");
  if (object.flipX !== undefined && typeof object.flipX !== "boolean")
    throw new Error("图片翻转属性无效。");
  if (object.annotations === undefined) return;
  if (!Array.isArray(object.annotations)) throw new Error("图片标注无效。");
  const ids = new Set();
  for (const mark of object.annotations) {
    if (
      !mark ||
      !["arrow", "ellipse", "highlight", "text"].includes(mark.kind) ||
      typeof mark.id !== "string" ||
      !mark.id ||
      ids.has(mark.id) ||
      !/^#[a-f\d]{6}$/i.test(mark.color) ||
      !Array.isArray(mark.points) ||
      mark.points.length !== (mark.kind === "text" ? 1 : 2) ||
      !mark.points.every((p) => p && unit(p.x) && unit(p.y)) ||
      (mark.kind === "text" && typeof mark.text !== "string")
    )
      throw new Error("图片标注内容或坐标无效。");
    ids.add(mark.id);
  }
}
function annotationGeometry(object, mark) {
  const point = (p) => ({
    x: p.x * object.naturalWidth,
    y: p.y * object.naturalHeight,
  });
  const a = point(mark.points[0]),
    b = point(mark.points[1] || mark.points[0]);
  const stroke = Math.max(1, object.naturalWidth * 0.006);
  const angle = Math.atan2(b.y - a.y, b.x - a.x),
    head = stroke * 4;
  const arrow = [
    b,
    {
      x: b.x - head * Math.cos(angle - 0.48),
      y: b.y - head * Math.sin(angle - 0.48),
    },
    {
      x: b.x - head * Math.cos(angle + 0.48),
      y: b.y - head * Math.sin(angle + 0.48),
    },
  ];
  return { a, b, stroke, arrow };
}
export function imageSvg(object, url, pending = []) {
  const { width, height, matrix } = imageFrame(object);
  const marks = [...(object.annotations || []), ...pending]
    .map((mark) => {
      const { a, b, stroke, arrow } = annotationGeometry(object, mark),
        color = escapeXml(mark.color);
      if (mark.kind === "text")
        return `<text x="${a.x}" y="${a.y}" font-family="sans-serif" font-size="${stroke * 5}" font-weight="500" fill="${color}" paint-order="stroke" stroke="#fffbed" stroke-width="${stroke * 0.7}">${escapeXml(mark.text)}</text>`;
      if (mark.kind === "ellipse")
        return `<ellipse cx="${(a.x + b.x) / 2}" cy="${(a.y + b.y) / 2}" rx="${Math.abs(b.x - a.x) / 2}" ry="${Math.abs(b.y - a.y) / 2}" fill="none" stroke="${color}" stroke-width="${stroke}"/>`;
      const line = `<path d="M${a.x} ${a.y} L${b.x} ${b.y}" fill="none" stroke="${color}" stroke-width="${mark.kind === "highlight" ? stroke * 6 : stroke}" opacity="${mark.kind === "highlight" ? 0.4 : 1}" stroke-linecap="round"/>`;
      return (
        line +
        (mark.kind === "arrow"
          ? `<polygon points="${arrow.map((p) => `${p.x},${p.y}`).join(" ")}" fill="${color}"/>`
          : "")
      );
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden"><g transform="matrix(${matrix.join(" ")})"><image href="${escapeXml(url || "")}" width="${object.naturalWidth}" height="${object.naturalHeight}"/>${marks}</g></svg>`;
}
export async function exportImage(object, blob) {
  if (!blob) throw new Error("原始图片资源不可用。");
  const image = new Image(),
    url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("无法读取原始图片。"));
      image.src = url;
    });
    const frame = imageFrame(object),
      canvas = document.createElement("canvas");
    // Bound the output allocation for very large originals without changing stored data.
    const scale = Math.min(
      1,
      8192 / frame.width,
      8192 / frame.height,
      Math.sqrt(32_000_000 / (frame.width * frame.height)),
    );
    canvas.width = Math.max(1, Math.round(frame.width * scale));
    canvas.height = Math.max(1, Math.round(frame.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.scale(canvas.width / frame.width, canvas.height / frame.height);
    ctx.transform(...frame.matrix);
    ctx.drawImage(image, 0, 0, object.naturalWidth, object.naturalHeight);
    for (const mark of object.annotations || []) {
      const { a, b, stroke, arrow } = annotationGeometry(object, mark);
      ctx.save();
      ctx.strokeStyle = mark.color;
      ctx.fillStyle = mark.color;
      ctx.lineWidth = stroke;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      if (mark.kind === "text") {
        ctx.font = `500 ${stroke * 5}px sans-serif`;
        ctx.strokeStyle = "#fffbed";
        ctx.lineWidth = stroke * 0.7;
        ctx.strokeText(mark.text, a.x, a.y);
        ctx.fillText(mark.text, a.x, a.y);
      } else if (mark.kind === "ellipse") {
        ctx.ellipse(
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
          Math.abs(b.x - a.x) / 2,
          Math.abs(b.y - a.y) / 2,
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      } else {
        if (mark.kind === "highlight") {
          ctx.globalAlpha = 0.4;
          ctx.lineWidth = stroke * 6;
        }
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        if (mark.kind === "arrow") {
          ctx.beginPath();
          arrow.forEach((p, i) =>
            i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
          );
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error("图片导出失败。")),
        "image/png",
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
