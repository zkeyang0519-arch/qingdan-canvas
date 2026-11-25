import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import path from "node:path";
import { FilmJournal } from "../runner/film/journal.mjs";
import { piWriting } from "../runner/film/writing.mjs";
import { probePi } from "../runner/film/pi-session.mjs";
import { FilmRunner } from "../runner/film/runner.mjs";
import { filmCodexVersions } from "../runner/film/codex.mjs";
import { filmSpecSchema, newFilmJob } from "../shared/agent/film.ts";
test(
  "固定版本 Pi SDK 实际执行工具并把回执交回模型，模拟 DeepSeek 的两轮响应",
  { timeout: 35000 },
  async () => {
    await mkdir(".tmp", { recursive: true });
    const dir = await mkdtemp(path.resolve(".tmp", "film-pi-")),
      journal = new FilmJournal(dir),
      prior = globalThis.fetch;
    let expected = "save_draft",
      transactions = 0;
    const names = [];
    globalThis.fetch = async (url, options) => {
      assert.equal(
        new URL(url instanceof Request ? url.url : url).hostname,
        "api.deepseek.com",
      );
      const data = JSON.parse(options?.body ?? (await url.text())),
        last = data.messages.at(-1);
      names.push(data.tools.map((t) => t.function?.name));
      transactions++;
      const call = last.role !== "tool";
      const code = JSON.stringify(last.content).match(
        /[a-f0-9]{8}-[a-f0-9-]{27}/,
      )?.[0];
      const delta = call
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "cal_" + transactions,
                type: "function",
                function: {
                  name: expected,
                  arguments: JSON.stringify(
                    expected === "save_draft"
                      ? { text: "女孩归还红伞，全片三十秒。" }
                      : {},
                  ),
                },
              },
            ],
          }
        : { role: "assistant", content: code || "稿件已保存。" };
      const chunk = {
        id: "chat-" + transactions,
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-pro",
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      const done = {
        ...chunk,
        choices: [
          { index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" },
        ],
      };
      return new Response(
        "data: " +
          JSON.stringify(chunk) +
          "\n\ndata: " +
          JSON.stringify(done) +
          "\n\ndata: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    try {
      const job = newFilmJob(
          "pi-test",
          "film",
          1,
          filmSpecSchema.parse({
            goal: "draft",
            brief: "车站的红伞",
            title: "红伞",
          }),
        ),
        ctx = {
          job,
          cwd: dir,
          journal,
          env: { DEEPSEEK_API_KEY: "test-offline" },
          signal: AbortSignal.timeout(14000),
          artifacts: [],
          key: "write0",
        };
      const saved = await piWriting(ctx);
      assert.equal(saved.kind, "draft");
      assert.match(saved.artifact.text, /红伞/);
      assert.equal(journal.get("write0:last-tool").name, "save_draft");
      expected = "read_film_brief";
      ctx.job = { ...job, id: "pi-proof", stage: "probe" };
      ctx.key = "proof0";
      const check = await probePi(ctx);
      assert.equal(check.kind, "probe");
      assert.ok(check.session);
      assert.ok(names.every((x) => x.length === 1));
      assert.equal(transactions, 4);
      expected = "generate_reference_image";
      const source = path.join(dir, "source.png");
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=green:s=32x32",
          "-frames:v",
          "1",
          source,
        ],
        { windowsHide: true },
      );
      const rpc = path.join(dir, "client.mjs");
      await build({
        entryPoints: ["runner/codex-client.ts"],
        outfile: rpc,
        platform: "node",
        bundle: true,
        format: "esm",
        logLevel: "silent",
      });
      const { CodexClient } = await import(pathToFileURL(rpc));
      const input = newFilmJob(
        "pi-native-image",
        "film",
        1,
        filmSpecSchema.parse({
          goal: "image",
          brief: "女孩在雨后的车站",
          title: "定妆图",
        }),
      );
      let dispatches = 0,
        report,
        archived;
      const device = new FilmRunner({
        stateDir: dir,
        env: ctx.env,
        connected: () => true,
        resolveWorkspace: async () => ({ root: dir }),
        createCodexClient: () =>
          new CodexClient({
            command: process.execPath,
            args: [path.resolve("tests/fixtures/film-native-codex.mjs"), dir],
            env: { ...process.env, FILM_TEST_CASE: "success" },
            compatibleVersions: filmCodexVersions,
            shutdownTimeoutMs: 100,
          }),
        http: () => assert.fail("单图任务不应向 WAAO 或其他生图服务发送请求"),
        request: async (route, options) => {
          if (options.method === "PUT") {
            archived = Buffer.from(options.body);
            return Response.json({ ok: true });
          }
          const body = JSON.parse(options.body);
          if (route === "codex-turn") {
            if (!body.checkpoint.turnId) dispatches++;
            return Response.json({
              checkpoint: body.checkpoint,
              dispatch: !body.checkpoint.turnId,
            });
          }
          assert.equal(route, "report");
          report = body.result;
          return Response.json({ ok: true });
        },
      });
      const work = {
        job: input,
        token: "lease",
        artifacts: [],
        binding: { workspaceId: "w" },
      };
      await device.process(work, journal, new AbortController());
      assert.equal(report.kind, "image", report.message);
      assert.equal(dispatches, 1);
      assert.deepEqual(archived, await readFile(source));
      assert.equal(report.artifact.details.width, 32);
      assert.ok(report.artifact.details.piSession);
      assert.equal(report.artifact.details.codex.itemId, "native-image");
      assert.deepEqual(names.at(-1).sort(), [
        "generate_reference_image",
        "read_film_context",
      ]);
      assert.equal(transactions, 6);
    } finally {
      globalThis.fetch = prior;
      journal.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);
