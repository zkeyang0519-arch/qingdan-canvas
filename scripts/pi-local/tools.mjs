import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexClient } from "../../runner/codex-client.ts";
import { filmCodexVersions, runFilmCodex } from "../../runner/film/codex.mjs";
import { FilmJournal, stableId } from "../../runner/film/journal.mjs";
import { inspectMedia, writeBytes } from "../../runner/film/media.mjs";
import { modelToolResult } from "./chat-contract.mjs";
import { waaoAccessIssue } from "../../shared/agent/waao-access.mjs";
export { waaoLogin } from "./waao-login.mjs";
import { credentialFile } from "./waao-login.mjs";
import { credentialTarget } from "../../runner/credentials.ts";
export function mcpCredentialFile(dir, id, url, kind = "mcp") {
  const vaultOrigin = new URL(url);
  if (vaultOrigin.protocol === "http:" && vaultOrigin.hostname === "localhost")
    vaultOrigin.hostname = "127.0.0.1";
  return credentialFile(
    dir,
    kind + "-" + id + ".private",
    credentialTarget(vaultOrigin.origin, id),
  );
}
export { webWaao } from "./waao.mjs";

const exec = promisify(execFile);
const accountId = "pi-local";
const localBinding = (id) =>
  id === "pi-local-binding" || /^pi-bind-[0-9a-f-]{36}$/.test(id);
const shape = (row) => ({ id: row.id, label: row.label });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function openTools(dir, sample, waao, options = {}) {
  const accountId = options.accountId ?? "pi-local";
  const acceptsBinding = options.isBinding ?? localBinding;
  const key = (scope, userMessageId) =>
    stableId(
      accountId,
      scope.bindingId ?? "pi-local-binding",
      scope.chatId,
      userMessageId,
    );
  const journal = new FilmJournal(dir);
  const pending = new Map();
  const toolEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.toUpperCase() !== "XINGCHI_API_KEY",
    ),
  );
  async function native(id, turn, signal, onProgress) {
    const cwd = path.join(tmpdir(), "qingdan-pi-native", id);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    return runFilmCodex(
      {
        key: id,
        job: { id, step: 1, attempt: 0 },
        cwd,
        journal,
        signal,
        onProgress,
        env: toolEnv,
        createCodexClient: () =>
          new CodexClient({
            command:
              process.env.QINGDAN_FILM_CODEX_BIN ||
              process.env.QINGDAN_CODEX_BIN ||
              "codex",
            compatibleVersions: filmCodexVersions,
            maxMessageBytes: 32 * 1024 * 1024,
            env: toolEnv,
          }),
        cloud: async (route, { checkpoint }) => {
          if (route !== "codex-turn") throw Error("未知的 Codex 回执。");
          const prior = journal.get(id + ":checkpoint");
          if (prior && !checkpoint.turnId)
            return { checkpoint: prior, dispatch: false };
          const next = journal.put(id + ":checkpoint", {
            ...checkpoint,
            step: 1,
            attempt: 0,
          });
          return { checkpoint: next, dispatch: !prior };
        },
      },
      turn,
    );
  }
  async function invoke({ name, args, scope }, signal, waaoAccess, onProgress) {
    if (onProgress && waaoAccess) waaoAccess = { ...waaoAccess, onProgress };
    if (
      scope.accountId !== accountId ||
      !acceptsBinding(scope.bindingId) ||
      !scope.chatId ||
      !scope.userMessageId
    )
      throw Error("无权使用此本机测试项目。");
    const slot = key(scope, scope.userMessageId);
    const current = journal.get(slot) || { drafts: [], media: [], actions: [] };
    const history = [
      ...scope.visible.map((id) => journal.get(key(scope, id))).filter(Boolean),
      current,
    ];
    const drafts = history.flatMap((row) => row.drafts);
    const images = history.flatMap((row) => row.media);
    const draft = drafts.find((row) => row.id === args.draftId);
    const actionKey = name + "." + args.action;
    const id = stableId(slot, actionKey);
    const was = journal.get(id + ":receipt");
    if (
      was &&
      !(name === "waao" && ["targets", "status"].includes(args.action))
    ) {
      if (!isDeepStrictEqual(was.args, args))
        throw Error("同一轮已有不同参数的操作，请在下一条消息中修改。");
      return was.value;
    }
    const priorError = journal.get(id + ":error");
    if (priorError) throw Error(priorError);
    let value;
    if (name === "codex" && ["revise", "images"].includes(args.action)) {
      if (
        typeof args.brief !== "string" ||
        !args.brief.trim() ||
        args.brief.length > 16000
      )
        throw Error("请提供简短的创作要求。");
      if (args.draftId && !draft)
        throw Error("当前对话中找不到指定版本的稿件。");
      if (args.action === "revise") {
        const task = {
          kind: "text",
          instructions:
            "你是轻单的短片改稿人。按用户要求修改稿件，直接返回可使用的中文正文。",
          prompt: [draft?.text, args.brief].filter(Boolean).join("\n\n"),
        };
        const result = sample
          ? { text: "【联调样例稿】" + args.brief }
          : await native(id, task, signal, onProgress);
        const row = {
          id,
          label: "稿件 v" + (drafts.length + 1),
          text: result.text,
          origin: result.origin,
        };
        current.drafts.push(row);
        value = {
          ...shape(row),
          text: row.text,
          source: sample ? "本机样例" : "Codex",
        };
      } else {
        const count = args.count ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > 4)
          throw Error("本机试用每组支持 1 至 4 张图。");
        const group = new Set(images.map((row) => row.group)).size + 1;
        const items = [];
        for (let index = 0; index < count; index++) {
          signal.throwIfAborted();
          const imageId = stableId(id, index);
          let row = journal.get("image:" + imageId);
          if (!row) {
            const task = {
              kind: "image",
              instructions:
                "请使用原生 image_generation 工具实际生成一张独立参考图。直接交付图像。",
              prompt: [
                draft?.text,
                args.brief,
                "本轮只生成第 " +
                  (index + 1) +
                  " 张，共 " +
                  count +
                  " 张。按用户给定的顺序与差异绘制这张图。",
              ]
                .filter(Boolean)
                .join("\n\n"),
            };
            const result = sample
              ? {
                  bytes: (
                    await exec(
                      "ffmpeg",
                      [
                        "-v",
                        "error",
                        "-f",
                        "lavfi",
                        "-i",
                        "color=c=" +
                          ["0xaa4e32", "0x285790", "0x38714d", "0x94679e"][
                            index
                          ] +
                          ":s=320x180",
                        "-frames:v",
                        "1",
                        "-f",
                        "image2pipe",
                        "-c:v",
                        "png",
                        "pipe:1",
                      ],
                      {
                        encoding: "buffer",
                        windowsHide: true,
                        env: toolEnv,
                        signal,
                      },
                    )
                  ).stdout,
                }
              : await native(imageId, task, signal, onProgress);
            const file = await writeBytes({ journal }, imageId, result.bytes);
            const info = await inspectMedia(file, false, signal);
            row = {
              id: imageId,
              label: "第 " + group + " 组 · 图 " + (index + 1),
              group,
              chatId: scope.chatId,
              owner: accountId,
              file,
              mime: info.mime,
              sha256: sha256(result.bytes),
              origin: result.origin,
            };
            journal.put("image:" + imageId, row);
          }
          items.push(row);
        }
        current.media.push(...items);
        value = {
          source: sample ? "本机色卡样例" : "Codex 原图",
          images: items.map(shape),
        };
      }
    } else if (name === "waao" && args.action === "targets") {
      const targets = modelToolResult(
        "waao",
        "targets",
        await waao.targets(args, signal, waaoAccess),
      );
      journal.put(slot + ":targets", targets);
      return targets;
    } else if (name === "waao" && args.action === "submit") {
      const image = images.find((row) => row.id === args.assetId);
      if (!draft || !image) throw Error("请从这段对话选择已存在的稿件和图号。");
      if (!waao) throw Error("请连接 WAAO 网页 MCP。");
      const previous = history
        .map((row) => row.submission?.target)
        .filter(Boolean)
        .at(-1);
      const groupOrder = [
        ...new Set(
          images
            .filter((row) => row.group === image.group)
            .map((row) => row.id),
        ),
      ];
      value = await waao.submit({
        journal,
        chatId: scope.chatId,
        draft,
        image,
        groupOrder,
        signal,
        access: waaoAccess,
        target: args.target || previous,
        ratio: args.ratio,
        edition: args.newVersion ? scope.userMessageId : undefined,
      });
      current.submission = value;
    } else if (name === "waao" && args.action === "status") {
      value = history
        .map((row) => row.submission)
        .find((r) => r?.id === args.receiptId);
      if (!value) throw Error("此会话中没有该 WAAO 回执。");
      if (!value.id.startsWith("LOCAL-")) {
        value = await waao.status(value, signal, waaoAccess);
        current.submission = value;
      }
    } else throw Error("本机未注册该操作。");
    current.actions.push(actionKey);
    journal.db.exec("BEGIN IMMEDIATE");
    try {
      journal.put(slot, current);
      if (current.submission && !current.submission.id.startsWith("LOCAL-"))
        journal.put("web-task:" + current.submission.id, {
          chatId: scope.chatId,
          receipt: current.submission,
        });
      journal.put(id + ":receipt", { args, value });
      journal.db.exec("COMMIT");
    } catch (error) {
      journal.db.exec("ROLLBACK");
      throw error;
    }
    return value;
  }
  return {
    close: () => journal.close(),
    context(scope) {
      if (scope.accountId !== accountId || !acceptsBinding(scope.bindingId))
        throw Error("无权读取该聊天的资料。");
      return [...new Set([...scope.visible, scope.userMessageId])].flatMap(
        (user) => {
          const row = journal.get(key(scope, user));
          return row
            ? row.drafts.map((draft) => ({
                title: draft.label,
                text: draft.text,
              }))
            : [];
        },
      );
    },
    references(scope) {
      if (scope.accountId !== accountId || !acceptsBinding(scope.bindingId))
        throw Error("无权读取该聊天的素材。");
      const refs = [];
      for (const user of scope.visible) {
        const slot = key(scope, user);
        const row = journal.get(slot);
        if (row) {
          refs.push(
            ...row.drafts.map((draft) =>
              scope.retry && user === scope.userMessageId
                ? { ...shape(draft), text: draft.text }
                : shape(draft),
            ),
            ...row.media.map(shape),
          );
          if (row.submission)
            refs.push(modelToolResult("waao", "status", row.submission));
        }
        const targets = journal.get(slot + ":targets");
        if (targets) refs.push(targets);
      }
      return refs;
    },
    async fetch(request, waaoAccess, onProgress) {
      const input = await request.json();
      const action = input.name + "." + input.args.action;
      const work = stableId(
        key(input.scope, input.scope.userMessageId),
        action,
      );
      try {
        console.log("Pi local tool", action, "started");
        if (!pending.has(work))
          pending.set(
            work,
            invoke(input, request.signal, waaoAccess, onProgress).finally(() =>
              pending.delete(work),
            ),
          );
        const result = await pending.get(work);
        console.log("Pi local tool", action, "completed");
        return Response.json(result);
      } catch (error) {
        const message = String(error.message).slice(0, 300);
        if (error.uncertain) journal.put(work + ":error", message);
        console.error("Pi local tool", action, message);
        const accessIssue =
          input.name === "waao" ? waaoAccessIssue(error) : null;
        return Response.json(
          { error: message, ...(accessIssue && { accessIssue }) },
          { status: 422 },
        );
      }
    },
    decorate(message) {
      if (
        message.role !== "assistant" ||
        !message.replyTo ||
        message.invalidated ||
        message.provenance?.kind === "cancelled_reply"
      )
        return message;
      const row = journal.get(key(message, message.replyTo));
      const recent =
        row?.submission && journal.get("web-task:" + row.submission.id);
      return row
        ? {
            ...message,
            media: row.media.map(shape),
            submission:
              recent?.chatId === message.chatId
                ? recent.receipt
                : row.submission,
            piActions: row.actions,
          }
        : message;
    },
    async taskStatus(id, chatId, signal) {
      const task = journal.get("web-task:" + id);
      if (!task || task.chatId !== chatId) return null;
      const current = task.receipt;
      if (
        current.playable ||
        ["failed", "stopped", "cancelled"].includes(current.status) ||
        Date.now() - (task.checkedAt || 0) < 12000
      )
        return current;
      const query = "status:" + id;
      if (!pending.has(query))
        pending.set(
          query,
          waao
            .status(current, signal)
            .then((receipt) => {
              journal.put("web-task:" + id, {
                ...task,
                receipt,
                checkedAt: Date.now(),
              });
              return receipt;
            })
            .finally(() => pending.delete(query)),
        );
      return pending.get(query);
    },
    async image(id) {
      const data = journal.get("image:" + id);
      if (data?.owner !== accountId) return null;
      return { mime: data.mime, bytes: await readFile(data.file) };
    },
    async video(id, signal) {
      const task = journal.get("web-task:" + id);
      return task?.receipt.playable ? waao.video(task.receipt, signal) : null;
    },
  };
}
