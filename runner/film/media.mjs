import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, rename, readFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { artifact, stableId, StageFailure } from "./journal.mjs";
import { nextImage } from "../../shared/agent/film.ts";
import { runFilmCodex } from "./codex.mjs";
const run = promisify(execFile);
class InvalidFilmMedia extends Error {}

function decodeError(error, tool, message) {
  if (error.code === "ENOENT")
    return Error("此设备需要 " + tool + " 验证媒体。");
  if (typeof error.code === "number" && !error.killed)
    return new InvalidFilmMedia(message);
  return error;
}
export async function inspectMedia(file, video, signal) {
  const opts = { windowsHide: true, timeout: 45000, maxBuffer: 200000, signal };
  let out;
  try {
    out = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height,duration,avg_frame_rate:format=format_name,duration",
        "-of",
        "json",
        file,
      ],
      opts,
    );
  } catch (e) {
    throw decodeError(e, "ffprobe", "无法解码所返回的媒体文件。");
  }
  const info = JSON.parse(out.stdout),
    stream = info.streams?.[0];
  if (
    !stream?.width ||
    !stream?.height ||
    stream.width * stream.height > 80000000
  )
    throw new InvalidFilmMedia("媒体缺少有效画面或尺寸过大。");
  const formats = String(info.format?.format_name || "").split(",");
  if (!video && !["png", "mjpeg", "webp", "gif"].includes(stream.codec_name))
    throw new InvalidFilmMedia("不支持的参考图类型。");
  if (video && !formats.some((f) => ["mp4", "webm", "matroska"].includes(f)))
    throw Error("成片不是可播放的 MP4 或 WebM。");
  let decoded;
  try {
    decoded = await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-xerror",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        file,
        "-map",
        "0:v:0",
        ...(video ? ["-progress", "pipe:1"] : ["-frames:v", "1"]),
        "-f",
        "null",
        "-",
      ],
      { ...opts, timeout: video ? 180000 : 45000 },
    );
  } catch (e) {
    throw decodeError(e, "ffmpeg", "媒体文件未能完整解码。");
  }
  if (!video)
    return {
      width: stream.width,
      height: stream.height,
      mime: {
        png: "image/png",
        mjpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
      }[stream.codec_name],
    };
  const [n, d] = String(stream.avg_frame_rate).split("/").map(Number),
    fps = n / d,
    duration = Number(stream.duration || info.format.duration);
  if (
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isFinite(duration) ||
    Math.abs(duration - 30) > 1 / fps + 0.0001
  )
    throw Error(
      "成片时长待核对，实测 " +
        (Number.isFinite(duration) ? duration + " 秒" : "未知") +
        "，目标 30 秒。",
    );
  const containerDuration = Number(info.format.duration);
  if (
    Number.isFinite(containerDuration) &&
    Math.abs(containerDuration - 30) > 1 / fps + 0.0001
  )
    throw Error(
      "整个媒体文件的时长为 " + containerDuration + " 秒，请核对声音与画面。",
    );
  const end =
    Number([...decoded.stdout.matchAll(/^out_time_us=(\d+)$/gm)].at(-1)?.[1]) /
    1000000;
  if (!Number.isFinite(end) || Math.abs(end - 30) > 1 / fps + 0.0001)
    throw Error("成片画面未能解码到 30 秒结尾。");
  return {
    width: stream.width,
    height: stream.height,
    fps,
    duration,
    mime: formats.includes("mp4") ? "video/mp4" : "video/webm",
  };
}
export async function writeBytes(ctx, id, bytes) {
  const dir = join(ctx.journal.dir, "media");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, id),
    tmp = file + ".part";
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, file);
  return file;
}
export async function boundedBytes(response, limit) {
  if (!response.ok || !response.body)
    throw Error("读取媒体失败（HTTP " + response.status + "）。");
  const reader = response.body.getReader();
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw Error("媒体文件超过允许的大小。");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw Error("媒体文件为空。");
  return Buffer.concat(parts, size);
}
export async function mediaInput(ctx, id) {
  const ref = ctx.find(id);
  if (ref.kind !== "image" || !ref.mediaId) throw Error("参考图文件未就绪。");
  const res = await ctx.media(ref.mediaId);
  return {
    mime: res.headers.get("content-type"),
    bytes: await boundedBytes(res, 16 * 1024 * 1024),
  };
}
export async function archive(ctx, id, file, video) {
  const info = await inspectMedia(file, video, ctx.signal),
    size = (await stat(file)).size;
  if (size > (video ? 256 : 16) * 1024 * 1024)
    throw Error("媒体超过归档大小限制。");
  const bytes = await readFile(file),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const response = await ctx.media(id, {
    method: "PUT",
    headers: {
      "Content-Type": info.mime,
      "Content-Length": String(size),
      "X-Film-Hash": sha256,
    },
    body: bytes,
  });
  if (!response.ok)
    throw new StageFailure(
      "原文件已保存在本机，等待归档（HTTP " + response.status + "）。",
      { temporary: response.status >= 500 },
    );
  return { ...info, bytes: size, sha256 };
}
export async function makeImage(ctx, codex = runFilmCodex) {
  const { job, env, journal } = ctx,
    need = nextImage(job);
  if (!need) throw Error("没有可生成的素材项。");
  const model = env.QINGDAN_GEMINI_IMAGE_MODEL;
  const native = job.workflowVersion === 2;
  if (!native && (!env.GEMINI_API_KEY || !model))
    throw Error(
      "请配置 GEMINI_API_KEY 和图像模型 QINGDAN_GEMINI_IMAGE_MODEL。",
    );
  const id = stableId(ctx.key, "image"),
    checkpoint = job.id + (native ? ":codex-image:" : ":image:") + job.step;
  let state = journal.get(checkpoint);
  const parents = [
    ...new Set([
      ...need.dependsOn.map((k) => job.mapped[k]),
      ...job.input.inspiration,
      ...(job.input.goal === "image"
        ? job.input.replaceRef
          ? [job.input.replaceRef]
          : job.input.refs
        : native
          ? job.input.refs
          : []),
    ]),
  ];
  if (native && !state?.file) {
    const images = [];
    const mimeExt = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    };
    for (const ref of parents) {
      const { bytes, mime } = await mediaInput(ctx, ref);
      const ext = mimeExt[mime];
      if (!ext) throw Error("所选上游文件不是可交给 Codex 的参考图。");
      images.push(
        await writeBytes(
          ctx,
          stableId(job.id, "reference", ref) + "." + ext,
          bytes,
        ),
      );
    }
    const reply = await codex(ctx, {
      kind: "image",
      instructions:
        "你负责为短片生成一张静态参考图。必须实际使用 Codex 原生 image_generation 工具。使用附带的参考图保持角色及物件一致。仅生成一张图，交付原生图片产物。",
      prompt: JSON.stringify({
        用途: need.name,
        画面: need.description,
        镜头: need.shots,
        画幅: job.input.ratio,
        角色设定: job.input.character,
        风格: job.input.style,
        参考图顺序: parents.map((ref) => ({
          id: ref,
          名称: ctx.find(ref).title,
        })),
      }),
      images,
    });
    const file = await writeBytes(ctx, id, reply.bytes);
    state = journal.put(checkpoint, { file, id, origin: reply.origin });
  } else if (!state?.file) {
    if (state?.dispatched || job.checkOnly)
      throw new StageFailure(
        "Gemini 可能已经受理，未取得可恢复的原图。可核对此次调用，或明确开始新的制作版本。",
        { uncertain: true },
      );
    const parts = [
      {
        text: [
          need.description,
          job.input.character,
          job.input.style,
          "生成用于分镜的单张静态参考图，画幅 " + job.input.ratio,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];
    for (const ref of parents) {
      const a = await mediaInput(ctx, ref);
      parts.push({
        inlineData: { mimeType: a.mime, data: a.bytes.toString("base64") },
      });
    }
    journal.put(checkpoint, { dispatched: true });
    let res, data;
    try {
      res = await ctx.http(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) +
          ":generateContent",
        {
          method: "POST",
          redirect: "error",
          signal: ctx.signal,
          headers: {
            "x-goog-api-key": env.GEMINI_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
              imageConfig: { aspectRatio: job.input.ratio },
            },
          }),
        },
      );
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500 && res.status !== 408) {
          journal.put(checkpoint, { dispatched: false });
          throw Error(
            "Gemini 返回 HTTP " + res.status + "，请检查模型、授权和额度。",
          );
        }
        throw new StageFailure(
          "Gemini 受理状态待核对（HTTP " + res.status + "）。",
          { uncertain: true },
        );
      }
      data = await res.json();
    } catch (e) {
      if (res && !res.ok) throw e;
      throw new StageFailure("未取得完整的 Gemini 回执，请核对原调用。", {
        uncertain: true,
      });
    }
    const image = data.candidates
      ?.flatMap((c) => c.content?.parts || [])
      .map((p) => p.inlineData || p.inline_data)
      .find((d) => d?.data);
    if (!image || image.data.length > 24 * 1024 * 1024) {
      journal.put(checkpoint, { dispatched: false });
      throw Error("Gemini 未返回可归档的图片。");
    }
    const file = await writeBytes(ctx, id, Buffer.from(image.data, "base64"));
    state = journal.put(checkpoint, { file, id });
  }
  let details;
  try {
    details = await archive(ctx, state.id, state.file, false);
  } catch (error) {
    if (native && error instanceof InvalidFilmMedia)
      journal.put(checkpoint, null);
    throw error;
  }
  return {
    kind: "image",
    key: need.key,
    artifact: artifact(
      ctx,
      "image",
      need.name,
      "",
      native ? "Codex 原生生图" : "Gemini / " + model,
      {
        mediaId: state.id,
        parents,
        details: {
          ...details,
          ...(native ? { codex: state.origin } : {}),
          description: need.description,
          shots: need.shots,
          key: need.key,
        },
      },
    ),
  };
}
