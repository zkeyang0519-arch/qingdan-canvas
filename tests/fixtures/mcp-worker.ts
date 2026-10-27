import app from "../../worker/index";
import { accountEndpoint } from "../../worker/accounts";
import { requireSession } from "../../worker/auth";
import * as grants from "../../worker/mcp/grants";
import {
  callCanvasMcp,
  callCanvasOperations,
} from "../../worker/mcp/canvas-rpc";
import { CanvasRoom as RealCanvasRoom } from "../../worker/room";
// Fault injection and SQL inspection live only in this isolated fixture Worker.
export class CanvasRoom extends RealCanvasRoom {
  failValidation = false;
  failBroadcast = false;
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture") {
      const input = await request.json();
      if (input.failValidation !== undefined)
        this.failValidation = input.failValidation;
      if (input.failBroadcast !== undefined)
        this.failBroadcast = input.failBroadcast;
      if (input.alarm) await this.alarm();
      return Response.json(
        input.sql
          ? this.ctx.storage.sql
              .exec(input.sql, ...(input.bindings || []))
              .toArray()
          : {},
      );
    }
    return super.fetch(request);
  }
  validateTree(rows, room) {
    super.validateTree(rows, room);
    if (this.failValidation) throw Error("Injected tree validation failure");
  }
  async broadcast(value, except) {
    if (this.failBroadcast) throw Error("Injected broadcast failure");
    return super.broadcast(value, except);
  }
}
export default {
  async fetch(request, env) {
    try {
      const p = new URL(request.url).pathname;
      if (p.startsWith("/api/")) return app.fetch(request, env, {});
      if (p === "/logout") return accountEndpoint(request, env, "logout");
      if (p === "/password") return accountEndpoint(request, env, "password");
      const input = request.method === "POST" ? await request.json() : {};
      const session = await requireSession(request, env);
      if (p === "/bind")
        return Response.json(await grants.bindMcpConsent(env, session, input));
      if (p === "/submit")
        return Response.json(
          await grants.submitMcpConsentSelection(
            env,
            session,
            input.handle,
            input.selection,
          ),
        );
      if (p === "/consent")
        return Response.json(
          await grants.createConsentSelection(env, session, input),
        );
      if (p === "/pending")
        return Response.json(
          await grants.createPendingMcpGrant(env, session, input.handle),
        );
      if (p === "/activate")
        return Response.json(
          await grants.activateMcpGrant(
            env,
            session,
            input.grantId,
            input.providerGrantId,
          ),
        );
      if (p === "/grants")
        return Response.json(await grants.listMcpGrants(env, session.id));
      if (p === "/revoke")
        return Response.json(
          await grants.revokeMcpGrant(env, session.id, input.grantId),
        );
      if (p === "/revoke-all")
        return Response.json(await grants.revokeAllMcpGrants(env, session.id));
      if (p === "/require")
        return Response.json(
          await grants.requireMcpGrant(
            env,
            input.principal,
            input.canvasId,
            input.write,
          ),
        );
      if (p === "/list")
        return Response.json(
          await grants.listMcpCanvases(env, input.principal, input.input),
        );
      if (p === "/mcp")
        return Response.json(
          await callCanvasMcp(
            env,
            input.canvasId,
            input.principal,
            input.name,
            input.input,
          ),
        );
      if (p === "/operations")
        return await callCanvasOperations(
          env,
          request,
          input.canvasId,
          input.input,
        );
      if (p === "/socket") {
        const headers = new Headers({
          Upgrade: "websocket",
          "X-QD-Room": input.canvasId || "canvas",
          "X-QD-User": session.id,
          "X-QD-Session": session.token_hash,
          "X-QD-Expires": String(session.expires_at),
          "X-QD-Name": encodeURIComponent(session.name),
          "X-QD-Task-Authors": "1",
        });
        return env.ROOMS.get(
          env.ROOMS.idFromName(input.canvasId || "canvas"),
        ).fetch("https://room/socket", { headers });
      }
      return new Response("missing", { status: 404 });
    } catch (e) {
      return Response.json(
        { code: e.code, message: e.message, details: e.details },
        { status: e.status || 400 },
      );
    }
  },
};
