import type { Asset, Env } from "./types";
import { check, limitedBytes, json } from "./http";
const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function signature(bytes: Uint8Array, mime: string) {
  const text = (start: number, end: number) =>
    new TextDecoder().decode(bytes.slice(start, end));
  if (mime === "image/png")
    return (
      bytes[0] === 137 &&
      text(1, 4) === "PNG" &&
      bytes[4] === 13 &&
      bytes[5] === 10
    );
  if (mime === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(text(0, 6));
  return text(0, 4) === "RIFF" && text(8, 12) === "WEBP";
}
export async function assetEndpoint(
  request: Request,
  env: Env,
  room: string,
  id: string,
) {
  const key = `${room}/${id}`;
  if (request.method === "GET") {
    const meta = await env.DB.prepare(
      "SELECT * FROM assets WHERE room_id=? AND id=?",
    )
      .bind(room, id)
      .first<Asset>();
    check(meta, "图片不存在。", 404);
    const object = await env.FILES.get(key);
    check(object, "图片文件暂时不可用。", 404);
    return new Response(object.body, {
      headers: {
        "Content-Type": meta.mime,
        "Content-Length": String(meta.byte_length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline",
        ETag: object.httpEtag,
      },
    });
  }
  check(request.method === "PUT", "方法不支持。", 405);
  const mime = request.headers.get("Content-Type")?.split(";")[0] || "";
  check(allowed.has(mime), "只支持 PNG、JPEG、WebP、GIF 图片。", 415);
  const bytes = await limitedBytes(request, 10 * 1024 * 1024);
  check(
    bytes.length > 0 && signature(bytes, mime),
    "图片格式与文件内容不一致。",
    415,
  );
  let name = "图片";
  try {
    name = decodeURIComponent(
      request.headers.get("X-File-Name") || "图片",
    ).slice(0, 200);
  } catch {}
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  // Conditional R2 writes keep an existing asset immutable, including concurrent uploads.
  await env.FILES.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: mime },
    customMetadata: { sha256: hash },
  });
  const object = await env.FILES.head(key);
  check(
    object &&
      object.customMetadata?.sha256 === hash &&
      object.httpMetadata?.contentType === mime,
    "图片编号已使用，请重新添加图片。",
    409,
  );
  await env.DB.prepare(
    "INSERT OR IGNORE INTO assets(room_id,id,mime,byte_length,name,created_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(room, id, mime, bytes.length, name, new Date().toISOString())
    .run();
  return json({ id, mime, byteLength: bytes.length, name }, 201);
}
