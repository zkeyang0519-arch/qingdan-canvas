import { prepareImageFile } from "../canvas/image-import.js";

export async function prepareAvatarImage(file) {
  if (file.size > 5 * 1024 * 1024)
    throw new Error("请选择不超过 5 MB 的头像图片。");
  const imageFile = await prepareImageFile(file);
  let bitmap;
  try {
    bitmap = await createImageBitmap(imageFile);
  } catch {
    throw new Error("无法读取这张图片，请换一张 PNG、JPEG、WebP 或 GIF 图片。");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const side = Math.min(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context || !side) throw new Error("无法处理头像图片，请重试。");
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("头像处理失败，请换一张图片。")),
        "image/webp",
        0.85,
      );
    });
  } finally {
    bitmap.close();
  }
}
