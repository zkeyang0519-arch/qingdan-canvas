import type { Env } from "./types";
import { digest, lifetime, membership, requireSession, token } from "./auth";
import { body, check, json, sameOrigin, validId } from "./http";

const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validKeys = (input: Record<string, unknown>, keys: string[]) =>
  Object.keys(input).length === keys.length &&
  keys.every((key) => Object.hasOwn(input, key));

export async function desktopHandoffRoute(request: Request, env: Env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/desktop/")) return null;
  sameOrigin(request);
  check(
    url.protocol === "https:" ||
      env.APP_ENV === "local" ||
      env.APP_ENV === "test",
    "线上交接需要安全连接。",
    403,
  );
  check(
    !url.search && request.method === "POST",
    "请通过轻岛按钮发起交接。",
    405,
  );
  const now = Date.now();
  if (url.pathname === "/api/desktop/handoff") {
    const user = await requireSession(request, env);
    check(
      request.headers.get("X-QD-Account") === user.id,
      "账号已切换，请刷新网页。",
      401,
    );
    const input = await body(request, 1024);
    check(
      validKeys(input, ["roomId", "challenge"]) &&
        validId(input.roomId) &&
        hex(input.challenge),
      "桌面交接信息无效。",
    );
    await membership(env, input.roomId, user.id);
    await env.DB.prepare("DELETE FROM desktop_handoffs WHERE expires_at<=?")
      .bind(now)
      .run();
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM desktop_handoffs WHERE session_hash=?",
    )
      .bind(user.token_hash)
      .first<{ count: number }>();
    check((count?.count || 0) < 8, "启动请求较多，请稍后重试。", 429);
    const ticket = token();
    const expiresAt = Math.min(now + 90000, user.expires_at);
    const result = await env.DB.prepare(
      "INSERT INTO desktop_handoffs(token_hash,account_id,room_id,session_hash,challenge,expires_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM account_sessions WHERE token_hash=? AND account_id=? AND expires_at>?)",
    )
      .bind(
        await digest(ticket),
        user.id,
        input.roomId,
        user.token_hash,
        input.challenge,
        expiresAt,
        user.token_hash,
        user.id,
        now,
      )
      .run();
    check(result.meta.changes === 1, "登录已失效，请刷新网页。", 401);
    return json({ ticket, expiresAt }, 201);
  }
  check(
    url.pathname === "/api/desktop/handoff/redeem",
    "找不到桌面交接接口。",
    404,
  );
  // Browser JavaScript cannot remove Fetch Metadata/Origin headers. The verifier
  // is generated and retained by the native companion, never returned to a page.
  check(
    request.headers.get("X-Qingdan-Desktop") === "1" &&
      !request.headers.has("Origin") &&
      !request.headers.has("Sec-Fetch-Site"),
    "仅允许桌面程序完成登录交接。",
    403,
  );
  const input = await body(request, 1024);
  check(
    validKeys(input, ["ticket", "verifier"]) &&
      hex(input.ticket) &&
      hex(input.verifier),
    "桌面交接信息无效。",
  );
  const ticketHash = await digest(input.ticket),
    challenge = await digest(input.verifier);
  const grant = await env.DB.prepare(
    "SELECT g.account_id,g.room_id,s.expires_at FROM desktop_handoffs g JOIN account_sessions s ON s.token_hash=g.session_hash AND s.account_id=g.account_id JOIN members m ON m.room_id=g.room_id AND m.user_id=g.account_id WHERE g.token_hash=? AND g.challenge=? AND g.expires_at>? AND s.expires_at>?",
  )
    .bind(ticketHash, challenge, now, now)
    .first<{ account_id: string; room_id: string; expires_at: number }>();
  check(grant, "交接已失效，请在网页重新点击轻岛。", 410);
  const sessionToken = token(),
    expiresAt = Math.min(grant.expires_at, now + lifetime * 1000);
  // D1 batches are transactions: concurrent redemptions cannot insert two
  // sessions from one grant, and failures never consume it without an insert.
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO account_sessions(token_hash,account_id,expires_at) SELECT ?,g.account_id,MIN(s.expires_at,?) FROM desktop_handoffs g JOIN account_sessions s ON s.token_hash=g.session_hash AND s.account_id=g.account_id JOIN members m ON m.room_id=g.room_id AND m.user_id=g.account_id WHERE g.token_hash=? AND g.challenge=? AND g.expires_at>? AND s.expires_at>?",
    ).bind(
      await digest(sessionToken),
      expiresAt,
      ticketHash,
      challenge,
      now,
      now,
    ),
    env.DB.prepare(
      "DELETE FROM desktop_handoffs WHERE token_hash=? AND challenge=?",
    ).bind(ticketHash, challenge),
  ]);
  check(
    results[0].meta.changes === 1,
    "交接已使用或失效，请重新点击轻岛。",
    410,
  );
  return json({
    accountId: grant.account_id,
    roomId: grant.room_id,
    sessionToken,
    expiresAt,
  });
}
