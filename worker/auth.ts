import type { Env, Room, Session } from "./types";
import { body, check, json } from "./http";
export const lifetime = 60 * 60 * 24 * 30;
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
export async function sessionHash(request: Request) {
  const raw = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)qd_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  return raw ? digest(raw) : null;
}
export async function getSession(request: Request, env: Env) {
  const hash = await sessionHash(request);
  if (!hash) return null;
  return env.DB.prepare(
    "SELECT a.id,a.username,a.name,a.avatar_version,s.expires_at,s.token_hash FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?",
  )
    .bind(hash, Date.now())
    .first<Session>();
}
export async function requireSession(request: Request, env: Env) {
  const session = await getSession(request, env);
  check(session, "请先登录账号。", 401);
  return session;
}
export const publicUser = (
  session: Pick<Session, "id" | "username" | "name" | "avatar_version">,
) => ({
  id: session.id,
  username: session.username,
  name: session.name,
  avatarVersion: session.avatar_version || null,
});
export function sessionCookie(
  request: Request,
  raw: string,
  seconds = lifetime,
) {
  return `qd_session=${raw}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export async function legacySession(request: Request, env: Env) {
  const hash = await sessionHash(request);
  if (!hash) return null;
  return env.DB.prepare(
    "SELECT s.id,s.name,s.token_hash,(SELECT COUNT(*) FROM members m WHERE m.user_id=s.id) AS room_count FROM sessions s WHERE s.token_hash=? AND s.expires_at>? AND NOT EXISTS(SELECT 1 FROM legacy_claims c WHERE c.legacy_id=s.id)",
  )
    .bind(hash, Date.now())
    .first<{
      id: string;
      name: string;
      token_hash: string;
      room_count: number;
    }>();
}
export async function sessionEndpoint(request: Request, env: Env) {
  const existing = await getSession(request, env);
  if (request.method === "GET") {
    const legacy = existing ? null : await legacySession(request, env);
    return json({
      user: existing ? publicUser(existing) : null,
      legacyRoomCount: legacy?.room_count || 0,
    });
  }
  check(request.method === "POST", "方法不支持。", 405);
  check(existing, "请先注册或登录账号。", 401);
  check(
    !request.headers.get("X-QD-Account") ||
      request.headers.get("X-QD-Account") === existing.id,
    "账号已切换，请重新登录。",
    401,
  );
  const input = await body(request);
  check(
    typeof input.name === "string" &&
      input.name.trim().length > 0 &&
      input.name.trim().length <= 32,
    "昵称需要 1–32 个字。",
  );
  const name = input.name.trim();
  await env.DB.prepare("UPDATE accounts SET name=? WHERE id=?")
    .bind(name, existing.id)
    .run();
  return json({ user: publicUser({ ...existing, name }) });
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
