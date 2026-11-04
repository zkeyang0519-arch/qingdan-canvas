import type { Env } from "../types";
import { body, check, json, sameOrigin, validId } from "../http";
import { digest, requireSession, token } from "../auth";
import { bindingView, type BindingRow, type DeviceRow } from "./types";
const hub = (env: Env, id: string) =>
  env.RUNNER_HUBS.get(env.RUNNER_HUBS.idFromName(id));
export async function runnerRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  if (!path.startsWith("/api/runner/") && !path.startsWith("/api/agent/"))
    return null;
  check(
    url.protocol === "https:" || url.origin === "http://127.0.0.1:8788",
    "设备连接需要 HTTPS 或指定的本机开发入口。",
    403,
  );
  check(env.RUNNER_ENABLED === "true", "设备连接尚未启用。", 404);
  const native = path.startsWith("/api/runner/");
  if (native) {
    check(
      !request.headers.has("Origin") && !request.headers.has("Sec-Fetch-Site"),
      "本机设备接口不接受浏览器请求。",
      403,
    );
    if (path === "/api/runner/connect") {
      check(
        request.method === "GET" &&
          request.headers.get("Upgrade")?.toLowerCase() === "websocket",
        "需要 WebSocket 连接。",
        426,
      );
      const bearer = request.headers
        .get("Authorization")
        ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      check(bearer, "设备凭据无效。", 401);
      const device = await env.DB.prepare(
        "SELECT d.* FROM agent_connection_tokens t JOIN agent_devices d ON d.runner_id=t.runner_id WHERE t.token_hash=? AND t.audience='runner-connect' AND t.expires_at>? AND t.auth_epoch=d.auth_epoch AND d.revoked_at IS NULL",
      )
        .bind(await digest(bearer), Date.now())
        .first<DeviceRow>();
      check(device, "设备凭据无效或已过期。", 401);
      return hub(env, device.runner_id).fetch(
        new Request("https://runner/connect", {
          headers: {
            Upgrade: "websocket",
            "X-Runner-Id": device.runner_id,
            "X-Auth-Epoch": String(device.auth_epoch),
          },
        }),
      );
    }
    check(request.method === "POST", "方法不支持。", 405);
    const input = await body(request);
    check(
      typeof input.runnerId === "string" &&
        /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(input.runnerId),
      "设备编号无效。",
    );
    if (path === "/api/runner/pair") {
      check(typeof input.pairingCode === "string", "配对码无效。");
      const code = input.pairingCode.replace(/[\s-]/g, "").toLowerCase();
      check(/^[a-f0-9]{32}$/.test(code), "配对码无效。");
      check(
        typeof input.secretHash === "string" &&
          /^[a-f0-9]{64}$/.test(input.secretHash),
        "设备密钥摘要无效。",
      );
      check(
        typeof input.deviceName === "string" &&
          input.deviceName.trim().length > 0 &&
          input.deviceName.length <= 100,
        "设备名称无效。",
      );
      check(
        !(await env.DB.prepare(
          "SELECT runner_id FROM agent_devices WHERE runner_id=?",
        )
          .bind(input.runnerId)
          .first()),
        "设备编号已使用。",
        409,
      );
      const hash = await digest(code),
        pairing = await env.DB.prepare(
          "SELECT owner_id FROM agent_pairings WHERE code_hash=?",
        )
          .bind(hash)
          .first<{ owner_id: string }>();
      check(pairing, "配对码无效或已过期。", 409);
      check(
        pairing.owner_id === input.expectedOwnerId,
        "配对账号不一致。",
        403,
      );
      // One D1 batch is one transaction. The insert only observes this request's winning consume marker.
      const marker = Date.now(),
        claim = crypto.randomUUID();
      const result = await env.DB.batch([
        env.DB.prepare(
          "UPDATE agent_pairings SET consumed_at=?,consume_id=? WHERE code_hash=? AND owner_id=? AND consumed_at IS NULL AND expires_at>?",
        ).bind(marker, claim, hash, input.expectedOwnerId, marker),
        env.DB.prepare(
          "INSERT INTO agent_devices(runner_id,owner_id,device_name,secret_hash) SELECT ?,owner_id,?,? FROM agent_pairings WHERE code_hash=? AND consume_id=?",
        ).bind(
          input.runnerId,
          input.deviceName.trim(),
          input.secretHash,
          hash,
          claim,
        ),
      ]);
      check(result[0].meta.changes === 1, "配对码已使用或过期。", 409);
      return json({
        runnerId: input.runnerId,
        ownerId: pairing.owner_id,
        authEpoch: 1,
      });
    }
    if (path === "/api/runner/token") {
      check(
        typeof input.secret === "string" &&
          input.secret.length >= 32 &&
          input.secret.length <= 256,
        "设备凭据无效。",
        401,
      );
      const device = await env.DB.prepare(
        "SELECT * FROM agent_devices WHERE runner_id=? AND secret_hash=? AND revoked_at IS NULL",
      )
        .bind(input.runnerId, await digest(input.secret))
        .first<DeviceRow>();
      check(device, "设备凭据无效。", 401);
      const opaque = token(),
        expiresAt = Date.now() + 900000;
      await env.DB.prepare(
        "INSERT INTO agent_connection_tokens(token_hash,runner_id,audience,auth_epoch,expires_at) VALUES(?,?,'runner-connect',?,?)",
      )
        .bind(
          await digest(opaque),
          device.runner_id,
          device.auth_epoch,
          expiresAt,
        )
        .run();
      return json({
        token: opaque,
        expiresAt,
        runnerId: device.runner_id,
        ownerId: device.owner_id,
        authEpoch: device.auth_epoch,
      });
    }
    check(false, "接口不存在。", 404);
  }
  sameOrigin(request);
  const user = await requireSession(request, env);
  check(
    request.headers.get("X-QD-Account") === user.id,
    "账号已切换，请重新打开。",
    401,
  );
  if (path === "/api/agent/devices/pairings") {
    check(request.method === "POST", "方法不支持。", 405);
    await body(request);
    const pairingId = crypto.randomUUID(),
      pairingCode = token().slice(0, 32),
      expiresAt = Date.now() + 600000;
    await env.DB.prepare(
      "INSERT INTO agent_pairings(pairing_id,owner_id,code_hash,expires_at) VALUES(?,?,?,?)",
    )
      .bind(pairingId, user.id, await digest(pairingCode), expiresAt)
      .run();
    return json({ pairingId, pairingCode, expiresAt });
  }
  if (path === "/api/agent/devices") {
    check(request.method === "GET", "方法不支持。", 405);
    const { results } = await env.DB.prepare(
      "SELECT * FROM agent_devices WHERE owner_id=?",
    )
      .bind(user.id)
      .all<DeviceRow>();
    return json({
      enabled: true,
      devices: results.map((d) => ({
        runnerId: d.runner_id,
        ownerId: d.owner_id,
        deviceName: d.device_name,
        status: d.revoked_at
          ? "revoked"
          : d.last_seen_at && Date.now() - d.last_seen_at < 45000
            ? "online"
            : "offline",
        lastSeenAt: d.last_seen_at
          ? new Date(d.last_seen_at).toISOString()
          : null,
        connectionEpoch: d.connection_epoch,
        authEpoch: d.auth_epoch,
        workspaces: JSON.parse(d.workspaces_json),
      })),
    });
  }
  const revoke = path.match(/^\/api\/agent\/devices\/([^/]+)\/revoke$/);
  if (revoke) {
    check(request.method === "POST", "方法不支持。", 405);
    await body(request);
    const d = await env.DB.prepare(
      "SELECT * FROM agent_devices WHERE runner_id=? AND owner_id=?",
    )
      .bind(revoke[1], user.id)
      .first<DeviceRow>();
    check(d, "设备不存在。", 404);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE agent_devices SET revoked_at=?,auth_epoch=auth_epoch+1,last_seen_at=NULL WHERE runner_id=?",
      ).bind(Date.now(), d.runner_id),
      env.DB.prepare(
        "DELETE FROM agent_connection_tokens WHERE runner_id=?",
      ).bind(d.runner_id),
      env.DB.prepare(
        "UPDATE agent_bindings SET enabled=0,revision=revision+1 WHERE runner_id=?",
      ).bind(d.runner_id),
    ]);
    await hub(env, d.runner_id).fetch("https://runner/revoke", {
      method: "POST",
    });
    return json({ ok: true });
  }
  if (path === "/api/agent/bindings") {
    const input =
      request.method === "GET"
        ? Object.fromEntries(url.searchParams)
        : await body(request);
    check(
      validId(input.canvasId) && validId(input.sectionId),
      "画布或清单编号无效。",
    );
    const room = await env.DB.prepare("SELECT owner_id FROM rooms WHERE id=?")
      .bind(input.canvasId)
      .first<{ owner_id: string }>();
    check(room?.owner_id === user.id, "只有画布所有者可以绑定设备。", 403);
    const previous = await env.DB.prepare(
      "SELECT * FROM agent_bindings WHERE canvas_id=? AND section_id=?",
    )
      .bind(input.canvasId, input.sectionId)
      .first<BindingRow>();
    if (request.method === "GET")
      return json({ binding: previous ? bindingView(previous) : null });
    check(request.method === "POST", "方法不支持。", 405);
    check(
      validId(input.runnerId) && validId(input.workspaceId),
      "设备或项目无效。",
    );
    check(
      input.expectedRevision === (previous?.revision ?? null),
      "绑定已更改，请刷新。",
      409,
    );
    // Lease occupancy is checked at the old hub too when switching devices.
    if (
      previous &&
      (previous.runner_id !== input.runnerId ||
        previous.workspace_id !== input.workspaceId)
    ) {
      const occupied = await hub(env, previous.runner_id).fetch(
        "https://runner/occupied?workspaceId=" +
          encodeURIComponent(previous.workspace_id),
      );
      check(occupied.status === 200, "旧项目仍有未确认停止的运行。", 409);
    }
    return hub(env, input.runnerId).fetch("https://runner/binding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, ownerId: user.id }),
    });
  }
  check(false, "接口不存在。", 404);
  return null;
}
