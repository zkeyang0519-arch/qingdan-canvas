import test from "node:test";
import { waaoFixture, webEnv, webTarget } from "./fixtures/waao-web-mcp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { FilmJournal } from "../runner/film/journal.mjs";
import { makeImage, inspectMedia } from "../runner/film/media.mjs";
import { submitVideo, checkVideo } from "../runner/film/waao.mjs";
import { filmSpecSchema, newFilmJob } from "../shared/agent/film.ts";
test("真实图片字节交接至 WAAO，验证有序引用、视频解码和30秒原片", async (t) => {
  try {
    execFileSync("ffmpeg", ["-version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    execFileSync("ffprobe", ["-version"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (e) {
    if (e.code === "ENOENT") {
      t.skip("设备未安装媒体解码工具");
      return;
    }
    throw e;
  }
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "film-media-")),
    journal = new FilmJournal(dir);
  try {
    const ff = (...args) =>
      execFileSync("ffmpeg", ["-y", "-v", "error", "-nostdin", ...args], {
        windowsHide: true,
      });
    const png = path.join(dir, "red.png"),
      blueFile = path.join(dir, "blue.png"),
      mp4 = path.join(dir, "film.mp4"),
      short = path.join(dir, "short.mp4");
    ff("-f", "lavfi", "-i", "color=c=red:s=32x32", "-frames:v", "1", png);
    ff("-f", "lavfi", "-i", "color=c=blue:s=32x32", "-frames:v", "1", blueFile);
    ff(
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=32x32:r=12",
      "-t",
      "30",
      "-c:v",
      "mpeg4",
      mp4,
    );
    ff("-i", mp4, "-t", "1", "-c", "copy", short);
    const img = await readFile(png),
      movie = await readFile(mp4),
      signal = AbortSignal.timeout(60000),
      saved = new Map();
    await assert.rejects(inspectMedia(short, true, signal), /时长/);
    const env = webEnv,
      target = webTarget,
      base = { title: "红伞", brief: "女孩在车站还伞", target };
    const media = async (id, options = {}) => {
      if (options.method === "PUT") {
        saved.set(
          id,
          new Blob([options.body], { type: options.headers["Content-Type"] }),
        );
        return Response.json({ ok: true });
      }
      return new Response(saved.get(id), {
        headers: { "Content-Type": saved.get(id).type },
      });
    };
    let imageCalls = 0;
    saved.set("prior", new Blob([img], { type: "image/png" }));
    const pic = newFilmJob(
      "image-job",
      "film",
      1,
      filmSpecSchema.parse({ ...base, goal: "image", inspiration: ["prior"] }),
    );
    const imageContext = {
      key: "image:0",
      job: pic,
      journal,
      env,
      signal,
      media,
      find: (ref) => ({
        id: ref,
        kind: "image",
        mediaId: ref,
        title: "上一版角色参考",
      }),
      http: () => assert.fail("Codex 生图不得直调其他生图服务"),
    };
    const generateReference = async (_ctx, task) => {
      imageCalls++;
      assert.equal(task.kind, "image");
      assert.match(task.instructions, /image_generation/);
      assert.deepEqual(await readFile(task.images[0]), img);
      assert.deepEqual(JSON.parse(task.prompt).参考图顺序, [
        { id: "prior", 名称: "上一版角色参考" },
      ]);
      return {
        bytes: img,
        origin: { threadId: "cx", turnId: "turn", itemId: "img1" },
      };
    };
    await assert.rejects(
      makeImage(imageContext, async () => ({
        bytes: Buffer.from("invalid image"),
        origin: {
          threadId: "invalid-thread",
          turnId: "invalid-turn",
          itemId: "invalid-image",
        },
      })),
      /无法解码/,
    );
    const retry = {
      ...imageContext,
      job: { ...pic, attempt: 1 },
      key: "image:1",
    };
    await assert.rejects(
      makeImage(
        {
          ...retry,
          media: (id, options) =>
            options?.method === "PUT"
              ? new Response(null, { status: 503 })
              : media(id, options),
        },
        generateReference,
      ),
      /等待归档/,
    );
    const result = await makeImage(retry, () =>
      assert.fail("归档重试应复用已生成的原图"),
    );
    assert.equal(result.artifact.details.width, 32);
    assert.equal(result.artifact.source, "Codex 原生生图");
    assert.deepEqual(result.artifact.parents, ["prior"]);
    assert.equal(imageCalls, 1);
    const blue = await readFile(blueFile);
    saved.set("blue", new Blob([blue], { type: "image/png" }));
    let uploadIndex = 0;
    const second = {
        ...result.artifact,
        id: "second",
        mediaId: "blue",
        title: "伞柄",
      },
      script = {
        id: "final",
        kind: "final",
        text: "0–8 秒 @图片1；8–18 秒 @图片2；18–30 秒 @图片1。",
        title: "定稿",
      };
    const artifacts = [second, result.artifact, script],
      refs = [second.id, result.artifact.id];
    const job = newFilmJob(
        "video-job",
        "film",
        2,
        filmSpecSchema.parse({ ...base, goal: "video", direct: true, refs }),
        script,
      ),
      remote = waaoFixture({
        video: movie,
        onUpload: (bytes) =>
          assert.deepEqual(bytes, [blue, img][uploadIndex++]),
      }),
      { nodes, edges } = remote;
    const ctx = {
      key: "video:0",
      job,
      journal,
      env,
      signal,
      media,
      artifacts,
      cloud: async (name, { submission }) => {
        assert.equal(name, "begin-submit");
        assert.equal(submission.prompt, nodes.at(-1).data.prompt);
        assert.equal(submission.scriptId, script.id);
        assert.deepEqual(
          submission.imports.map((i) => i.id),
          refs,
        );
        assert.deepEqual(
          submission.imports.map((i) => [i.position, i.assetId]),
          [
            [1, "up1"],
            [2, "up2"],
          ],
        );
        job.waaoSubmission = submission;
        return { accepted: true };
      },
      find: (id) => artifacts.find((x) => x.id === id),
      http: remote.http,
    };
    const reply = await submitVideo(ctx);
    job.remote = reply;
    assert.equal(remote.submitted, 1);
    assert.equal(edges.length, 2);
    assert.deepEqual(
      nodes.at(-1).data.inputs,
      nodes.slice(0, 2).map((n) => n.node_id),
    );
    assert.equal(nodes.at(-1).data.params.duration, 30);
    assert.match(nodes.at(-1).data.prompt, /@图片1　伞柄/);
    assert.equal((await checkVideo(ctx)).ready, true);
    ctx.key = "video:deliver";
    const delivered = await checkVideo(ctx, true);
    assert.equal(delivered.artifact.details.duration, 30);
    assert.equal(delivered.artifact.details.fps, 12);
    assert.deepEqual(delivered.artifact.parents, [script.id, ...refs]);
    assert.deepEqual(
      Buffer.from(await saved.get(delivered.artifact.mediaId).arrayBuffer()),
      movie,
    );
  } finally {
    journal.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
