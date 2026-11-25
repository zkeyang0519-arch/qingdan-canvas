import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { FilmJournal } from "../runner/film/journal.mjs";
import {
  filmCodexVersions,
  inspectFilmCodex,
  runFilmCodex,
} from "../runner/film/codex.mjs";

test("原生 Codex 轮次交回改稿和实际图片，丢失启动回执后只恢复同一轮", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "film-native-"));
  const journal = new FilmJournal(dir);
  t.after(async () => {
    journal.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const bundled = path.join(dir, "client.mjs");
  await build({
    entryPoints: ["runner/codex-client.ts"],
    outfile: bundled,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { CodexClient } = await import(pathToFileURL(bundled));
  const file = path.join(dir, "source.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ajpXxsAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(file, png);
  const proc = {
    command: process.execPath,
    args: [path.resolve("tests/fixtures/film-native-codex.mjs"), dir],
    compatibleVersions: filmCodexVersions,
    shutdownTimeoutMs: 100,
  };
  assert.deepEqual(await inspectFilmCodex(proc), {
    codexText: true,
    codexImage: true,
  });
  const reserved = new Map();
  function context(id, scenario) {
    const job = { id, step: 1, attempt: 0 };
    return {
      key: id + ":1:0",
      job,
      journal,
      cwd: dir,
      signal: AbortSignal.timeout(25000),
      env: {},
      createCodexClient: () =>
        new CodexClient({
          ...proc,
          env: { ...process.env, FILM_TEST_CASE: scenario },
        }),
      cloud: async (route, { checkpoint }) => {
        assert.equal(route, "codex-turn");
        const prior = reserved.get(id);
        if (prior && !checkpoint.turnId)
          return { checkpoint: prior, dispatch: false };
        const saved = { ...checkpoint, step: 1, attempt: 0 };
        reserved.set(id, saved);
        return { checkpoint: saved, dispatch: !prior };
      },
    };
  }
  const text = await runFilmCodex(context("words", "text"), {
    kind: "text",
    instructions: "改稿",
    prompt: "初稿",
  });
  assert.equal(text.text, "正式稿件");
  const picture = {
    kind: "image",
    instructions: "出单张图",
    prompt: "持伞",
    images: [file],
  };
  await assert.rejects(
    runFilmCodex(context("img", "lose-ack"), picture),
    (e) => e.uncertain === true,
  );
  const before = JSON.parse(
    await readFile(path.join(dir, "native.json"), "utf8"),
  );
  assert.deepEqual(before.inputs, ["持伞", png.toString("base64")]);
  const recovery = context("img", "success");
  recovery.job.codexTurn = reserved.get("img");
  recovery.job.checkOnly = true;
  const result = await runFilmCodex(recovery, picture);
  assert.deepEqual(result.bytes, png);
  assert.equal(result.origin.itemId, "native-image");
  assert.equal(result.origin.generationId, "ig-1");
  assert.equal(result.origin.turnId, reserved.get("img").turnId);
  assert.equal(
    JSON.parse(await readFile(path.join(dir, "native.json"), "utf8"))
      .turnsStarted,
    before.turnsStarted,
  );
  await assert.rejects(
    runFilmCodex(context("bad", "text-only"), picture),
    /原生生图回执/,
  );
  await assert.rejects(
    runFilmCodex(context("outside", "outside"), picture),
    /生成目录/,
  );
});
