import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { ExecutionDispatch } from "./dispatch";
import { scheduleExecutionAlarm } from "./checklist-writeback";
import { body, check, failure, HttpError, json, validId } from "../http";
import { digest } from "../auth";
import { parseRunnerEvent } from "../../shared/agent/schemas";
import {
  bindingView,
  type BindingRow,
  type DeviceRow,
  type WorkspaceView,
} from "./types";
interface Attachment {
  runnerId: string;
  connectionEpoch: number;
  authEpoch: number;
}
interface Lease {
  workspaceId: string;
  runId: string;
  leaseEpoch: number;
  expiresAt: number;
}
interface HubState {
  runnerId: string;
  connectionEpoch: number;
  lastHeartbeat: number;
  leases: Record<string, Lease>;
  leaseCounter: number;
}
const canonical = (v: unknown): string =>
  JSON.stringify(
    v && typeof v === "object"
      ? Array.isArray(v)
        ? v.map((x) => JSON.parse(canonical(x)))
        : Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, JSON.parse(canonical(x))]),
          )
      : v,
  );
export class RunnerHub extends DurableObject<Env> {
  private async state() {
    const state = await this.ctx.storage.get<HubState>("state");
    if (state) {
      const { results } = await this.env.DB.prepare(
        "SELECT workspace_id,run_id,lease_epoch,expires_at FROM agent_workspace_leases WHERE runner_id=?",
      )
        .bind(state.runnerId)
        .all<{
          workspace_id: string;
          run_id: string;
          lease_epoch: number;
          expires_at: number;
        }>();
      state.leases = Object.fromEntries(
        results.map((l) => [
          l.workspace_id,
          {
            workspaceId: l.workspace_id,
            runId: l.run_id,
            leaseEpoch: l.lease_epoch,
            expiresAt: l.expires_at,
          },
        ]),
      );
    }
    return state;
  }
  private device(id: string) {
    return this.env.DB.prepare("SELECT * FROM agent_devices WHERE runner_id=?")
      .bind(id)
      .first<DeviceRow>();
  }
  private send(
    ws: WebSocket,
    type: string,
    data: Record<string, unknown> = {},
  ) {
    ws.send(JSON.stringify({ protocolVersion: 1, type, ...data }));
  }
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (new URL(request.url).pathname.startsWith("/execution/")) {
          check(
            this.env.EXECUTION_ENABLED === "true",
            "执行服务尚未启用。",
            404,
          );
          return await new ExecutionDispatch(this.ctx.storage, this.env).fetch(
            request,
          );
        }
        const url = new URL(request.url),
          state = await this.state();
        if (url.pathname === "/revoke") {
          for (const socket of this.ctx.getWebSockets()) {
            this.send(socket, "revoked", { reason: "设备授权已撤销。" });
            socket.close(4003, "revoked");
          }
          if (state) {
            state.lastHeartbeat = 0;
            await this.ctx.storage.put("state", state);
          }
          return json({ ok: true });
        }
        if (url.pathname === "/occupied") {
          const workspaceId = url.searchParams.get("workspaceId") || "";
          const busy = state?.leases[workspaceId] || await this.ctx.storage.get("exec:queue-workspace:" + workspaceId);
          return json(
            { ok: !busy }, busy ? 409 : 200,
          );
        }
        if (url.pathname === "/binding") {
          const input = await body(request);
          check(
            validId(input.runnerId) && validId(input.workspaceId),
            "项目无效。",
          );
          const device = await this.device(input.runnerId);
          check(
            device && device.owner_id === input.ownerId && !device.revoked_at,
            "设备不存在或已撤销。",
            403,
          );
          const workspaces = JSON.parse(
            device.workspaces_json,
          ) as WorkspaceView[];
          check(
            workspaces.some((w) => w.workspaceId === input.workspaceId),
            "项目未授权。",
            409,
          );
          check(
            !state?.leases[input.workspaceId] && !await this.ctx.storage.get("exec:queue-workspace:" + input.workspaceId),
            "项目仍有未确认停止的运行。",
            409,
          );
          const old = await this.env.DB.prepare(
            "SELECT * FROM agent_bindings WHERE canvas_id=? AND section_id=?",
          )
            .bind(input.canvasId, input.sectionId)
            .first<BindingRow>();
          if (old?.runner_id === input.runnerId)
            check(!await this.ctx.storage.get("exec:queue-workspace:" + old.workspace_id), "原项目仍有未完成的批次。", 409);
          check(
            input.expectedRevision === (old?.revision ?? null),
            "绑定已更改，请刷新。",
            409,
          );
          const id = old?.binding_id || crypto.randomUUID();
          // CAS is required even across different runner hubs racing for one section.
          const result = old
            ? await this.env.DB.prepare(
                "UPDATE agent_bindings SET runner_id=?,workspace_id=?,revision=revision+1,enabled=1 WHERE binding_id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM agent_workspace_leases l WHERE (l.runner_id=agent_bindings.runner_id AND l.workspace_id=agent_bindings.workspace_id) OR (l.runner_id=? AND l.workspace_id=?)) AND EXISTS(SELECT 1 FROM agent_devices WHERE runner_id=? AND owner_id=? AND revoked_at IS NULL)",
              )
                .bind(
                  input.runnerId,
                  input.workspaceId,
                  id,
                  input.expectedRevision,
                  input.runnerId,
                  input.workspaceId,
                  input.runnerId,
                  input.ownerId,
                )
                .run()
            : await this.env.DB.prepare(
                "INSERT OR IGNORE INTO agent_bindings(binding_id,owner_id,canvas_id,section_id,runner_id,workspace_id,revision,enabled) SELECT ?,?,?,?,?,?,1,1 WHERE NOT EXISTS(SELECT 1 FROM agent_workspace_leases WHERE runner_id=? AND workspace_id=?) AND EXISTS(SELECT 1 FROM agent_devices WHERE runner_id=? AND owner_id=? AND revoked_at IS NULL)",
              )
                .bind(
                  id,
                  input.ownerId,
                  input.canvasId,
                  input.sectionId,
                  input.runnerId,
                  input.workspaceId,
                  input.runnerId,
                  input.workspaceId,
                  input.runnerId,
                  input.ownerId,
                )
                .run();
          check(result.meta.changes === 1, "绑定已更改，请刷新。", 409);
          const saved = await this.env.DB.prepare(
            "SELECT * FROM agent_bindings WHERE binding_id=?",
          )
            .bind(id)
            .first<BindingRow>();
          return json({ binding: bindingView(saved!) });
        }
        check(url.pathname === "/connect", "接口不存在。", 404);
        const runnerId = request.headers.get("X-Runner-Id") || "",
          authEpoch = Number(request.headers.get("X-Auth-Epoch"));
        const device = await this.device(runnerId);
        check(
          device && !device.revoked_at && device.auth_epoch === authEpoch,
          "设备授权已失效。",
          401,
        );
        const current: HubState = state || {
          runnerId,
          connectionEpoch: 0,
          lastHeartbeat: 0,
          leases: {},
          leaseCounter: 0,
        };
        current.connectionEpoch++;
        current.lastHeartbeat = Date.now();
        await this.ctx.storage.put("state", current);
        for (const old of this.ctx.getWebSockets()) old.close(4001, "replaced");
        const pair = new WebSocketPair(),
          client = pair[0],
          server = pair[1];
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({
          runnerId,
          connectionEpoch: current.connectionEpoch,
          authEpoch,
        } satisfies Attachment);
        await this.env.DB.prepare(
          "UPDATE agent_devices SET connection_epoch=?,last_seen_at=? WHERE runner_id=?",
        )
          .bind(current.connectionEpoch, current.lastHeartbeat, runnerId)
          .run();
        await scheduleExecutionAlarm(this.ctx.storage);
        this.send(server, "welcome", {
          runnerId,
          connectionEpoch: current.connectionEpoch,
          authEpoch,
          heartbeatMs: 15000,
          leaseMs: 60000,
          serverTime: Date.now(),
        });
        // Pending command delivery is durable groundwork only. No HTTP route can enqueue commands.
        const pending = await this.ctx.storage.list<{
          envelope: Record<string, unknown>;
        }>({ prefix: "command:" });
        for (const command of pending.values())
          this.send(server, "command", {
            connectionEpoch: current.connectionEpoch,
            envelope: command.envelope,
          });
        return new Response(null, { status: 101, webSocket: client });
      } catch (error) {
        return failure(error);
      }
    });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await this.ctx.blockConcurrencyWhile(async () => {
      let packet: Record<string, any> = {};
      try {
        check(
          typeof message === "string" && message.length <= 65536,
          "消息过大或无效。",
        );
        const parsed = JSON.parse(message);
        check(
          parsed && typeof parsed === "object" && !Array.isArray(parsed),
          "消息格式无效。",
        );
        packet = parsed;
        const attachment = ws.deserializeAttachment() as Attachment,
          state = await this.state();
        check(
          state &&
            packet.protocolVersion === 1 &&
            packet.connectionEpoch === state.connectionEpoch &&
            attachment.connectionEpoch === state.connectionEpoch,
          "连接已过期。",
          409,
        );
        const device = await this.device(attachment.runnerId);
        check(
          device &&
            !device.revoked_at &&
            device.auth_epoch === attachment.authEpoch,
          "设备授权已撤销。",
          401,
        );
        const epoch = state.connectionEpoch;
        if (packet.type === "heartbeat") {
          const renewed: Lease[] = [];
          check(
            !packet.leases ||
              (Array.isArray(packet.leases) && packet.leases.length <= 100),
            "租约列表无效。",
          );
          for (const input of packet.leases || []) {
            const lease = state.leases[input.workspaceId];
            check(
              lease &&
                lease.runId === input.runId &&
                lease.leaseEpoch === input.leaseEpoch &&
                lease.expiresAt > Date.now(),
              "租约已过期或不匹配。",
              409,
            );
            lease.expiresAt = Date.now() + 60000;
            renewed.push(lease);
          }
          if (renewed.length)
            await this.env.DB.batch(
              renewed.map((l) =>
                this.env.DB.prepare(
                  "UPDATE agent_workspace_leases SET expires_at=? WHERE runner_id=? AND workspace_id=? AND lease_epoch=?",
                ).bind(
                  l.expiresAt,
                  state.runnerId,
                  l.workspaceId,
                  l.leaseEpoch,
                ),
              ),
            );
          state.lastHeartbeat = Date.now();
          await this.ctx.storage.put("state", state);
          await this.env.DB.prepare(
            "UPDATE agent_devices SET last_seen_at=? WHERE runner_id=?",
          )
            .bind(state.lastHeartbeat, state.runnerId)
            .run();
          await scheduleExecutionAlarm(this.ctx.storage);
          this.send(ws, "heartbeat_ack", {
            connectionEpoch: epoch,
            serverTime: Date.now(),
            leases: renewed,
          });
          return;
        }
        if (packet.type === "register_workspaces") {
          const workspaces = validateWorkspaces(packet.workspaces),
            ids = new Set(workspaces.map((w) => w.workspaceId));
          check(
            Object.keys(state.leases).every((id) => ids.has(id)),
            "运行尚未确认停止，不能移除项目。",
            409,
          );
          const old = JSON.parse(device.workspaces_json) as WorkspaceView[];
          for (const previous of old) {
            const next = workspaces.find(w => w.workspaceId === previous.workspaceId);
            if (!next || canonical(next) !== canonical(previous))
              check(!await this.ctx.storage.get("exec:queue-workspace:" + previous.workspaceId), "批次未完成，不能更改项目注册信息。", 409);
          }
          for (const item of workspaces) {
            const previous = old.find(
              (w) => w.workspaceId === item.workspaceId,
            );
            check(
              !previous || item.revision >= previous.revision,
              "项目版本已过期。",
              409,
            );
            check(
              !previous ||
                item.revision !== previous.revision ||
                canonical(item) === canonical(previous),
              "项目版本内容冲突。",
              409,
            );
          }
          const removed = old.filter((w) => !ids.has(w.workspaceId));
          await this.env.DB.batch([
            this.env.DB.prepare(
              "UPDATE agent_devices SET workspaces_json=? WHERE runner_id=? AND revoked_at IS NULL",
            ).bind(JSON.stringify(workspaces), state.runnerId),
            ...removed.map((w) =>
              this.env.DB.prepare(
                "UPDATE agent_bindings SET enabled=0,revision=revision+1 WHERE runner_id=? AND workspace_id=? AND enabled=1",
              ).bind(state.runnerId, w.workspaceId),
            ),
          ]);
          this.send(ws, "workspaces_ack", {
            connectionEpoch: epoch,
            requestId: packet.requestId,
          });
          return;
        }
        if (packet.type === "event") {
          packet.event = parseRunnerEvent(packet.event);
          check(
            packet.event.runnerId === state.runnerId,
            "事件设备不匹配。",
            403,
          );
          const key = "event:" + packet.event.eventId,
            hash = await digest(canonical(packet.event)),
            old = await this.ctx.storage.get<{ hash: string }>(key);
          if (old && old.hash !== hash) {
            this.send(ws, "error", {
              code: "EVENT_CONFLICT",
              message: "事件编号内容冲突。",
            });
            return;
          }
          if (!old)
            await this.ctx.storage.put(key, {
              hash,
              event: packet.event,
              receivedAt: Date.now(),
            });
          this.send(ws, "event_ack", {
            connectionEpoch: epoch,
            eventId: packet.event.eventId,
          });
          return;
        }
        if (packet.type === "lease_claim") {
          check(
            validId(packet.workspaceId) && validId(packet.runId),
            "租约无效。",
          );
          check(
            (JSON.parse(device.workspaces_json) as WorkspaceView[]).some(
              (w) => w.workspaceId === packet.workspaceId,
            ),
            "项目未授权。",
            403,
          );
          let lease = state.leases[packet.workspaceId];
          check(
            !lease || lease.runId === packet.runId,
            "项目已有未确认停止的运行。",
            409,
          );
          if (!lease) {
            lease = {
              workspaceId: packet.workspaceId,
              runId: packet.runId,
              leaseEpoch: ++state.leaseCounter,
              expiresAt: Date.now() + 60000,
            };
            state.leases[packet.workspaceId] = lease;
            await this.ctx.storage.put("state", state);
            await this.env.DB.prepare(
              "INSERT INTO agent_workspace_leases(runner_id,workspace_id,run_id,lease_epoch,expires_at) VALUES(?,?,?,?,?)",
            )
              .bind(
                state.runnerId,
                lease.workspaceId,
                lease.runId,
                lease.leaseEpoch,
                lease.expiresAt,
              )
              .run();
          }
          this.send(ws, "lease_granted", {
            connectionEpoch: epoch,
            requestId: packet.requestId,
            ...lease,
            serverTime: Date.now(),
          });
          return;
        }
        if (packet.type === "lease_release") {
          const { workspaceId, runId, leaseEpoch, confirmedStopped } = packet;
          check(
            confirmedStopped === true &&
              validId(workspaceId) &&
              validId(runId) &&
              Number.isSafeInteger(leaseEpoch) &&
              leaseEpoch >= 1,
            "必须确认旧运行已停止。",
            409,
          );
          const lease = state.leases[workspaceId];
          const key = `lease-release:${workspaceId}:${runId}:${leaseEpoch}`;
          if (lease?.runId === runId && lease.leaseEpoch === leaseEpoch) {
            // Persist confirmation first so a committed delete can always be acknowledged again.
            // A retry still deletes the exact D1 lease if the previous attempt stopped before deletion.
            await this.ctx.storage.put(key, true);
            await this.env.DB.prepare(
              "DELETE FROM agent_workspace_leases WHERE runner_id=? AND workspace_id=? AND run_id=? AND lease_epoch=?",
            )
              .bind(state.runnerId, workspaceId, runId, leaseEpoch)
              .run();
          } else {
            check(
              await this.ctx.storage.get<boolean>(key),
              "必须确认旧运行已停止。",
              409,
            );
          }
          this.send(ws, "lease_released", {
            connectionEpoch: epoch,
            requestId: packet.requestId,
          });
          return;
        }
        if (packet.type === "command_ack") {
          check(
            validId(packet.commandId) &&
              ["stored", "rejected"].includes(packet.receipt?.status),
            "命令回执无效。",
          );
          const key = "command:" + packet.commandId,
            pending = await this.ctx.storage.get(key);
          check(pending, "命令不存在。", 409);
          await this.ctx.storage.put(
            "command-receipt:" + packet.commandId,
            packet.receipt,
          );
          await this.ctx.storage.delete(key);
          return;
        }
        check(false, "消息类型无效。");
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          this.send(ws, "revoked", { reason: "设备授权已撤销。" });
          ws.close(4003, "revoked");
          return;
        }
        const message = error instanceof Error ? error.message : "消息无效。";
        const stale = message === "连接已过期。";
        this.send(ws, "error", {
          code: stale ? "STALE_CONNECTION" : "INVALID_MESSAGE",
          message,
          ...(packet.requestId ? { requestId: packet.requestId } : {}),
        });
      }
    });
  }
  async webSocketClose(ws: WebSocket) {
    await this.ctx.blockConcurrencyWhile(() => this.markOffline(ws));
  }
  async webSocketError(ws: WebSocket) {
    await this.ctx.blockConcurrencyWhile(() => this.markOffline(ws));
  }
  private async markOffline(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment,
      state = await this.state();
    if (state && a?.connectionEpoch === state.connectionEpoch) {
      state.lastHeartbeat = 0;
      await this.ctx.storage.put("state", state);
      await this.env.DB.prepare(
        "UPDATE agent_devices SET last_seen_at=NULL WHERE runner_id=? AND connection_epoch=?",
      )
        .bind(state.runnerId, state.connectionEpoch)
        .run();
    }
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      await new ExecutionDispatch(this.ctx.storage, this.env).retryWritebacks();
      const state = await this.state();
      if (!state) return;
      if (Date.now() - state.lastHeartbeat >= 45000) {
        for (const ws of this.ctx.getWebSockets())
          ws.close(4000, "heartbeat timeout");
        state.lastHeartbeat = 0;
        await this.ctx.storage.put("state", state);
        await this.env.DB.prepare(
          "UPDATE agent_devices SET last_seen_at=NULL WHERE runner_id=?",
        )
          .bind(state.runnerId)
          .run();
      }
      await scheduleExecutionAlarm(this.ctx.storage);
    });
  }
}
function validateWorkspaces(input: unknown): WorkspaceView[] {
  check(Array.isArray(input) && input.length <= 100, "项目列表无效。");
  const seen = new Set<string>();
  return input.map((w: WorkspaceView) => {
    check(
      w &&
        Object.keys(w).every((k) =>
          ["workspaceId", "name", "displayPath", "revision", "checks"].includes(
            k,
          ),
        ) &&
        validId(w.workspaceId) &&
        !seen.has(w.workspaceId),
      "项目编号无效。",
    );
    seen.add(w.workspaceId);
    check(
      typeof w.name === "string" &&
        w.name.length > 0 &&
        w.name.length <= 100 &&
        typeof w.displayPath === "string" &&
        w.displayPath.length <= 1024 &&
        Number.isSafeInteger(w.revision) &&
        w.revision >= 1,
      "项目元数据无效。",
    );
    check(
      Array.isArray(w.checks) &&
        w.checks.length <= 50 &&
        w.checks.every(
          (c) =>
            c &&
            Object.keys(c).every((k) => ["checkId", "label"].includes(k)) &&
            validId(c.checkId) &&
            typeof c.label === "string" &&
            c.label.length <= 100,
        ),
      "检查项元数据无效。",
    );
    return w;
  });
}
