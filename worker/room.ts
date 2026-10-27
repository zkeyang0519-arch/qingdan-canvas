import { DurableObject } from "cloudflare:workers";
import type { Asset, CanvasData, Change, Commit, Env, Row } from "./types";
import { check, failure, HttpError, json, validId } from "./http";
import { membership } from "./auth";
import { sharedObject } from "../shared/canvas-contract.js";
import { taskAuthor, withTaskAuthor } from "../shared/task-authors.js";
import { recoverTaskAuthorsFromReceipts } from "./task-author-recovery.js";
import { planCanvasCommand, planRestoreBlocks } from "./canvas-commands";
import { queryCanvas } from "./canvas-queries";
import type {
  CanvasQuery,
  DeletionSnapshot,
  McpPrincipal,
} from "./mcp/contracts";
import { requireMcpGrant } from "./mcp/grants";
import { reserveMcpRequest } from "./mcp/request-binding";
import { isWriteTool } from "./mcp/canvas-rpc";
import { McpBusinessError } from "./mcp/errors";
import {
  parseToolInput,
  type ToolName,
  type WriteToolName,
} from "./mcp/schemas";
import { limitedBytes } from "./http";
import {
  initializeMcpStorage,
  recoveryLifetime,
  parseAuditInput,
  auditCursor,
  nextAuditCursor,
  type McpReceipt,
} from "./mcp/room-storage";

interface Attachment {
  user: string;
  room: string;
  name: string;
  connection: string;
  expires: number;
  session?: string;
  taskAuthors?: boolean;
  window: number;
  count: number;
}
export class CanvasRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      const hasAuthors =
        ctx.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='task_authors'",
          )
          .toArray().length > 0;
      ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_authors(note_id TEXT NOT NULL, block_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(note_id, block_id));
    `);
      // Receipts also retain tasks deleted before this feature was installed.
      // Backfill once, atomically with table creation, without inventing authors.
      if (!hasAuthors)
        ctx.storage.sql.exec(`
        INSERT OR IGNORE INTO task_authors(note_id,block_id,value)
        SELECT json_extract(history.value,'$.id'), json_extract(block.value,'$.id'),
          CASE WHEN json_type(block.value,'$.createdByUserId')='text'
            THEN json_patch('{}', json_object(
              'createdByUserId', json_extract(block.value,'$.createdByUserId'),
              'createdByName', json_extract(block.value,'$.createdByName')))
            ELSE '{}' END
        FROM (
          SELECT entry.value AS value FROM receipts, json_each(receipts.value,'$.rows') AS entry
          UNION ALL SELECT value FROM objects
        ) AS history, json_each(history.value,'$.data.blocks') AS block
        WHERE json_extract(history.value,'$.data.type')='note';
      `);
      recoverTaskAuthorsFromReceipts(ctx.storage.sql);
      initializeMcpStorage(ctx.storage.sql);
    });
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }
  rows(): Row[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM objects ORDER BY id")
      .toArray()
      .map((r) => this.withRecordedAuthors(JSON.parse(r.value) as Row));
  }
  withRecordedAuthors(row: Row): Row {
    if (row.deleted || row.data?.type !== "note") return row;
    const blocks = row.data.blocks as {
      id: string;
      createdByUserId?: string;
    }[];
    if (blocks.every((block) => block.createdByUserId)) return row;
    const known = new Map(
      this.ctx.storage.sql
        .exec<{ block_id: string; value: string }>(
          "SELECT block_id,value FROM task_authors WHERE note_id=?",
          row.id,
        )
        .toArray()
        .map((record) => [record.block_id, JSON.parse(record.value)]),
    );
    let changed = false;
    const attributed = blocks.map((block) => {
      const author = known.get(block.id);
      if (block.createdByUserId || !author?.createdByUserId) return block;
      changed = true;
      // Keep sharedObject's key order without revalidating saved content:
      // recovered metadata can take a previously valid note over the write cap.
      const { runs, remark, ...metadata } = withTaskAuthor(block, author);
      return {
        ...metadata,
        runs,
        ...(remark !== undefined ? { remark } : {}),
      };
    });
    // Author metadata is projected from its registry; content revisions and
    // immutable operation receipts remain untouched, including on replay.
    return changed
      ? {
          ...row,
          data: { ...row.data, blocks: attributed },
        }
      : row;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/internal/mcp" || path === "/internal/mcp-operations")
        return await this.internalMcp(
          request,
          path === "/internal/mcp-operations",
        );
      const room = request.headers.get("X-QD-Room")!,
        user = request.headers.get("X-QD-User")!;
      check(validId(room) && validId(user), "无效的内部路由。", 403);
      if (
        request.method === "POST" &&
        request.headers.get("X-QD-Profile-Refresh") === "1"
      ) {
        await this.presence();
        return json({ ok: true });
      }
      this.ensureRoom(room);
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
        taskAuthors: request.headers.get("X-QD-Task-Authors") === "1",
        connection: crypto.randomUUID(),
        window: Date.now(),
        count: 0,
      } satisfies Attachment);
      this.send(socket, { type: "snapshot", rows: this.rows() });
      await this.presence();
      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch (error) {
      if (error instanceof McpBusinessError)
        return json(
          {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            details: error.details,
          },
          400,
        );
      return failure(error);
    }
  }
  ensureRoom(room: string) {
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
  }
  save(row: Row) {
    this.ctx.storage.sql.exec(
      "INSERT INTO objects(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      row.id,
      JSON.stringify(row),
    );
  }
  sequence() {
    return this.ctx.storage.sql
      .exec<{ sequence: number }>(
        "SELECT sequence FROM room_metadata WHERE id=1",
      )
      .toArray()[0].sequence;
  }
  // Synchronous, called only inside storage.transactionSync. The caller owns
  // its immutable receipt; every transport shares revisions, authors and tree checks.
  commitChanges(
    changes: Change[],
    member: Pick<Attachment, "user" | "name" | "room">,
  ): Row[] {
    check(changes.length <= 200, "操作结构无效。");
    const current = new Map(this.rows().map((row) => [row.id, row]));
    const ids = new Set<string>();
    for (const change of changes) {
      check(
        validId(change.id) &&
          !ids.has(change.id) &&
          Number.isSafeInteger(change.expectedRevision) &&
          change.expectedRevision >= 0,
        "对象版本或编号无效。",
      );
      ids.add(change.id);
      check(
        (current.get(change.id)?.revision || 0) === change.expectedRevision,
        "版本冲突",
        409,
      );
      this.rememberAuthors(current.get(change.id)?.data || null);
      if (change.data) {
        check(
          change.data.id === change.id && change.data.boardId === member.room,
          "对象不属于此画布。",
        );
        try {
          change.data = sharedObject(change.data) as CanvasData;
        } catch {
          throw new HttpError(400, "画布对象结构无效。");
        }
        change.data = this.attributeAuthors(change.data, member);
      }
    }
    const nextRows = changes.map((change) => ({
      id: change.id,
      revision: change.expectedRevision + 1,
      deleted: change.data === null,
      data: change.data,
    }));
    for (const row of nextRows) current.set(row.id, row);
    this.validateTree(current, member.room);
    for (const row of nextRows) this.save(row);
    if (nextRows.length)
      this.ctx.storage.sql.exec(
        "UPDATE room_metadata SET sequence=sequence+1 WHERE id=1",
      );
    return nextRows;
  }
  async safeBroadcast(rows: Row[], except?: WebSocket) {
    if (!rows.length) return;
    try {
      await this.broadcast({ type: "changes", rows }, except);
    } catch (error) {
      console.error("Committed canvas broadcast failed", error);
    }
  }
  async internalMcp(request: Request, browser: boolean): Promise<Response> {
    check(request.method === "POST", "方法不支持。", 405);
    let input;
    try {
      input = JSON.parse(
        new TextDecoder().decode(await limitedBytes(request, 1024 * 1024)),
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new McpBusinessError(
        "VALIDATION_ERROR",
        "Invalid internal request.",
      );
    }
    check(input && validId(input.canvasId), "无效的内部路由。", 403);
    const room = input.canvasId as string;
    if (browser)
      return this.browserOperations(room, input.identity, input.input);
    check(
      typeof input.name === "string" && input.name !== "list_canvases",
      "Invalid command.",
    );
    const name = input.name as Exclude<ToolName, "list_canvases">;
    const parsed = parseToolInput(name, input.input);
    check(parsed.canvas_id === room, "Canvas mismatch.", 403);
    const principal = input.principal as McpPrincipal;
    const write = isWriteTool(name);
    // D1 binds the grant-wide key before any room can execute it. Reservation
    // may survive a crash or business failure; it is not a successful receipt.
    const binding = write
      ? await reserveMcpRequest(
          this.env,
          room,
          principal,
          name as WriteToolName,
          parsed,
        )
      : undefined;
    // Reservation/digest work is asynchronous. Recheck authorization afterwards
    // at the final pre-commit boundary, even for an identical reserved retry.
    const actor = await requireMcpGrant(this.env, principal, room, write);
    this.ensureRoom(room);
    if (!write)
      return json(
        queryCanvas(this.rows(), { name, input: parsed } as CanvasQuery, {
          canvasId: room,
          canvasName: actor.canvasName!,
          sequence: this.sequence(),
        }),
      );
    const { command, payload } = binding!;
    let value: Record<string, unknown> = {},
      rows: Row[] = [];
    this.ctx.storage.transactionSync(() => {
      const receipt = this.ctx.storage.sql
        .exec<McpReceipt>(
          "SELECT * FROM mcp_receipts WHERE grant_id=? AND request_id=?",
          principal.grantId,
          command.input.request_id,
        )
        .toArray()[0];
      if (receipt) {
        if (
          receipt.payload !== payload ||
          receipt.account_id !== actor.accountId ||
          receipt.client_id !== principal.clientId
        )
          throw new McpBusinessError(
            "IDEMPOTENCY_KEY_REUSED",
            "Request ID was already used for another command.",
          );
        value = JSON.parse(receipt.value);
        rows = JSON.parse(receipt.rows);
        return;
      }
      const now = Date.now(),
        operationId = crypto.randomUUID();
      const plan = planCanvasCommand(this.rows(), command, {
        canvasId: room,
        accountId: actor.accountId,
        accountName: actor.accountName,
        now: new Date(now).toISOString(),
        makeId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
      });
      rows = this.commitChanges(plan.changes, {
        room,
        user: actor.accountId,
        name: actor.accountName,
      });
      const expires = plan.deletionSnapshots.length
        ? now + recoveryLifetime
        : null;
      value = {
        ...plan.result,
        operation_id: operationId,
        sequence: this.sequence(),
        ...(expires
          ? { restorable_until: new Date(expires).toISOString() }
          : {}),
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO mcp_receipts(grant_id,request_id,operation_id,account_id,client_id,payload,command,created_at,value,rows,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        principal.grantId,
        command.input.request_id,
        operationId,
        actor.accountId,
        principal.clientId,
        payload,
        name,
        now,
        JSON.stringify(value),
        JSON.stringify(rows),
        expires,
      );
      for (const snapshot of plan.deletionSnapshots)
        this.ctx.storage.sql.exec(
          "INSERT INTO mcp_deleted_blocks(operation_id,task_id,snapshot,expires_at) VALUES(?,?,?,?)",
          operationId,
          snapshot.taskId,
          JSON.stringify(snapshot),
          expires!,
        );
    });
    await this.afterMcpCommit(rows);
    return json(value);
  }
  async afterMcpCommit(rows: Row[]) {
    // Neither broadcast nor housekeeping can turn durable success into failure.
    await this.safeBroadcast(rows);
    try {
      const first = this.ctx.storage.sql
        .exec<{ expires_at: number | null }>(
          "SELECT MIN(expires_at) AS expires_at FROM mcp_deleted_blocks",
        )
        .toArray()[0];
      if (first.expires_at !== null)
        await this.ctx.storage.setAlarm(first.expires_at);
    } catch (error) {
      console.error("MCP recovery alarm scheduling failed", error);
    }
  }
  auditSummary(saved: string) {
    const value = JSON.parse(saved) as Record<string, unknown>;
    return {
      canvas_id: value.canvas_id,
      note_id: value.note_id,
      revision: value.revision,
      changed: value.changed,
      task_count: Array.isArray(value.task_ids) ? value.task_ids.length : 0,
    };
  }
  async browserOperations(
    room: string,
    identity: { accountId: string; sessionHash: string },
    raw: unknown,
  ): Promise<Response> {
    check(
      identity &&
        validId(identity.accountId) &&
        typeof identity.sessionHash === "string",
      "Invalid browser identity.",
      401,
    );
    const action = parseAuditInput(raw);
    const session = await this.env.DB.prepare(
      "SELECT a.name FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.account_id=? AND s.expires_at>?",
    )
      .bind(identity.sessionHash, identity.accountId, Date.now())
      .first<{ name: string }>();
    check(session, "登录已失效，请重新登录。", 401);
    await membership(this.env, room, identity.accountId);
    if (action.action === "list") {
      const after = auditCursor(action.cursor, room, identity.accountId);
      const receipts = this.ctx.storage.sql
        .exec<McpReceipt>(
          `SELECT * FROM mcp_receipts WHERE account_id=? AND (created_at>? OR (created_at=? AND operation_id>?)) ORDER BY created_at,operation_id LIMIT ?`,
          identity.accountId,
          after.time,
          after.time,
          after.id,
          action.limit + 1,
        )
        .toArray();
      const page = receipts.slice(0, action.limit);
      return json({
        items: page.map((r) => ({
          operation_id: r.operation_id,
          tool: r.command,
          client_id: r.client_id,
          created_at: new Date(r.created_at).toISOString(),
          result: this.auditSummary(r.value),
          restorable_until: r.expires_at
            ? new Date(r.expires_at).toISOString()
            : null,
          restored:
            this.ctx.storage.sql
              .exec(
                "SELECT operation_id FROM mcp_restore_receipts WHERE operation_id=?",
                r.operation_id,
              )
              .toArray().length > 0,
        })),
        next_cursor:
          receipts.length > action.limit
            ? nextAuditCursor(room, identity.accountId, page.at(-1)!)
            : null,
      });
    }
    let value: Record<string, unknown> = {},
      rows: Row[] = [];
    this.ctx.storage.transactionSync(() => {
      const original = this.ctx.storage.sql
        .exec<McpReceipt>(
          "SELECT * FROM mcp_receipts WHERE operation_id=? AND account_id=?",
          action.operation_id,
          identity.accountId,
        )
        .toArray()[0];
      if (!original)
        throw new McpBusinessError("ACCESS_DENIED", "Operation access denied.");
      const restored = this.ctx.storage.sql
        .exec<{ account_id: string; value: string; rows: string }>(
          "SELECT account_id,value,rows FROM mcp_restore_receipts WHERE operation_id=?",
          action.operation_id,
        )
        .toArray()[0];
      if (restored) {
        value = JSON.parse(restored.value);
        rows = JSON.parse(restored.rows);
        return;
      }
      const now = Date.now();
      if (!original.expires_at || original.expires_at <= now)
        throw new McpBusinessError(
          "NOT_FOUND",
          "Recovery window has expired or this operation has no deletions.",
        );
      const snapshots = this.ctx.storage.sql
        .exec<{ snapshot: string }>(
          "SELECT snapshot FROM mcp_deleted_blocks WHERE operation_id=? AND expires_at>? ORDER BY rowid",
          action.operation_id,
          now,
        )
        .toArray()
        .map((r) => JSON.parse(r.snapshot) as DeletionSnapshot);
      if (!snapshots.length)
        throw new McpBusinessError(
          "NOT_FOUND",
          "Recovery snapshot is unavailable.",
        );
      const plan = planRestoreBlocks(this.rows(), snapshots, {
        canvasId: room,
        accountId: identity.accountId,
        accountName: session.name,
        now: new Date(now).toISOString(),
        makeId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
      });
      rows = this.commitChanges(plan.changes, {
        room,
        user: identity.accountId,
        name: session.name,
      });
      value = {
        ...plan.result,
        operation_id: action.operation_id,
        sequence: this.sequence(),
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO mcp_restore_receipts(operation_id,account_id,value,rows) VALUES(?,?,?,?)",
        action.operation_id,
        identity.accountId,
        JSON.stringify(value),
        JSON.stringify(rows),
      );
    });
    await this.afterMcpCommit(rows);
    return json(value);
  }
  async alarm() {
    this.ctx.storage.sql.exec(
      "DELETE FROM mcp_deleted_blocks WHERE expires_at<=?",
      Date.now(),
    );
    const next = this.ctx.storage.sql
      .exec<{ expires_at: number | null }>(
        "SELECT MIN(expires_at) AS expires_at FROM mcp_deleted_blocks",
      )
      .toArray()[0].expires_at;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
  rememberAuthors(data: CanvasData | null) {
    if (data?.type !== "note") return;
    for (const block of data.blocks as { id: string }[])
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO task_authors(note_id,block_id,value) VALUES(?,?,?)",
        data.id,
        block.id,
        JSON.stringify(taskAuthor(block)),
      );
  }
  attributeAuthors(
    data: CanvasData,
    member: Pick<Attachment, "user" | "name">,
  ): CanvasData {
    if (data.type !== "note") return data;
    const blocks = (data.blocks as { id: string }[]).map((block) => {
      const recorded = this.ctx.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM task_authors WHERE note_id=? AND block_id=?",
          data.id,
          block.id,
        )
        .toArray()[0];
      // An empty record marks a legacy task; never guess its author on edit/restore.
      return withTaskAuthor(
        block,
        recorded
          ? JSON.parse(recorded.value)
          : {
              createdByUserId: member.user,
              createdByName: member.name,
            },
      );
    });
    const attributed = sharedObject({ ...data, blocks }) as CanvasData;
    this.rememberAuthors(attributed);
    return attributed;
  }
  send(socket: WebSocket, value: unknown) {
    try {
      const message = value as { rows?: Row[] };
      if (
        Array.isArray(message.rows) &&
        (socket.deserializeAttachment() as Attachment).taskAuthors
      ) {
        value = {
          ...message,
          rows: message.rows.map((row) => this.withRecordedAuthors(row)),
        };
      } else if (
        Array.isArray(message.rows) &&
        !(socket.deserializeAttachment() as Attachment).taskAuthors
      ) {
        // Older bundles discard unknown block fields. Keep their wire format
        // stable so an acknowledgement cannot trigger endless compensating edits.
        value = {
          ...message,
          rows: message.rows.map((row) =>
            row.data?.type !== "note"
              ? row
              : {
                  ...row,
                  data: {
                    ...row.data,
                    blocks: (row.data.blocks as { id: string }[]).map((block) =>
                      withTaskAuthor(block, {}),
                    ),
                  },
                },
          ),
        };
      }
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
    if (!sockets.length) return;
    const room = (sockets[0].deserializeAttachment() as Attachment).room;
    const { results: profiles } = await this.env.DB.prepare(
      "SELECT a.id AS userId,a.name,a.avatar_version AS avatarVersion FROM members m JOIN accounts a ON a.id=m.user_id WHERE m.room_id=?",
    )
      .bind(room)
      .all<{ userId: string; name: string; avatarVersion: string | null }>();
    const people = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );
    const value = {
      type: "presence",
      profiles,
      members: sockets.map((socket) => {
        const attachment = socket.deserializeAttachment() as Attachment;
        return {
          id: attachment.connection,
          userId: attachment.user,
          name: attachment.name,
          ...people.get(attachment.user),
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
      const account = member.session
        ? await this.env.DB.prepare(
            "SELECT a.name FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.account_id=? AND s.expires_at>?",
          )
            .bind(member.session, member.user, Date.now())
            .first<{ name: string }>()
        : null;
      check(account, "登录已失效，请重新登录。", 401);
      member.name = account.name;
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
        const nextRows = this.commitChanges(changes, member);
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
      await this.safeBroadcast(result!.rows, socket);
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
