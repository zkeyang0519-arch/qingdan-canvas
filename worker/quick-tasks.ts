import type { Env } from "./types";
import { body, check, json, validId } from "./http";
import { validDeadline } from "../shared/deadline.js";

interface QuickTask {
  id: string;
  text: string;
  createdAt: string;
}

async function list(env: Env, accountId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id,text,created_at AS createdAt FROM account_quick_tasks WHERE account_id=? ORDER BY created_at,id",
  )
    .bind(accountId)
    .all<QuickTask>();
  return results;
}

export async function quickTasksEndpoint(
  request: Request,
  env: Env,
  accountId: string,
  itemId?: string,
) {
  if (itemId) {
    check(validId(itemId), "常用待办编号无效。");
    check(request.method === "DELETE", "方法不支持。", 405);
    await env.DB.prepare(
      "DELETE FROM account_quick_tasks WHERE account_id=? AND id=?",
    )
      .bind(accountId, itemId)
      .run();
  } else if (request.method !== "GET") {
    check(request.method === "POST", "方法不支持。", 405);
    const input = await body(request);
    const id = input.id ?? crypto.randomUUID();
    check(validId(id), "常用待办编号无效。");
    check(
      typeof input.text === "string" &&
        input.text.trim().length > 0 &&
        input.text.trim().length <= 2000,
      "常用待办需要 1–2000 个字。",
    );
    const text = input.text.trim();
    const createdAt = input.createdAt ?? new Date().toISOString();
    check(validDeadline(createdAt), "创建时间无效。");
    // Atomic capacity check; per-item writes never replace another device's library.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO account_quick_tasks(account_id,id,text,created_at)
       SELECT ?,?,?,? WHERE (SELECT count(*) FROM account_quick_tasks WHERE account_id=?) < 100`,
    )
      .bind(accountId, id, text, createdAt, accountId)
      .run();
    const items = await list(env, accountId);
    check(
      items.some((item) => item.text === text),
      items.length >= 100
        ? "常用清单最多保存 100 条，请先删除不用的条目。"
        : "待办编号已存在，请重试。",
      409,
    );
    return json({ items });
  }
  return json({ items: await list(env, accountId) });
}
