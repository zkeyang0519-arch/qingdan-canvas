import { DurableObject } from "cloudflare:workers";
import type { Asset, CanvasData, Change, Commit, Env, Row } from "./types";
import { check, failure, HttpError, json, validId } from "./http";
import { membership } from "./auth";
import { sharedObject } from "../shared/canvas-contract.js";

interface Attachment {
  user: string;
  room: string;
  name: string;
  connection: string;
  expires: number;
  session?: string;
  window: number;
  count: number;
}
export class CanvasRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload TEXT NOT NULL, value TEXT NOT NULL);
    `);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }
  rows(): Row[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM objects ORDER BY id")
      .toArray()
      .map((r) => JSON.parse(r.value) as Row);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const room = request.headers.get("X-QD-Room")!,
        user = request.headers.get("X-QD-User")!;
      check(validId(room) && validId(user), "无效的内部路由。", 403);
      if (
        !this.ctx.storage.sql.exec("SELECT id FROM objects LIMIT 1").toArray()
          .length
      ) {
        const now = new Date().toISOString();
        const data: CanvasData = {
          id: `${room}-root`,
          type: "collection",
          boardId: room,
          parentId: null,
          x: 32,
          y: 120,
          width: 64,
          height: 64,
          zIndex: 0,
          locked: false,
          createdAt: now,
          updatedAt: now,
          title: "收纳框",
          collapsed: false,
        };
        this.save({ id: data.id, revision: 1, deleted: false, data });
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return json({ rows: this.rows() });
      check(
        this.ctx.getWebSockets().length < 50,
        "画布已达到 50 个同时连接上限。",
        429,
      );
      const pair = new WebSocketPair(),
        socket = pair[1];
      this.ctx.acceptWebSocket(socket);
      socket.serializeAttachment({
        room,
        user,
        name: decodeURIComponent(request.headers.get("X-QD-Name") || "访客"),
        expires: Number(request.headers.get("X-QD-Expires")),
        session: request.headers.get("X-QD-Session") || "",
        connection: crypto.randomUUID(),
        window: Date.now(),
        count: 0,
      } satisfies Attachment);
      this.send(socket, { type: "snapshot", rows: this.rows() });
      await this.presence();
      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch (error) {
      return failure(error);
    }
  }
  save(row: Row) {
    this.ctx.storage.sql.exec(
      "INSERT INTO objects(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      row.id,
      JSON.stringify(row),
    );
  }
  send(socket: WebSocket, value: unknown) {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      try {
        socket.close(1011, "请重新连接");
      } catch {}
    }
  }
  async activeSockets() {
    const sockets = this.ctx.getWebSockets();
    const hashes = [
      ...new Set(
        sockets
          .map(
            (socket) => (socket.deserializeAttachment() as Attachment).session,
          )
          .filter((hash): hash is string => !!hash),
      ),
    ];
    const active = new Map<string, string>();
    if (hashes.length) {
      const { results } = await this.env.DB.prepare(
        `SELECT token_hash,account_id FROM account_sessions WHERE expires_at>? AND token_hash IN (${hashes.map(() => "?").join(",")})`,
      )
        .bind(Date.now(), ...hashes)
        .all<{ token_hash: string; account_id: string }>();
      for (const row of results) active.set(row.token_hash, row.account_id);
    }
    return sockets.filter((socket) => {
      const member = socket.deserializeAttachment() as Attachment;
      if (
        member.expires > Date.now() &&
        member.session &&
        active.get(member.session) === member.user
      )
        return true;
      try {
        socket.close(1008, "登录已失效，请重新登录");
      } catch {}
      return false;
    });
  }
  async broadcast(value: unknown, except?: WebSocket) {
    for (const socket of await this.activeSockets())
      if (socket !== except) this.send(socket, value);
  }
  async presence() {
    const sockets = await this.activeSockets();
    const value = {
      type: "presence",
      members: sockets.map((socket) => {
        const attachment = socket.deserializeAttachment() as Attachment;
        return {
          id: attachment.connection,
          userId: attachment.user,
          name: attachment.name,
        };
      }),
    };
    for (const socket of sockets) this.send(socket, value);
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    let opId: string | undefined;
    try {
      check(
        typeof message === "string" &&
          new TextEncoder().encode(message).length <= 1024 * 1024,
        "操作过大，请分批添加。",
        413,
      );
      let raw: unknown;
      try {
        raw = JSON.parse(message);
      } catch {
        throw new HttpError(400, "消息格式无效。");
      }
      check(raw && typeof raw === "object", "消息格式无效。");
      const input = raw as Commit;
      opId = input.opId;
      const member = socket.deserializeAttachment() as Attachment;
      check(member.expires > Date.now(), "会话已过期，请刷新页面。", 401);
      check(
        member.session &&
          (await this.env.DB.prepare(
            "SELECT 1 FROM account_sessions WHERE token_hash=? AND account_id=? AND expires_at>?",
          )
            .bind(member.session, member.user, Date.now())
            .first()),
        "登录已失效，请重新登录。",
        401,
      );
      if (Date.now() - member.window >= 1000) {
        member.window = Date.now();
        member.count = 0;
      }
      check(++member.count <= 40, "操作太频繁，请稍后重试。", 429);
      socket.serializeAttachment(member);
      await membership(this.env, member.room, member.user);
      check(
        input.type === "commit" &&
          validId(input.opId) &&
          Array.isArray(input.changes) &&
          input.changes.length > 0 &&
          input.changes.length <= 200,
        "操作结构无效。",
      );
      const payload = JSON.stringify(input.changes);
      const previous = this.ctx.storage.sql
        .exec<{ user_id: string; payload: string; value: string }>(
          "SELECT user_id,payload,value FROM receipts WHERE id=?",
          input.opId,
        )
        .toArray()[0];
      if (previous) {
        check(
          previous.user_id === member.user && previous.payload === payload,
          "操作编号不可复用。",
          409,
        );
        this.send(socket, JSON.parse(previous.value));
        return;
      }
      const ids = new Set<string>();
      const changes: Change[] = [];
      for (const item of input.changes) {
        check(
          item &&
            validId(item.id) &&
            !ids.has(item.id) &&
            Number.isSafeInteger(item.expectedRevision) &&
            item.expectedRevision >= 0,
          "对象版本或编号无效。",
        );
        ids.add(item.id);
        let data: CanvasData | null = null;
        if (item.data !== null) {
          check(
            item.data?.id === item.id && item.data?.boardId === member.room,
            "对象不属于此画布。",
          );
          try {
            data = sharedObject(item.data) as CanvasData;
          } catch {
            throw new HttpError(400, "画布对象结构无效。");
          }
          if (data.type === "image") {
            const asset = await this.env.DB.prepare(
              "SELECT * FROM assets WHERE room_id=? AND id=?",
            )
              .bind(member.room, data.assetId || "")
              .first<Asset>();
            check(asset, "图片尚未上传，请重试。", 409);
            data.assetMetadata = {
              id: asset.id,
              mime: asset.mime,
              byteLength: asset.byte_length,
            };
          }
        }
        changes.push({
          id: item.id,
          expectedRevision: item.expectedRevision,
          data,
        });
      }
      let result: { type: string; opId: string; rows: Row[] };
      this.ctx.storage.transactionSync(() => {
        const again = this.ctx.storage.sql
          .exec<{ user_id: string; payload: string; value: string }>(
            "SELECT user_id,payload,value FROM receipts WHERE id=?",
            input.opId,
          )
          .toArray()[0];
        if (again) {
          check(
            again.user_id === member.user && again.payload === payload,
            "操作编号不可复用。",
            409,
          );
          result = JSON.parse(again.value);
          return;
        }
        const current = new Map(this.rows().map((row) => [row.id, row]));
        for (const change of changes)
          check(
            (current.get(change.id)?.revision || 0) === change.expectedRevision,
            "版本冲突",
            409,
          );
        const nextRows = changes.map((change) => ({
          id: change.id,
          revision: change.expectedRevision + 1,
          deleted: change.data === null,
          data: change.data,
        }));
        for (const row of nextRows) current.set(row.id, row);
        this.validateTree(current, member.room);
        for (const row of nextRows) this.save(row);
        result = { type: "ack", opId: input.opId, rows: nextRows };
        this.ctx.storage.sql.exec(
          "INSERT INTO receipts(id,user_id,payload,value) VALUES(?,?,?,?)",
          input.opId,
          member.user,
          payload,
          JSON.stringify(result),
        );
      });
      this.send(socket, result!);
      await this.broadcast({ type: "changes", rows: result!.rows }, socket);
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.status === 409 &&
        error.message === "版本冲突"
      ) {
        this.send(socket, { type: "conflict", opId, rows: this.rows() });
      } else {
        this.send(socket, {
          type: "error",
          opId,
          message:
            error instanceof HttpError ? error.message : "操作未保存，请重试。",
          status: error instanceof HttpError ? error.status : 500,
        });
        if (!(error instanceof HttpError))
          console.error("Room operation failed", error);
        if (error instanceof HttpError && [401, 403].includes(error.status))
          socket.close(1008, "请刷新页面重新加入");
      }
    }
  }
  validateTree(rows: Map<string, Row>, room: string) {
    const objects = new Map(
      [...rows.values()]
        .filter((r) => !r.deleted && r.data)
        .map((r) => [r.id, r.data!]),
    );
    check(objects.size <= 2000, "单画布最多支持 2000 个对象。");
    check(
      objects.get(`${room}-root`)?.type === "collection",
      "请保留默认收纳框。",
    );
    check(
      JSON.stringify([...rows.values()]).length <= 8 * 1024 * 1024,
      "此画布已达到大小上限，请拆分画布。",
      413,
    );
    for (const object of objects.values()) {
      const seen = new Set([object.id]);
      let parent = object.parentId;
      while (parent) {
        check(!seen.has(parent), "收纳层级不能形成循环。");
        seen.add(parent);
        const container = objects.get(parent);
        check(
          container && ["frame", "collection"].includes(container.type),
          "父容器不存在，请重新操作。",
        );
        parent = container.parentId;
      }
    }
  }
  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    try {
      socket.close(code === 1005 ? 1000 : code, reason);
    } catch {}
    await this.presence();
  }
  async webSocketError(socket: WebSocket) {
    try {
      socket.close(1011, "连接异常");
    } catch {}
    await this.presence();
  }
}
