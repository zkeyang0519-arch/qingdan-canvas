import type { Env } from "./types";
import { digest } from "./auth";
import { check } from "./http";

export async function limit(
  env: Env,
  key: string,
  max: number,
  duration: number,
) {
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
