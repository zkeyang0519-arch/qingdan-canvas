import {
  authorizeExecution,
  bindingPrincipal,
  nativePrincipal,
} from "../execution/execution-auth";
import { requireSession } from "../auth";
import { body, check, json, limitedBytes, sameOrigin, validId } from "../http";
import { imageSignature } from "../assets";
import type { Env } from "../types";
import { FilmStore, type FilmBinding, type FilmScope } from "./film-store";
import {
  artifactSchema,
  nativeFilmTurn,
  resultSchema,
  waaoSubmissionSchema,
  type FilmJob,
} from "../../shared/agent/film";
import { z } from "zod";
import { callExecutionHub } from "../execution/mcp-server";
const mediaTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const availability = z.object({
  protocol: z.union([z.literal(1), z.literal(2)]),
  services: z.record(z.string().max(40), z.boolean()),
  target: z
    .object({
      team: z.string().max(150),
      project: z.string().max(150),
      canvas: z.string().max(150),
      model: z.string().max(160),
      billing: z.string().max(60),
    })
    .optional(),
});
type Access = {
  owner: string;
  native: boolean;
  runner?: string;
  scope?: FilmScope;
};
export async function filmRoute(request: Request, env: Env) {
  const url = new URL(request.url);
  const match = /^\/api\/(agent|runner)\/films(?:\/(.*))?$/.exec(url.pathname);
  if (!match) return null;
  check(
    env.RUNNER_ENABLED === "true" && env.EXECUTION_ENABLED === "true",
    "制作服务尚未启用。",
    404,
  );
  let access: Access;
  if (match[1] === "runner") {
    const d = await nativePrincipal(request, env);
    check(
      d.connection_epoch > 0 &&
        request.headers.has("X-Film-Connection") &&
        Number(request.headers.get("X-Film-Connection")) === d.connection_epoch,
      "设备连接已更新。",
      409,
    );
    access = { owner: d.owner_id, runner: d.runner_id, native: true };
  } else {
    sameOrigin(request);
    const user = await requireSession(request, env);
    check(
      (request.headers.get("X-QD-Account") ||
        url.searchParams.get("account")) === user.id,
      "账号已变化。",
      401,
    );
    const canvas = url.searchParams.get("canvas"),
      section = url.searchParams.get("section");
    check(validId(canvas) && validId(section), "请选择轻单项目。");
    const row = await env.DB.prepare("SELECT owner_id FROM rooms WHERE id=?")
      .bind(canvas)
      .first<{ owner_id: string }>();
    check(row?.owner_id === user.id, "当前账号无法访问该项目制作卡。", 403);
    const b = await env.DB.prepare(
      "SELECT binding_id,workspace_id FROM agent_bindings WHERE owner_id=? AND canvas_id=? AND section_id=? AND enabled=1",
    )
      .bind(user.id, canvas, section)
      .first<{ binding_id: string; workspace_id: string }>();
    let binding: FilmBinding | null = null;
    if (b) {
      try {
        binding = {
          ...(await bindingPrincipal(env, user.id, b.binding_id)),
          workspaceId: b.workspace_id,
        };
      } catch (e) {
        if ((e as any).status !== 403) throw e;
      }
    }
    access = {
      owner: user.id,
      native: false,
      scope: { canvas, section, binding },
    };
  }
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.set("X-Film-Access", encodeURIComponent(JSON.stringify(access)));
  const dest = new URL("https://agent.internal/films/" + (match[2] ?? ""));
  dest.search = url.search;
  return env.AGENT_CHATS.get(env.AGENT_CHATS.idFromName(access.owner)).fetch(
    new Request(dest, { method: request.method, headers, body: request.body }),
  );
}
async function requireJob(env: Env, j: FilmJob, runner: string) {
  check(
    j.binding && j.binding.runnerId === runner,
    "制作任务设备不匹配。",
    403,
  );
  const { workspace } = await authorizeExecution(env, j.binding);
  check(
    workspace.workspaceId === j.binding.workspaceId,
    "制作目录已更改。",
    409,
  );
}
async function mediaResponse(request: Request, env: Env, key: string) {
  const meta = await env.FILES.head(key);
  check(meta, "媒体文件暂不可用。", 404);
  const range = request.headers.get("Range");
  let start = 0,
    end = meta.size - 1;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${meta.size}` },
      });
    if (!m[1]) start = Math.max(0, meta.size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= meta.size)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${meta.size}` },
      });
  }
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type":
      meta.httpMetadata?.contentType ?? "application/octet-stream",
    "Content-Length": String(end - start + 1),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${meta.size}`);
  if (request.method === "HEAD")
    return new Response(null, { status: range ? 206 : 200, headers });
  const obj = await env.FILES.get(
    key,
    range ? { range: { offset: start, length: end - start + 1 } } : undefined,
  );
  check(obj, "媒体文件暂不可用。", 404);
  return new Response(obj.body, { status: range ? 206 : 200, headers });
}
export async function filmInternal(
  request: Request,
  ctx: DurableObjectState,
  env: Env,
  store: FilmStore,
) {
  const a: Access = JSON.parse(
    decodeURIComponent(request.headers.get("X-Film-Access") ?? ""),
  );
  check(
    a.owner && ctx.id.equals(env.AGENT_CHATS.idFromName(a.owner)),
    "制作记录归属不符。",
    403,
  );
  const url = new URL(request.url),
    parts = url.pathname.slice("/films/".length).split("/").filter(Boolean),
    [id, action, mediaId] = parts;
  const method = request.method;
  if (a.native) {
    const runner = a.runner!;
    if (parts.length === 1 && method === "POST") {
      const input = await body(request, 1_700_000);
      if (id === "poll") {
        const caps = availability.safeParse(input.capabilities);
        check(caps.success, "设备制作能力格式无效。");
        store.advertise(runner, caps.data);
        const j = store.candidate(runner, caps.data.protocol);
        if (!j) return json({ work: null });
        try {
          await requireJob(env, j, runner);
        } catch (e) {
          if ((e as any).status !== 403 && (e as any).status !== 409) throw e;
          store.block(j, runner, "设备授权已变化，请检查项目绑定。");
          return json({ work: null });
        }
        return json({ work: store.claim(j.id, runner) });
      }
      check(validId(input.jobId) && validId(input.token), "制作命令无效。");
      if (id === "report") {
        const r = resultSchema.safeParse(input.result);
        check(r.success, "制作回执格式无效。");
        const j = store.job(input.jobId);
        check(j, "制作版本不存在。", 404);
        await requireJob(env, j, runner);
        if ("artifact" in r.data && r.data.artifact.mediaId)
          check(
            await env.FILES.head(
              `films/${a.owner}/${j.filmId}/${r.data.artifact.mediaId}`,
            ),
            "媒体尚未保存。",
            409,
          );
        return json(store.report(runner, input.jobId, input.token, r.data));
      }
      const j = store.held(runner, input.jobId, input.token);
      await requireJob(env, j, runner);
      if (id === "renew")
        return json(store.renew(runner, input.jobId, input.token));
      if (id === "begin-submit") {
        const receipt = waaoSubmissionSchema
          .optional()
          .safeParse(input.submission);
        check(receipt.success, "WAAO 节点的提示词与素材记录格式无效。");
        return json(store.beginSubmit(runner, j.id, input.token, receipt.data));
      }
      if (id === "codex-turn") {
        const checkpoint = nativeFilmTurn.safeParse(input.checkpoint);
        check(checkpoint.success, "Codex 会话与轮次编号无效。");
        return json(
          store.codexCheckpoint(runner, j.id, input.token, checkpoint.data),
        );
      }
      if (id === "codex") {
        check(
          j.state === "working" &&
            j.input.writer === "codex" &&
            ["codex", "child"].includes(j.stage),
          "本步未委派 Codex。",
          403,
        );
        const p = j.binding!;
        if (j.stage === "child")
          return json(
            await callExecutionHub(
              env,
              p,
              "tool",
              { runId: j.childId, afterSeq: 0, limit: 1 },
              "codex_get_run",
            ),
          );
        check(
          j.input.brief.length <= 31900,
          "Codex 专项说明最多 31,900 字符。可在说明中引用已授权项目内的剧本文件。",
        );
        const prepared = await callExecutionHub(env, p, "intent", {
          requestId: j.id,
          bindingId: p.bindingId,
          bindingRevision: p.bindingRevision,
          kind: "task",
          instruction:
            "请仅根据已授权项目中的文稿整理影视初稿，最终回答给出完整初稿。\n" +
            j.input.brief,
          acceptance: "交付可读的完整短片初稿。",
          executionPermissions: { profile: "read_only" },
        });
        return json(
          await callExecutionHub(
            env,
            p,
            "tool",
            prepared.input,
            "codex_create_run",
          ),
        );
      }
      check(false, "制作设备接口不存在。", 404);
    }
  }
  if (!a.native && (!id || id === "capabilities")) {
    const scope = a.scope!;
    if (id === "capabilities" && method === "GET")
      return json({
        binding: scope.binding,
        capabilities: store.capabilities(scope.binding?.runnerId),
      });
    if (!id && method === "GET")
      return json({
        films: store.list(
          scope,
          Number(url.searchParams.get("before") || Number.MAX_SAFE_INTEGER),
          url.searchParams.get("cursor") || "~",
        ),
      });
    if (!id && method === "POST")
      return json(store.create(scope, await body(request, 180000)), 201);
  }
  check(validId(id), "制作卡编号无效。");
  const f = store.card(id);
  check(f, "制作卡不存在。", 404);
  if (!a.native)
    check(
      f.canvas === a.scope!.canvas && f.section === a.scope!.section,
      "制作卡不属于本项目。",
      403,
    );
  else {
    const j = store.held(
      a.runner!,
      request.headers.get("X-Film-Job") ?? "",
      request.headers.get("X-Film-Token") ?? "",
    );
    check(
      j.filmId === id && j.state === "working",
      "制作文件与当前任务不符。",
      403,
    );
    await requireJob(env, j, a.runner!);
    if (method === "GET" || method === "HEAD")
      check(
        [
          ...j.refs,
          ...j.input.inspiration,
          ...(j.input.replaceRef ? [j.input.replaceRef] : []),
        ].some((ref) => store.artifact(id, ref)?.mediaId === mediaId),
        "当前步骤没有选用该素材。",
        403,
      );
    if (method === "PUT")
      check(
        (j.stage === "image" &&
          mediaTypes.has(request.headers.get("Content-Type") || "")) ||
          (j.stage === "deliver" &&
            ["video/mp4", "video/webm"].includes(
              request.headers.get("Content-Type") || "",
            )),
        "当前步骤不能写入此类媒体。",
        403,
      );
  }
  if (!a.native && !action && method === "GET") return json(store.detail(f));
  if (!a.native && action === "revisions" && method === "GET") {
    if (mediaId) {
      const rev = Number(mediaId);
      check(Number.isSafeInteger(rev) && rev > 0, "工作版本号无效。");
      const snapshot = store.revision(f, rev);
      check(snapshot, "未找到这个工作版本。", 404);
      return json(snapshot);
    }
    const before = Number(
      url.searchParams.get("before") || Number.MAX_SAFE_INTEGER,
    );
    check(Number.isSafeInteger(before) && before > 0, "工作版本游标无效。");
    const rows = store.revisions(f.id, before);
    return json({ revisions: rows.slice(0, 50), hasMore: rows.length > 50 });
  }
  if (!a.native && action === "canvas-images") {
    if (method === "GET")
      return json({
        images: (
          await env.DB.prepare(
            "SELECT id,name,mime,byte_length FROM assets WHERE room_id=? AND name LIKE ? ORDER BY created_at DESC,id LIMIT 75",
          )
            .bind(
              f.canvas,
              "%" + (url.searchParams.get("search") || "").slice(0, 120) + "%",
            )
            .all()
        ).results,
      });
    check(method === "POST", "请选择要采用的画布图片。", 405);
    const input = await body(request, 2048);
    check(validId(input.assetId), "画布素材编号无效。");
    const meta = await env.DB.prepare(
      "SELECT id,name,mime,byte_length FROM assets WHERE room_id=? AND id=?",
    )
      .bind(f.canvas, input.assetId)
      .first<{ id: string; name: string; mime: string; byte_length: number }>();
    check(meta && mediaTypes.has(meta.mime), "画布图片不存在。", 404);
    const source = await env.FILES.get(f.canvas + "/" + meta.id);
    check(
      source &&
        source.size === meta.byte_length &&
        source.size <= 16 * 1024 * 1024,
      "画布图片不可读取。",
      409,
    );
    const bytes = await source.arrayBuffer(),
      sum = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    const assetId =
      "canvas-" +
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(meta.id + "-" + sum),
          ),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    const key = "films/" + a.owner + "/" + f.id + "/" + assetId;
    await env.FILES.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: sum,
      httpMetadata: { contentType: meta.mime },
      customMetadata: { sha256: sum },
    });
    const saved = await env.FILES.head(key);
    check(saved?.customMetadata?.sha256 === sum, "画布图片尚未归档。", 409);
    store.addArtifact(
      f.id,
      artifactSchema.parse({
        id: assetId,
        kind: "image",
        title: meta.name.slice(0, 150) || "画布图片",
        mediaId: assetId,
        source: "当前画布",
        details: {
          sha256: sum,
          sourceAssetId: meta.id,
          bytes: source.size,
          mime: meta.mime,
        },
      }),
    );
    return json({ id: assetId });
  }
  if (!a.native && action === "actions" && method === "POST")
    return json(store.act(a.scope!, id, await body(request, 200000)));
  if (!a.native && action === "events" && method === "GET")
    return json({
      events: store.events(id, Number(url.searchParams.get("after")) || 0),
    });
  check(action === "media" && validId(mediaId), "制作接口不存在。", 404);
  const key = `films/${a.owner}/${id}/${mediaId}`;
  if (method === "GET" || method === "HEAD")
    return mediaResponse(request, env, key);
  check(method === "PUT", "媒体请求方式无效。", 405);
  const mime = request.headers.get("Content-Type")?.split(";")[0] ?? "";
  const video = a.native && ["video/mp4", "video/webm"].includes(mime);
  check(mediaTypes.has(mime) || video, "文件类型不受支持。", 415);
  const size = Number(request.headers.get("Content-Length"));
  check(
    request.body &&
      Number.isSafeInteger(size) &&
      size > 0 &&
      size <= (video ? 256 : 16) * 1024 * 1024,
    "文件过大或长度未知。",
    413,
  );
  const file = video
    ? request.body
    : await limitedBytes(request, 16 * 1024 * 1024);
  if (!video)
    check(
      imageSignature(file as Uint8Array, mime),
      "图像内容与类型不符。",
      415,
    );
  const sum = video
    ? request.headers.get("X-Film-Hash")
    : Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            file as Uint8Array<ArrayBuffer>,
          ),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
  check(sum && /^[a-f0-9]{64}$/.test(sum), "缺少文件校验。");
  await env.FILES.put(key, file, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: sum,
    httpMetadata: { contentType: mime },
    customMetadata: { sha256: sum },
  });
  const saved = await env.FILES.head(key);
  check(
    saved?.customMetadata?.sha256 === sum && saved.size === size,
    "该版本已使用。",
    409,
  );
  if (!a.native)
    store.addArtifact(
      id,
      artifactSchema.parse({
        id: mediaId,
        kind: "image",
        title: (url.searchParams.get("name") || "上传图片").slice(0, 150),
        mediaId,
        details: { mime, bytes: size, sha256: sum },
      }),
    );
  return json({ id: mediaId, mime, bytes: size, sha256: sum });
}
