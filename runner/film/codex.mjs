import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import pin from "../protocol-version.json" with { type: "json" };
import { stableId, StageFailure } from "./journal.mjs";
import { nativeActivityLine } from "../../shared/agent/task-activity.mjs";

export const filmCodexVersions = [
  pin.codexVersion,
  "0.169.0-alpha.11.1",
  "0.169.1",
];
const exec = promisify(execFile);
const imageLimit = 16 * 1024 * 1024;
/** @param {{command:string,args?:string[],env?:NodeJS.ProcessEnv}} options */
export async function inspectFilmCodex({
  command,
  args = [],
  env = process.env,
}) {
  const opts = {
    env,
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 256 * 1024,
  };
  try {
    const version = (
      await exec(command, [...args, "--version"], opts)
    ).stdout.trim();
    if (!filmCodexVersions.some((v) => version === "codex-cli " + v))
      return { codexText: false, codexImage: false };
    const flags = (
      await exec(command, [...args, "features", "list"], opts).catch(() => ({
        stdout: "",
      }))
    ).stdout;
    return {
      codexText: true,
      codexImage: /^image_generation\s+.+?\s+true\s*$/m.test(flags),
    };
  } catch {
    return { codexText: false, codexImage: false };
  }
}
export function activeFilmTurn(job) {
  const p = job.codexTurn;
  return p?.step === job.step && p.attempt === job.attempt ? p : null;
}
const uncertain = () =>
  new StageFailure("Codex 可能已经受理，请核对原会话和轮次。", {
    uncertain: true,
  });
async function sameDirectory(left, right) {
  if (!left || !right) return false;
  return path.relative(await realpath(left), await realpath(right)) === "";
}
async function listTurns(client, threadId, turnId) {
  // One thread belongs to one creative step. Request full items only to recover a lost turn/start ack.
  const result = await client
    .request("thread/turns/list", {
      threadId,
      limit: 2,
      sortDirection: "desc",
      itemsView: turnId ? "summary" : "full",
    })
    .catch((error) => {
      // A newly accepted native turn can precede creation of its history store.
      // The caller already bounds this wait and keeps the original turn alive.
      if (error.message === "list_turns is not supported yet") return null;
      throw error;
    });
  if (!result) return undefined;
  if (
    !Array.isArray(result.data) ||
    result.nextCursor ||
    result.data.length > 1
  )
    throw new StageFailure("Codex 原会话含多个轮次，需核对原任务。", {
      uncertain: true,
    });
  return result.data[0];
}
export async function listCodexTurnItems(client, threadId, turnId) {
  const items = [],
    seen = new Set();
  let cursor = null;
  do {
    const page = await client.request("thread/items/list", {
      threadId,
      turnId,
      cursor,
      limit: 40,
      sortDirection: "asc",
    });
    for (const row of page.data) {
      if (row.turnId !== turnId || (row.threadId && row.threadId !== threadId))
        throw Error("Codex 产物归属与原轮次不符。");
      items.push(row.item);
    }
    cursor = page.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size >= 64))
      throw Error("Codex 产物分页无法核对。");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}
async function generatedBytes(item, home) {
  if (item.savedPath && home && path.isAbsolute(item.savedPath)) {
    const root = await realpath(path.join(home, "generated_images")).catch(
      () => null,
    );
    const file = await realpath(item.savedPath).catch(() => null);
    if (root && file) {
      const relative = path.relative(root, file);
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(".." + path.sep)
      )
        throw Error("Codex 返回的图像位置不属于该执行端的生成目录。");
      const fd = await open(file, "r");
      try {
        const st = await fd.stat();
        if (!st.isFile() || !st.size || st.size > imageLimit)
          throw Error("Codex 原图为空或超过 16 MiB。");
        return await fd.readFile();
      } finally {
        await fd.close();
      }
    }
  }
  const encoded =
    typeof item.result === "string"
      ? item.result.replace(/^data:image\/(?:png|jpeg|webp|gif);base64,/i, "")
      : "";
  if (
    !encoded ||
    encoded.length > Math.ceil(imageLimit / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    throw Error("该轮 Codex 没有交回可读取的图片文件或图像字节。");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > imageLimit)
    throw Error("Codex 原图为空或超过 16 MiB。");
  return bytes;
}

export async function runFilmCodex(
  ctx,
  { kind, instructions, prompt, images = [] },
) {
  if (!ctx.createCodexClient)
    throw Error("绑定的 Runner 缺少 Codex 制作连接。");
  const slot = ctx.key + ":native-turn";
  let checkpoint = activeFilmTurn(ctx.job) || ctx.journal.get(slot);
  if (
    !checkpoint &&
    ctx.codexCaps &&
    !ctx.codexCaps[kind === "image" ? "codexImage" : "codexText"]
  ) {
    throw Error(
      kind === "image"
        ? "绑定设备的 Codex 未报告可用的原生生图能力。"
        : "请配置制作连接支持的 Codex 程序。",
    );
  }
  const client = ctx.createCodexClient();
  let outstanding = !!checkpoint,
    confirmedTerminal = false;
  let liveTurn;
  const liveItems = new Map();
  client.on("notification", ({ method, params }) => {
    if (!checkpoint || params?.threadId !== checkpoint.threadId) return;
    if (
      !checkpoint.turnId ||
      !params.turnId ||
      params.turnId === checkpoint.turnId
    ) {
      const line = nativeActivityLine({ method, params });
      if (line) ctx.onProgress?.({ message: line });
    }
    if (method === "turn/completed" && params.turn?.id) liveTurn = params.turn;
    if (
      method === "item/completed" &&
      params.turnId &&
      params.item?.id &&
      ["userMessage", "agentMessage", "imageGeneration"].includes(
        params.item.type,
      )
    )
      liveItems.set(params.item.id, {
        turnId: params.turnId,
        item: params.item,
      });
  });
  client.on("request", (p) =>
    client.rejectRequest(p.id, "此制作步骤只接收稿件或原生图像回执。"),
  );
  try {
    const initialized = await client.connect();
    const access = await client.request("account/read", {
      refreshToken: false,
    });
    if (!access.account && access.requiresOpenaiAuth !== false)
      throw Error("请先在启动 Runner 的系统账号登录 Codex。");
    ctx.signal.throwIfAborted();
    let send = false;
    if (!checkpoint) {
      if (ctx.job.checkOnly) throw uncertain();
      const started = await client.request("thread/start", {
        cwd: ctx.cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        ephemeral: false,
        ...(ctx.env.QINGDAN_FILM_CODEX_MODEL
          ? { model: ctx.env.QINGDAN_FILM_CODEX_MODEL }
          : {}),
        config: {
          "features.shell_tool": false,
          ...(kind === "text" ? { "features.image_generation": false } : {}),
        },
        developerInstructions: instructions,
      });
      if (
        !started.thread?.id ||
        !(await sameDirectory(started.thread.cwd, ctx.cwd))
      )
        throw Error("Codex 会话与授权项目不符。");
      const proposed = {
        threadId: started.thread.id,
        requestId: stableId(ctx.job.id, ctx.job.step, ctx.job.attempt, "codex"),
        model: started.model,
      };
      const receipt = await ctx.cloud("codex-turn", { checkpoint: proposed });
      checkpoint = receipt.checkpoint;
      send = receipt.dispatch === true;
      ctx.journal.put(slot, checkpoint);
    }
    if (!checkpoint?.threadId || !checkpoint.requestId)
      throw Error("缺少可核对的 Codex 派单记录。");
    const threadId = checkpoint.threadId;
    if (send) {
      ctx.signal.throwIfAborted();
      outstanding = true;
      const started = await client.request("turn/start", {
        threadId,
        clientUserMessageId: checkpoint.requestId,
        cwd: ctx.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        input: [
          { type: "text", text: prompt, text_elements: [] },
          ...images.map((p) => ({ type: "localImage", path: p })),
        ],
      });
      if (!started.turn?.id) throw uncertain();
      checkpoint = { ...checkpoint, turnId: started.turn.id };
      ctx.journal.put(slot, checkpoint);
      await ctx.cloud("codex-turn", { checkpoint });
    } else {
      const { thread } = await client.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      if (
        thread?.id !== threadId ||
        !(await sameDirectory(thread.cwd, ctx.cwd))
      )
        throw uncertain();
      outstanding = true;
    }
    let turn;
    const waitForHistoryUntil = Date.now() + 15000;
    for (;;) {
      ctx.signal.throwIfAborted();
      turn =
        checkpoint.turnId && liveTurn?.id === checkpoint.turnId
          ? liveTurn
          : await listTurns(client, threadId, checkpoint.turnId);
      if (!turn && Date.now() < waitForHistoryUntil) {
        await delay(750, undefined, { signal: ctx.signal });
        continue;
      }
      if (!turn || (checkpoint.turnId && turn.id !== checkpoint.turnId))
        throw uncertain();
      if (!checkpoint.turnId) {
        if (
          !turn.items.some(
            (i) =>
              i.type === "userMessage" && i.clientId === checkpoint.requestId,
          )
        )
          throw uncertain();
        checkpoint = { ...checkpoint, turnId: turn.id };
        ctx.journal.put(slot, checkpoint);
        await ctx.cloud("codex-turn", { checkpoint });
      }
      if (turn.status !== "inProgress") break;
      await delay(2000, undefined, { signal: ctx.signal });
    }
    if (turn.status !== "completed") {
      if (!["failed", "interrupted"].includes(turn.status)) throw uncertain();
      confirmedTerminal = true;
      throw Error("原 Codex 轮次未完成，请检查设备上的任务后重试。");
    }
    const durableItems = await listCodexTurnItems(client, threadId, turn.id);
    const itemsById = new Map(durableItems.map((item) => [item.id, item]));
    for (const record of liveItems.values()) {
      if (record.turnId !== turn.id) continue;
      const previous = itemsById.get(record.item.id);
      // The live receipt can include bytes that persisted history represents only by a file handle.
      itemsById.set(record.item.id, { ...previous, ...record.item });
    }
    const items = [...itemsById.values()];
    if (
      !items.some(
        (i) => i.type === "userMessage" && i.clientId === checkpoint.requestId,
      )
    )
      throw uncertain();
    confirmedTerminal = true;
    const origin = {
      threadId,
      turnId: turn.id,
      requestId: checkpoint.requestId,
      model: checkpoint.model || "Codex",
    };
    if (kind === "text") {
      const messages = items.filter((i) => i.type === "agentMessage");
      const item =
        messages.findLast((i) => i.phase === "final_answer") ||
        messages.findLast((i) => i.phase == null);
      if (!item?.text?.trim() || item.text.length > 256000)
        throw Error("Codex 未交付完整的最终改稿。");
      return { text: item.text, origin: { ...origin, itemId: item.id } };
    }
    const outputs = items.filter((i) => i.type === "imageGeneration");
    if (
      outputs.length !== 1 ||
      outputs[0].failure ||
      !["completed", "succeeded"].includes(outputs[0].status)
    )
      throw Error(
        "此轮没有唯一成功的 Codex 原生生图回执，请检查生图权限或额度。",
      );
    const item = outputs[0];
    return {
      bytes: await generatedBytes(item, initialized.codexHome),
      origin: {
        ...origin,
        itemId: item.id,
        ...(item.generationId ? { generationId: item.generationId } : {}),
      },
    };
  } catch (err) {
    if (outstanding && !confirmedTerminal && !err.uncertain) throw uncertain();
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}
