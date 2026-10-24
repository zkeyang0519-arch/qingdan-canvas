import type { Env } from "./types";
import { check } from "./http";
import { limit } from "./auth-limits";

export const expiry = 10 * 60 * 1000;
export const invalidCode = "验证码无效或已过期，请重新获取。";
export type EmailPurpose = "bind" | "reset" | "register";

export function emailAddress(value: unknown) {
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

export function usernameValue(value: unknown) {
  check(typeof value === "string", "请输入用户名。");
  const username = value.trim().toLowerCase();
  check(/^[a-z0-9_-]{3,32}$/.test(username), "请输入正确的用户名。");
  return username;
}

export async function hashCode(
  env: Env,
  challenge: {
    id: string;
    identity: string;
    purpose: EmailPurpose;
    email: string;
  },
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
  // Preserve the existing bind/reset payload, so already-issued codes stay valid.
  const value = JSON.stringify([
    challenge.id,
    challenge.identity,
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

export function makeCode() {
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= 4294000000);
  return String(value[0] % 1000000).padStart(6, "0");
}

export async function sendLimit(
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
