import type { Env } from "./types";
import { body, check, HttpError, json } from "./http";
import {
  digest,
  getSession,
  legacySession,
  lifetime,
  publicUser,
  requireSession,
  sessionCookie,
  token,
} from "./auth";
import { hashPassword, verifyPassword } from "./passwords.js";

interface Account {
  id: string;
  username: string;
  name: string;
  password_hash: string;
}

function password(value: unknown): asserts value is string {
  check(
    typeof value === "string" && value.length >= 12 && value.length <= 128,
    "密码需要 12–128 个字符。",
  );
}
async function limit(env: Env, key: string, max: number, duration: number) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO auth_limits(key,attempts,reset_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,
    reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING attempts`,
  )
    .bind(await digest(key), now + duration, now, now)
    .first<{ attempts: number }>();
  check(row && row.attempts <= max, "尝试次数过多，请稍后再试。", 429);
}

export async function accountEndpoint(
  request: Request,
  env: Env,
  action: string,
) {
  check(request.method === "POST", "方法不支持。", 405);
  if (action === "logout") {
    const session = await getSession(request, env);
    check(
      !session ||
        !request.headers.get("X-QD-Account") ||
        request.headers.get("X-QD-Account") === session.id,
      "账号已切换，请刷新页面。",
      401,
    );
    if (session)
      await env.DB.prepare("DELETE FROM account_sessions WHERE token_hash=?")
        .bind(session.token_hash)
        .run();
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie(request, "", 0),
    });
  }
  check(
    ["register", "login", "password"].includes(action),
    "接口不存在。",
    404,
  );
  const input = await body(request);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  await limit(env, `auth:ip:${ip}`, 60, 15 * 60 * 1000);
  const raw = token(),
    expires = Date.now() + lifetime * 1000;
  const hash = await digest(raw);
  let account: Account;
  const statements: D1PreparedStatement[] = [];
  if (action === "password") {
    const session = await requireSession(request, env);
    check(
      !request.headers.get("X-QD-Account") ||
        request.headers.get("X-QD-Account") === session.id,
      "账号已切换，请刷新页面。",
      401,
    );
    await limit(env, `auth:user:${session.username}`, 10, 15 * 60 * 1000);
    password(input.password);
    check(
      typeof input.currentPassword === "string" &&
        input.currentPassword.length <= 128,
      "当前密码不正确。",
      401,
    );
    const found = await env.DB.prepare("SELECT * FROM accounts WHERE id=?")
      .bind(session.id)
      .first<Account>();
    check(
      found &&
        (await verifyPassword(input.currentPassword, found.password_hash)),
      "当前密码不正确。",
      401,
    );
    account = found;
    // A simultaneous password change must not overwrite a newer credential.
    const nextHash = await hashPassword(input.password);
    statements.push(
      env.DB.prepare(
        "UPDATE accounts SET password_hash=? WHERE id=? AND password_hash=?",
      ).bind(nextHash, account.id, account.password_hash),
    );
    statements.push(
      env.DB.prepare(
        "DELETE FROM account_sessions WHERE account_id=? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND password_hash=?)",
      ).bind(account.id, account.id, nextHash),
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO account_sessions(token_hash,account_id,expires_at) SELECT ?,id,? FROM accounts WHERE id=? AND password_hash=?",
      ).bind(hash, expires, account.id, nextHash),
    );
    const result = await env.DB.batch(statements);
    check(
      result[0].meta.changes === 1,
      "密码已经更新，请重新登录后再试。",
      409,
    );
    return json({ user: publicUser(account) }, 200, {
      "Set-Cookie": sessionCookie(request, raw),
    });
  }
  check(!(await getSession(request, env)), "请先退出当前账号。", 409);
  check(typeof input.username === "string", "请输入用户名。");
  const username = input.username.trim().toLowerCase();
  check(
    /^[a-z0-9_-]{3,32}$/.test(username),
    "用户名需为 3–32 位英文字母、数字、下划线或短横线。",
  );
  password(input.password);
  await limit(env, `auth:user:${username}`, 10, 15 * 60 * 1000);
  const legacy = await legacySession(request, env);
  check(
    !legacy?.room_count || input.claimLegacy === true,
    "请勾选将本浏览器原有画布归入账号，以保留已有内容。",
  );
  const found = await env.DB.prepare("SELECT * FROM accounts WHERE username=?")
    .bind(username)
    .first<Account>();
  if (action === "register") {
    await limit(env, `register:${ip}`, 10, 60 * 60 * 1000);
    check(!found, "这个用户名已被使用，请换一个。", 409);
    const name =
      typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : username;
    check(name.length <= 32, "昵称最多 32 个字。");
    account = {
      id: legacy?.id || crypto.randomUUID(),
      username,
      name,
      password_hash: await hashPassword(input.password),
    };
    statements.push(
      env.DB.prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES(?,?,?,?,?)",
      ).bind(
        account.id,
        username,
        name,
        account.password_hash,
        new Date().toISOString(),
      ),
    );
  } else {
    const valid = await verifyPassword(input.password, found?.password_hash);
    check(found && valid, "用户名或密码不正确。", 401);
    account = found;
  }
  if (legacy) {
    // The primary key arbitrates simultaneous attempts to claim the same browser identity.
    statements.push(
      env.DB.prepare(
        "INSERT INTO legacy_claims(legacy_id,account_id) VALUES(?,?)",
      ).bind(legacy.id, account.id),
    );
    if (legacy.id !== account.id) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO members(room_id,user_id,role,joined_at)
        SELECT room_id,?,role,joined_at FROM members WHERE user_id=?
        ON CONFLICT(room_id,user_id) DO UPDATE SET role=CASE WHEN members.role='owner' OR excluded.role='owner' THEN 'owner' ELSE 'editor' END`,
        ).bind(account.id, legacy.id),
      );
      statements.push(
        env.DB.prepare("UPDATE rooms SET owner_id=? WHERE owner_id=?").bind(
          account.id,
          legacy.id,
        ),
      );
      statements.push(
        env.DB.prepare("DELETE FROM members WHERE user_id=?").bind(legacy.id),
      );
    }
    statements.push(
      env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(legacy.id),
    );
  }
  // Bind session creation to the credential just verified (a concurrent password reset wins).
  statements.push(
    env.DB.prepare(
      "INSERT INTO account_sessions(token_hash,account_id,expires_at) SELECT ?,id,? FROM accounts WHERE id=? AND password_hash=?",
    ).bind(hash, expires, account.id, account.password_hash),
  );
  statements.push(
    env.DB.prepare("DELETE FROM account_sessions WHERE expires_at<=?").bind(
      Date.now(),
    ),
  );
  statements.push(
    env.DB.prepare("DELETE FROM auth_limits WHERE reset_at<=?").bind(
      Date.now(),
    ),
  );
  try {
    const results = await env.DB.batch(statements);
    check(
      results[results.length - 3].meta.changes === 1,
      "账号信息已更新，请重新登录。",
      409,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/.test(error.message)
    )
      throw new HttpError(409, "账号或旧画布已被注册，请刷新后登录。");
    throw error;
  }
  return json(
    { user: publicUser(account), migrated: !!legacy },
    action === "register" ? 201 : 200,
    { "Set-Cookie": sessionCookie(request, raw) },
  );
}
