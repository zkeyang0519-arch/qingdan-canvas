import { prepareImageFile } from "../canvas/image-import.js";
import { getAvatarSourceRect } from "./avatar-crop.js";

export async function loadAvatarImage(file) {
  if (file.size > 20 * 1024 * 1024)
    throw new Error("请选择不超过 20 MB 的头像图片。");
  const imageFile = await prepareImageFile(file);
  let bitmap;
  try {
    bitmap = await createImageBitmap(imageFile);
  } catch {
    throw new Error("无法读取这张图片，请换一张 PNG、JPEG、WebP 或 GIF 图片。");
  }
  if (!(bitmap.width > 0 && bitmap.height > 0)) {
    bitmap.close();
    throw new Error("无法读取图片尺寸，请换一张图片。");
  }
  return bitmap;
}

export function drawAvatarCrop(context, image, crop, size) {
  if (!context) throw new Error("无法处理头像图片，请重试。");
  const source = getAvatarSourceRect(image, crop);
  context.clearRect(0, 0, size, size);
  context.save();
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  context.clip();
  context.drawImage(
    image,
    source.x,
    source.y,
    source.size,
    source.size,
    0,
    0,
    size,
    size,
  );
  context.restore();
}

export async function prepareAvatarImage(image, crop) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  drawAvatarCrop(canvas.getContext("2d"), image, crop, 256);
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("头像处理失败，请重试。")),
      "image/webp",
      0.85,
    );
  });
}
