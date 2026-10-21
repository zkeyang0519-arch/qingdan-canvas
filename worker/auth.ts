import type { Env, Room, Session } from "./types";
import { body, check, json } from "./http";
const lifetime = 60 * 60 * 24 * 90;
export const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function getSession(request: Request, env: Env) {
  const raw = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)qd_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!raw) return null;
  return env.DB.prepare(
    "SELECT id,name,expires_at FROM sessions WHERE token_hash=? AND expires_at>?",
  )
    .bind(await digest(raw), Date.now())
    .first<Session>();
}
export async function requireSession(request: Request, env: Env) {
  const session = await getSession(request, env);
  check(session, "请刷新页面重新建立会话。", 401);
  return session;
}
export async function sessionEndpoint(request: Request, env: Env) {
  const existing = await getSession(request, env);
  if (request.method === "GET") {
    check(existing, "尚未建立会话。", 401);
    return json({ user: existing, createKeyRequired: env.APP_ENV !== "local" });
  }
  check(request.method === "POST", "方法不支持。", 405);
  const input = await body(request);
  const name =
    typeof input.name === "string" && input.name.trim()
      ? input.name.trim().slice(0, 32)
      : existing?.name || "访客";
  if (existing) {
    await env.DB.prepare("UPDATE sessions SET name=? WHERE id=?")
      .bind(name, existing.id)
      .run();
    return json({
      user: { ...existing, name },
      createKeyRequired: env.APP_ENV !== "local",
    });
  }
  const raw = token(),
    id = crypto.randomUUID(),
    expires_at = Date.now() + lifetime * 1000;
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,id,name,expires_at) VALUES(?,?,?,?)",
  )
    .bind(await digest(raw), id, name, expires_at)
    .run();
  return json(
    {
      user: { id, name, expires_at },
      createKeyRequired: env.APP_ENV !== "local",
    },
    200,
    {
      "Set-Cookie": `qd_session=${raw}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${lifetime}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`,
    },
  );
}
export async function membership(env: Env, roomId: string, userId: string) {
  const room = await env.DB.prepare(
    "SELECT r.*,m.role FROM rooms r JOIN members m ON r.id=m.room_id WHERE r.id=? AND m.user_id=?",
  )
    .bind(roomId, userId)
    .first<Room>();
  check(room, "你没有此画布的访问权限，请使用有效邀请链接。", 403);
  return room;
}
export const publicRoom = (room: Room) => ({
  id: room.id,
  name: room.name,
  createdAt: room.created_at,
  role: room.role || "owner",
});
