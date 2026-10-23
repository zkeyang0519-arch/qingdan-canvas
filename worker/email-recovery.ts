import type { Env, Session } from "./types";
import { body, check, HttpError, json } from "./http";
import { limit } from "./accounts";
import { token } from "./auth";
import { hashPassword, verifyPassword } from "./passwords.js";
import {
  emailAvailable,
  requireEmail,
  sendVerificationEmail,
} from "./email-sender";

const expiry = 10 * 60 * 1000;
const invalidCode = "验证码无效或已过期，请重新获取。";
type Purpose = "bind" | "reset";
interface Account {
  id: string;
  username: string;
  password_hash: string;
  email: string | null;
  email_verified_at: number | null;
}
interface Challenge {
  id: string;
  account_id: string;
  purpose: Purpose;
  email: string;
  code_hash: string;
}

function emailAddress(value: unknown) {
  check(
    typeof value === "string" && value.length <= 254,
    "请输入有效邮箱地址。",
  );
  const email = value.trim().toLowerCase();
  check(
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(
      email,
    ),
    "请输入有效邮箱地址。",
  );
  return email;
}

function usernameValue(value: unknown) {
  check(typeof value === "string", "请输入用户名。");
  const username = value.trim().toLowerCase();
  check(/^[a-z0-9_-]{3,32}$/.test(username), "请输入正确的用户名。");
  return username;
}

async function hashCode(
  env: Env,
  challenge: Omit<Challenge, "code_hash">,
  code: string,
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.EMAIL_CODE_SECRET!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const value = JSON.stringify([
    challenge.id,
    challenge.account_id,
    challenge.purpose,
    challenge.email,
    code,
  ]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeCode() {
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= 4294000000);
  return String(value[0] % 1000000).padStart(6, "0");
}

async function sendLimit(
  request: Request,
  env: Env,
  identity: string,
  email: string,
) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  await limit(env, `email:ip:${ip}`, 20, 15 * 60 * 1000);
  await limit(env, `email:identity:${identity}`, 5, 60 * 60 * 1000);
  await limit(env, `email:recipient:${email}`, 5, 60 * 60 * 1000);
  await limit(env, `email:cooldown:${identity}`, 1, 60000);
  await limit(env, `email:recipient-cooldown:${email}`, 1, 60000);
}

async function issueChallenge(
  env: Env,
  account: Account,
  email: string,
  purpose: Purpose,
  id: string,
) {
  const code = makeCode();
  const challenge = { id, account_id: account.id, purpose, email };
  const hash = await hashCode(env, challenge, code);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM email_challenges WHERE expires_at<=? OR (account_id=? AND purpose=?)",
    ).bind(Date.now(), account.id, purpose),
    env.DB.prepare(
      "INSERT INTO email_challenges(id,account_id,purpose,email,code_hash,credential_hash,prior_email,expires_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      account.id,
      purpose,
      email,
      hash,
      account.password_hash,
      account.email,
      Date.now() + expiry,
    ),
  ]);
  try {
    await sendVerificationEmail(env, email, code, purpose, id);
  } catch (error) {
    await env.DB.prepare("DELETE FROM email_challenges WHERE id=?")
      .bind(id)
      .run();
    throw error;
  }
}

async function verifiedChallenge(
  env: Env,
  input: Record<string, unknown>,
  accountId: string,
  email: string,
  purpose: Purpose,
) {
  check(
    typeof input.challengeId === "string" &&
      /^[a-f0-9]{64}$/.test(input.challengeId),
    invalidCode,
  );
  check(
    typeof input.code === "string" && /^\d{6}$/.test(input.code),
    invalidCode,
  );
  // Count guesses atomically, before checking the code. Another request cannot
  // reset the attempt counter or race two guesses through the last allowance.
  const challenge = await env.DB.prepare(
    `UPDATE email_challenges SET attempts=attempts+1
    WHERE id=? AND account_id=? AND email=? AND purpose=? AND consumed_by IS NULL
      AND expires_at>? AND attempts<5 RETURNING id,account_id,purpose,email,code_hash`,
  )
    .bind(input.challengeId, accountId, email, purpose, Date.now())
    .first<Challenge>();
  check(challenge, invalidCode);
  check(
    (await hashCode(env, challenge, input.code)) === challenge.code_hash,
    invalidCode,
  );
  return challenge;
}

function claimStatement(env: Env, id: string, claim: string) {
  return env.DB.prepare(
    `UPDATE email_challenges SET consumed_by=? WHERE id=?
    AND consumed_by IS NULL AND attempts<=5 AND expires_at>?
    AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=email_challenges.account_id
      AND a.password_hash=email_challenges.credential_hash AND a.email IS email_challenges.prior_email)`,
  ).bind(claim, id, Date.now());
}

function invalidateOtherChallenges(
  env: Env,
  accountId: string,
  id: string,
  claim: string,
) {
  return env.DB.prepare(
    `DELETE FROM email_challenges WHERE account_id=? AND id<>?
    AND EXISTS(SELECT 1 FROM email_challenges c WHERE c.id=? AND c.consumed_by=?)`,
  ).bind(accountId, id, id, claim);
}

export async function emailProfileEndpoint(
  request: Request,
  env: Env,
  user: Pick<Session, "id" | "username">,
  action: string,
) {
  const expected = request.headers.get("X-QD-Account");
  check(!expected || expected === user.id, "账号已切换，请刷新页面。", 401);
  const account = await env.DB.prepare(
    "SELECT id,username,password_hash,email,email_verified_at FROM accounts WHERE id=?",
  )
    .bind(user.id)
    .first<Account>();
  check(account, "请先登录账号。", 401);
  if (!action) {
    check(request.method === "GET", "方法不支持。", 405);
    return json({
      email: account.email_verified_at ? account.email : null,
      available: emailAvailable(env),
    });
  }
  check(request.method === "POST", "方法不支持。", 405);
  check(["request", "confirm"].includes(action), "接口不存在。", 404);
  requireEmail(env);
  const input = await body(request);
  const email = emailAddress(input.email);
  if (action === "request") {
    await limit(env, `email:password:${user.id}`, 10, 15 * 60 * 1000);
    check(
      typeof input.currentPassword === "string" &&
        input.currentPassword.length <= 128 &&
        (await verifyPassword(input.currentPassword, account.password_hash)),
      "当前密码不正确。",
      400,
    );
    await sendLimit(request, env, user.username, email);
    const id = token();
    await issueChallenge(env, account, email, "bind", id);
    return json({ challengeId: id, retryAfter: 60 });
  }
  const challenge = await verifiedChallenge(env, input, user.id, email, "bind");
  const claim = token();
  try {
    const results = await env.DB.batch([
      claimStatement(env, challenge.id, claim),
      env.DB.prepare(
        `UPDATE accounts SET email=?,email_verified_at=? WHERE id=?
        AND EXISTS(SELECT 1 FROM email_challenges WHERE id=? AND consumed_by=?)`,
      ).bind(email, Date.now(), user.id, challenge.id, claim),
      invalidateOtherChallenges(env, user.id, challenge.id, claim),
    ]);
    check(
      results[0].meta.changes === 1 && results[1].meta.changes === 1,
      invalidCode,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed.*accounts\.email/.test(error.message)
    )
      throw new HttpError(409, "这个邮箱暂时无法绑定，请使用其他邮箱。");
    throw error;
  }
  return json({ email });
}

export async function passwordResetEndpoint(
  request: Request,
  env: Env,
  action: string,
  ctx: ExecutionContext,
) {
  check(request.method === "POST", "方法不支持。", 405);
  check(["request", "confirm"].includes(action), "接口不存在。", 404);
  requireEmail(env);
  const input = await body(request);
  const username = usernameValue(input.username);
  const email = emailAddress(input.email);
  if (action === "request") {
    await sendLimit(request, env, username, email);
    const id = token();
    // Both known and unknown identities return immediately with identical data.
    // Delivery runs in the execution context, so provider latency is not an
    // account-existence oracle and HTTP never returns the verification code.
    ctx.waitUntil(
      (async () => {
        const account = await env.DB.prepare(
          "SELECT id,username,password_hash,email,email_verified_at FROM accounts WHERE username=? AND email=? AND email_verified_at IS NOT NULL",
        )
          .bind(username, email)
          .first<Account>();
        if (account) await issueChallenge(env, account, email, "reset", id);
      })().catch(() => {
        console.error("Password recovery email delivery failed");
      }),
    );
    return json(
      {
        challengeId: id,
        retryAfter: 60,
        message:
          "如果用户名和绑定邮箱匹配，验证码将发送至该邮箱，请检查收件箱和垃圾邮件。",
      },
      202,
    );
  }
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  await limit(env, `email:verify:${ip}`, 60, 15 * 60 * 1000);
  check(
    typeof input.password === "string" &&
      input.password.length >= 9 &&
      input.password.length <= 128,
    "密码需要 9–128 个字符。",
  );
  const account = await env.DB.prepare(
    "SELECT id FROM accounts WHERE username=? AND email=? AND email_verified_at IS NOT NULL",
  )
    .bind(username, email)
    .first<{ id: string }>();
  // A missing identity still follows the challenge-query path, preventing an
  // extra D1 round trip from revealing whether a username/email pair exists.
  const challenge = await verifiedChallenge(
    env,
    input,
    account?.id || "",
    email,
    "reset",
  );
  const nextHash = await hashPassword(input.password);
  const claim = token();
  const results = await env.DB.batch([
    claimStatement(env, challenge.id, claim),
    env.DB.prepare(
      `UPDATE accounts SET password_hash=? WHERE id=?
      AND EXISTS(SELECT 1 FROM email_challenges WHERE id=? AND consumed_by=?)`,
    ).bind(nextHash, challenge.account_id, challenge.id, claim),
    env.DB.prepare(
      `DELETE FROM account_sessions WHERE account_id=?
      AND EXISTS(SELECT 1 FROM email_challenges WHERE id=? AND consumed_by=?)`,
    ).bind(challenge.account_id, challenge.id, claim),
    invalidateOtherChallenges(env, challenge.account_id, challenge.id, claim),
  ]);
  check(
    results[0].meta.changes === 1 && results[1].meta.changes === 1,
    invalidCode,
  );
  return json({ ok: true });
}
