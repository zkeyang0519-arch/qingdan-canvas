import type { Env } from "./types";
import { check, HttpError } from "./http";
import type { EmailPurpose } from "./email-verification";

export function emailAvailable(env: Env) {
  return !!(
    env.RESEND_API_KEY?.trim() &&
    env.EMAIL_FROM?.trim() &&
    !/[\r\n]/.test(env.EMAIL_FROM) &&
    env.EMAIL_CODE_SECRET &&
    env.EMAIL_CODE_SECRET.length >= 32
  );
}

export function requireEmail(env: Env) {
  check(emailAvailable(env), "邮件验证服务尚未启用，请联系管理员。", 503);
}

export async function sendVerificationEmail(
  env: Env,
  email: string,
  code: string,
  purpose: EmailPurpose,
  challengeId: string,
) {
  requireEmail(env);
  try {
    const action =
      purpose === "bind"
        ? "绑定邮箱"
        : purpose === "reset"
          ? "重置密码"
          : "注册账号并绑定邮箱";
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `qingdan-verification/${challengeId}`,
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [email],
        subject: `轻单${action}验证码`,
        text: `你正在${action}。\n\n验证码：${code}\n\n验证码 10 分钟内有效，仅可使用一次。请勿向他人透露验证码。若非本人操作，请忽略此邮件。`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Email provider rejected request");
    await response.body?.cancel();
  } catch {
    // Do not expose provider responses, keys, email addresses or OTPs in logs.
    throw new HttpError(503, "验证码邮件暂时发送失败，请稍后重试。");
  }
}
