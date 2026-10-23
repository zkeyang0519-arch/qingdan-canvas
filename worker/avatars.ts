import type { Env, Session } from "./types";
import { check, json, limitedBytes } from "./http";
import { publicUser } from "./auth";
import { imageSignature } from "./assets";

const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const avatarKey = (id: string, version: string) => `avatars/${id}/${version}`;

async function notifyRooms(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT room_id FROM members WHERE user_id=?",
  )
    .bind(userId)
    .all<{ room_id: string }>();
  await Promise.all(
    results.map(async ({ room_id }) => {
      const response = await env.ROOMS.get(env.ROOMS.idFromName(room_id)).fetch(
        new Request("https://room.internal/profile", {
          method: "POST",
          headers: {
            "X-QD-Room": room_id,
            "X-QD-User": userId,
            "X-QD-Profile-Refresh": "1",
          },
        }),
      );
      if (!response.ok)
        throw new Error("头像已保存，成员资料刷新将在重连后完成。");
    }),
  );
}

export async function updateAvatar(
  request: Request,
  env: Env,
  user: Session,
  ctx: ExecutionContext,
) {
  check(["PUT", "DELETE"].includes(request.method), "方法不支持。", 405);
  const previous = user.avatar_version || null;
  let version: string | null = null;
  if (request.method === "PUT") {
    const mime = request.headers.get("Content-Type")?.split(";")[0] || "";
    check(allowed.has(mime), "头像只支持 PNG、JPEG、WebP、GIF 图片。", 415);
    const bytes = await limitedBytes(request, 2 * 1024 * 1024);
    check(
      bytes.length > 0 && imageSignature(bytes, mime),
      "头像文件格式无效，请重新选择图片。",
      415,
    );
    version = crypto.randomUUID();
    await env.FILES.put(avatarKey(user.id, version), bytes, {
      httpMetadata: { contentType: mime },
    });
  }
  try {
    const result = await env.DB.prepare(
      "UPDATE accounts SET avatar_version=? WHERE id=? AND avatar_version IS ?",
    )
      .bind(version, user.id, previous)
      .run();
    check(
      result.meta.changes === 1,
      "头像已在其他页面更新，请刷新后重试。",
      409,
    );
  } catch (error) {
    if (version) await env.FILES.delete(avatarKey(user.id, version));
    throw error;
  }
  ctx.waitUntil(
    Promise.all([
      previous
        ? env.FILES.delete(avatarKey(user.id, previous))
        : Promise.resolve(),
      notifyRooms(env, user.id),
    ]).catch((error) =>
      console.error("Avatar cleanup or notification failed", error),
    ),
  );
  return json({ user: publicUser({ ...user, avatar_version: version }) });
}

export async function readAvatar(
  request: Request,
  env: Env,
  user: Session,
  targetId: string,
) {
  check(request.method === "GET", "方法不支持。", 405);
  if (targetId !== user.id) {
    const shared = await env.DB.prepare(
      "SELECT 1 FROM members mine JOIN members theirs ON mine.room_id=theirs.room_id WHERE mine.user_id=? AND theirs.user_id=? LIMIT 1",
    )
      .bind(user.id, targetId)
      .first();
    check(shared, "你没有此头像的访问权限。", 403);
  }
  const account = await env.DB.prepare(
    "SELECT avatar_version FROM accounts WHERE id=?",
  )
    .bind(targetId)
    .first<{ avatar_version: string | null }>();
  check(account?.avatar_version, "尚未上传头像。", 404);
  const object = await env.FILES.get(
    avatarKey(targetId, account.avatar_version),
  );
  check(object, "头像暂时不可用。", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "image/webp",
      "Content-Length": String(object.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}
