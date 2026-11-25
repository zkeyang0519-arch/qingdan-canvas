import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { waaoFixture, webEnv } from "./fixtures/waao-web-mcp.mjs";

test("本机对话在重启后按图号交接定稿与原图，重复请求沿用回执，另一聊天不能引用", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "pi-chat-tools-"));
  const file = path.join(dir, "tools.mjs");
  await build({
    entryPoints: ["scripts/pi-local/tools.mjs"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    outfile: file,
    logLevel: "silent",
  });
  const { openTools, webWaao } = await import(pathToFileURL(file));
  const remote = waaoFixture();
  const waao = webWaao({ token: async () => null }, webEnv, remote.http);
  let tools = openTools(dir, true, waao);
  t.after(async () => {
    tools.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const call = async (scope, name, args) => {
    const response = await tools.fetch(
      new Request("https://tools.internal/execute", {
        method: "POST",
        body: JSON.stringify({ scope, name, args }),
      }),
    );
    return { status: response.status, result: await response.json() };
  };
  const first = {
    accountId: "pi-local",
    bindingId: "pi-local-binding",
    chatId: "a",
    userMessageId: "u1",
    visible: [],
  };
  const draft = await call(first, "codex", {
    action: "revise",
    brief: "雨后站台的红伞。",
  });
  assert.equal(draft.status, 200);
  const pair = await call(first, "codex", {
    action: "images",
    brief: "白天、夜间",
    count: 2,
    draftId: draft.result.id,
  });
  assert.equal(pair.status, 200);
  const [a, b] = pair.result.images;
  const digest = async (id) =>
    createHash("sha256")
      .update((await tools.image(id)).bytes)
      .digest("hex");
  assert.notEqual(await digest(a.id), await digest(b.id));
  const next = { ...first, userMessageId: "u2", visible: ["u1"] };
  const args = { action: "submit", assetId: b.id, draftId: draft.result.id };
  assert.match((await call(next, "waao", args)).result.error, /连接 WAAO/);
  assert.equal(remote.calls.length, 0);
  tools.close();
  tools = openTools(
    dir,
    true,
    webWaao({ token: async () => "fixture" }, webEnv, remote.http),
  );
  assert.deepEqual(tools.references(next), [
    { id: draft.result.id, label: draft.result.label },
    a,
    b,
  ]);
  assert.deepEqual(tools.references({ ...next, chatId: "other" }), []);
  assert.throws(
    () => tools.references({ ...next, accountId: "other" }),
    /无权/,
  );
  const submitted = await call(next, "waao", args);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.result));
  assert.equal(submitted.result.sha256, await digest(b.id));
  assert.equal(submitted.result.assetLabel, b.label);
  assert.ok(submitted.result.prompt.includes(draft.result.text));
  assert.match(submitted.result.prompt, /@图片1\s+第 1 组 · 图 2/);
  assert.equal(submitted.result.id, "real-protocol-task");
  assert.deepEqual(remote.uploads[0].bytes, (await tools.image(b.id)).bytes);
  const replay = await call(next, "waao", {
    draftId: args.draftId,
    assetId: b.id,
    action: "submit",
  });
  assert.deepEqual(replay, submitted);
  assert.equal(
    (await call(next, "waao", { ...args, assetId: a.id })).status,
    422,
  );
  assert.equal(
    (await call({ ...next, chatId: "b" }, "waao", args)).status,
    422,
  );
  const message = tools.decorate({
    role: "assistant",
    chatId: "a",
    replyTo: "u2",
  });
  assert.deepEqual(message.piActions, ["waao.submit"]);
  assert.deepEqual(message.submission, submitted.result);
  assert.equal(
    (
      await call(
        { ...next, userMessageId: "u3", visible: ["u1", "u2"] },
        "waao",
        args,
      )
    ).result.id,
    submitted.result.id,
  );
  assert.equal(remote.submitted, 1);
  assert.equal(
    (
      await call(
        { ...next, userMessageId: "u4", visible: ["u1", "u2"] },
        "waao",
        { action: "status", receiptId: submitted.result.id },
      )
    ).result.status,
    "running",
  );
  assert.equal(
    await tools.taskStatus(
      submitted.result.id,
      "another-chat",
      new AbortController().signal,
    ),
    null,
  );
  assert.equal(
    (
      await tools.taskStatus(
        submitted.result.id,
        "a",
        new AbortController().signal,
      )
    ).id,
    submitted.result.id,
  );
  assert.equal(remote.submitted, 1);
});
