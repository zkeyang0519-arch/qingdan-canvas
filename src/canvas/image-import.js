export async function prepareImageFile(file) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const starts = (signature, offset = 0) =>
    signature.every((value, i) => bytes[offset + i] === value);
  let mime;
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) mime = "image/png";
  else if (starts([255, 216, 255])) mime = "image/jpeg";
  else if (
    starts([71, 73, 70, 56]) &&
    [55, 57].includes(bytes[4]) &&
    bytes[5] === 97
  )
    mime = "image/gif";
  else if (starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8))
    mime = "image/webp";
  else throw new Error(`无法识别图片格式：${file.name || "粘贴图片"}`);
  // Renaming an extension does not change the bytes. Upload with the real MIME.
  return file.type === mime
    ? file
    : new File([file], file.name || "粘贴图片", { type: mime });
}
