import type { Env, Room } from "./types";
import { body, check, failure, json, sameOrigin, validId } from "./http";
import {
  digest,
  membership,
  publicRoom,
  requireSession,
  sessionEndpoint,
  token,
} from "./auth";
import { assetEndpoint } from "./assets";
export { CanvasRoom } from "./room";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
      sameOrigin(request);
      if (path === "/api/health")
        return json({
          ok: true,
          environment: env.APP_ENV,
          services: ["Workers", "Durable Objects", "D1", "R2"],
        });
      if (path === "/api/session") return await sessionEndpoint(request, env);
      const user = await requireSession(request, env);
      if (path === "/api/rooms") {
        if (request.method === "GET") {
          const { results } = await env.DB.prepare(
            "SELECT r.*,m.role FROM rooms r JOIN members m ON r.id=m.room_id WHERE m.user_id=? ORDER BY r.created_at DESC",
          )
            .bind(user.id)
            .all<Room>();
          return json({ rooms: results.map(publicRoom) });
        }
        check(request.method === "POST", "方法不支持。", 405);
        const input = await body(request);
        check(
          typeof input.name === "string" &&
            input.name.trim().length > 0 &&
            input.name.trim().length <= 80,
          "画布名称需要 1–80 个字。",
        );
        if (env.APP_ENV !== "local") {
          check(env.CREATE_KEY, "管理员尚未配置画布创建口令。", 503);
          check(
            typeof input.createKey === "string" &&
              (await digest(input.createKey)) ===
                (await digest(env.CREATE_KEY)),
            "创建口令不正确。",
            403,
          );
        }
        const id = crypto.randomUUID(),
          invite = token(),
          date = new Date().toISOString();
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO rooms(id,name,owner_id,invite_hash,created_at) VALUES(?,?,?,?,?)",
          ).bind(id, input.name.trim(), user.id, await digest(invite), date),
          env.DB.prepare(
            "INSERT INTO members(room_id,user_id,role,joined_at) VALUES(?,?,?,?)",
          ).bind(id, user.id, "owner", date),
        ]);
        return json(
          {
            room: {
              id,
              name: input.name.trim(),
              createdAt: date,
              role: "owner",
            },
            invite,
          },
          201,
        );
      }
      const match = path.match(
        /^\/api\/rooms\/([a-zA-Z0-9_-]+)(?:\/(join|invite|socket|snapshot|assets)(?:\/([a-zA-Z0-9_-]+))?)?$/,
      );
      check(match, "接口不存在。", 404);
      const [, roomId, action, assetId] = match;
      check(validId(roomId), "画布编号无效。");
      if (action === "join") {
        check(request.method === "POST", "方法不支持。", 405);
        const input = await body(request);
        check(
          typeof input.invite === "string" && input.invite.length <= 128,
          "邀请链接无效。",
          403,
        );
        const room = await env.DB.prepare(
          "SELECT * FROM rooms WHERE id=? AND invite_hash=?",
        )
          .bind(roomId, await digest(input.invite))
          .first<Room>();
        check(room, "邀请链接无效或已被重置。", 403);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO members(room_id,user_id,role,joined_at) VALUES(?,?,?,?)",
        )
          .bind(roomId, user.id, "editor", new Date().toISOString())
          .run();
        return json({
          room: publicRoom(await membership(env, roomId, user.id)),
        });
      }
      const room = await membership(env, roomId, user.id);
      if (action === "invite") {
        check(request.method === "POST", "方法不支持。", 405);
        check(room.role === "owner", "只有创建者可以生成或重置邀请。", 403);
        const invite = token();
        await env.DB.prepare("UPDATE rooms SET invite_hash=? WHERE id=?")
          .bind(await digest(invite), roomId)
          .run();
        return json({ invite });
      }
      if (action === "assets") {
        check(validId(assetId), "图片编号无效。");
        return await assetEndpoint(request, env, roomId, assetId);
      }
      if (action === "socket" || action === "snapshot") {
        check(request.method === "GET", "方法不支持。", 405);
        if (action === "socket")
          check(
            request.headers.get("Upgrade")?.toLowerCase() === "websocket",
            "需要 WebSocket 连接。",
            426,
          );
        const forwarded = new Request(request);
        forwarded.headers.set("X-QD-Room", roomId);
        forwarded.headers.set("X-QD-User", user.id);
        forwarded.headers.set("X-QD-Name", encodeURIComponent(user.name));
        forwarded.headers.set("X-QD-Expires", String(user.expires_at));
        return await env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(
          forwarded,
        );
      }
      check(request.method === "GET", "方法不支持。", 405);
      return json({ room: publicRoom(room) });
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<Env>;
