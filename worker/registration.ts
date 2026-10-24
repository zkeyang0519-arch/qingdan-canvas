import type { Env } from "./types";
import { getSession, token } from "./auth";
import { body, check, json } from "./http";
import { requireEmail, sendVerificationEmail } from "./email-sender";
import {
  emailAddress,
  usernameValue,
  expiry,
  invalidCode,
  hashCode,
  makeCode,
  sendLimit,
} from "./email-verification";

interface RegistrationChallenge {
  id: string;
  username: string;
  email: string;
  code_hash: string;
}

export async function registrationRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  check(request.method === "POST", "方法不支持。", 405);
  requireEmail(env);
  check(!(await getSession(request, env)), "请先退出当前账号。", 409);
  const input = await body(request);
  const username = usernameValue(input.username);
  const email = emailAddress(input.email);
  await sendLimit(request, env, username, email);
  const id = token();
  // Match recovery: identical response and timing whether an address is used.
  ctx.waitUntil(
    (async () => {
      const used = await env.DB.prepare(
        "SELECT 1 FROM accounts WHERE username=? OR email=?",
      )
        .bind(username, email)
        .first();
      if (used) return;
      const code = makeCode();
      const hash = await hashCode(
        env,
        { id, identity: username, purpose: "register", email },
        code,
      );
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM registration_challenges WHERE expires_at<=? OR username=? OR email=?",
        ).bind(Date.now(), username, email),
        env.DB.prepare(
          "INSERT INTO registration_challenges(id,username,email,code_hash,expires_at) VALUES(?,?,?,?,?)",
        ).bind(id, username, email, hash, Date.now() + expiry),
      ]);
      try {
        await sendVerificationEmail(env, email, code, "register", id);
      } catch (error) {
        await env.DB.prepare("DELETE FROM registration_challenges WHERE id=?")
          .bind(id)
          .run();
        throw error;
      }
    })().catch(() => console.error("Registration email delivery failed")),
  );
  return json(
    {
      challengeId: id,
      retryAfter: 60,
      message:
        "如果用户名和邮箱可用于注册，验证码将发送至该邮箱，请检查收件箱和垃圾邮件。",
    },
    202,
  );
}

export async function verifyRegistration(
  env: Env,
  input: Record<string, unknown>,
  username: string,
) {
  requireEmail(env);
  const email = emailAddress(input.email);
  check(
    typeof input.challengeId === "string" &&
      /^[a-f0-9]{64}$/.test(input.challengeId),
    invalidCode,
  );
  check(
    typeof input.code === "string" && /^\d{6}$/.test(input.code),
    invalidCode,
  );
  const challenge = await env.DB.prepare(
    `UPDATE registration_challenges SET attempts=attempts+1
    WHERE id=? AND username=? AND email=? AND consumed_by IS NULL AND expires_at>? AND attempts<5
    RETURNING id,username,email,code_hash`,
  )
    .bind(input.challengeId, username, email, Date.now())
    .first<RegistrationChallenge>();
  check(challenge, invalidCode);
  check(
    (await hashCode(
      env,
      { id: challenge.id, identity: username, purpose: "register", email },
      input.code,
    )) === challenge.code_hash,
    invalidCode,
  );
  return challenge;
}

export function claimRegistration(
  env: Env,
  challenge: RegistrationChallenge,
  claim: string,
) {
  return env.DB.prepare(
    `UPDATE registration_challenges SET consumed_by=? WHERE id=? AND username=? AND email=? AND code_hash=?
    AND consumed_by IS NULL AND expires_at>? AND attempts<=5`,
  ).bind(
    claim,
    challenge.id,
    challenge.username,
    challenge.email,
    challenge.code_hash,
    Date.now(),
  );
}
