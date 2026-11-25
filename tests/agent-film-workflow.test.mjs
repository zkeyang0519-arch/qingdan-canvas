import { waaoFixture, webEnv, webTarget } from "./fixtures/waao-web-mcp.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { FilmRunner } from "../runner/film/runner.mjs";
import { FilmJournal, stableId } from "../runner/film/journal.mjs";
import { compilePrompt, submitVideo } from "../runner/film/waao.mjs";
import { directWriting } from "../runner/film/writing.mjs";
import {
  filmSpecSchema,
  applyFilmResult,
  newFilmJob,
  validFilmPlan,
} from "../shared/agent/film.ts";

const spec = (overrides = {}) =>
  filmSpecSchema.parse({
    title: "车站的红伞",
    brief: "女孩归还红伞",
    goal: "prompt",
    ...overrides,
  });
const item = (kind, id = kind) => ({
  kind,
  id,
  title: id,
  text: "完整稿件",
  source: "fixture",
  parents: [],
  details: {},
  ...(["image", "video"].includes(kind) ? { mediaId: id } : {}),
});
test("四种目标、五岗全文和质检、定稿直出、换图只修改新版", () => {
  let j = newFilmJob("j", "film", 1, spec());
  j = applyFilmResult(j, { kind: "draft", artifact: item("draft") });
  for (let i = 0; i < 5; i++) {
    assert.equal(j.stage, "director");
    j = applyFilmResult(j, {
      kind: "director",
      artifact: item("director", "d" + i),
    });
  }
  assert.equal(j.stage, "review");
  assert.equal(
    applyFilmResult(j, {
      kind: "review",
      passed: false,
      artifact: item("review"),
    }).state,
    "blocked",
  );
  j = applyFilmResult(j, {
    kind: "review",
    passed: true,
    artifact: item("final"),
  });
  assert.equal(j.state, "done");
  assert.equal(j.adopted, "final");
  const draft = newFilmJob("d", "f", 1, spec({ goal: "draft" }));
  assert.equal(
    applyFilmResult(draft, { kind: "draft", artifact: item("draft") }).state,
    "done",
  );
  const direct = newFilmJob(
    "v",
    "f",
    2,
    spec({ goal: "video", refs: ["a", "b"], direct: true }),
    item("final"),
  );
  assert.equal(direct.stage, "submit");
  assert.throws(() =>
    applyFilmResult(direct, {
      kind: "image",
      key: "ref",
      artifact: item("image"),
    }),
  );
  const image = newFilmJob(
    "i",
    "f",
    3,
    spec({ goal: "image", refs: ["a", "b"], replaceRef: "b" }),
  );
  assert.deepEqual(
    applyFilmResult(image, {
      kind: "image",
      key: "reference",
      artifact: item("image", "b2"),
    }).refs,
    ["a", "b2"],
  );
  assert.deepEqual(direct.refs, ["a", "b"]);
  assert.equal(
    validFilmPlan(
      [
        { key: "a", dependsOn: ["b"] },
        { key: "b", dependsOn: ["a"] },
      ],
      [],
    ),
    false,
  );
  assert.throws(() => compilePrompt("@图片10", ["a"], [], {}, []));
  assert.match(
    compilePrompt(
      "原文",
      ["a", "b"],
      [{ key: "hero", name: "女孩持伞", shots: ["镜1", "镜3"] }],
      { hero: "a" },
      [],
    ),
    /@图片1　女孩持伞（镜1、镜3）/,
  );
});
async function scratch(t) {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "film-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("制作卡事务跨刷新去重，旧回执归旧版，停止动作保护已提交的视频", async (t) => {
  const dir = await scratch(t),
    output = path.join(dir, "store.mjs");
  await build({
    entryPoints: ["worker/agent/film-store.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { FilmStore } = await import(pathToFileURL(output));
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = {
    exec(query, ...args) {
      if (query.includes("CREATE TABLE")) {
        db.exec(query);
        return;
      }
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  const store = new FilmStore(sql, (fn) => {
    db.exec("BEGIN");
    try {
      const x = fn();
      db.exec("COMMIT");
      return x;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
  const binding = {
      ownerId: "alice",
      runnerId: "r",
      authEpoch: 1,
      bindingId: "b",
      bindingRevision: 1,
      workspaceId: "w",
    },
    scope = { canvas: "c", section: "s", binding };
  const request = { requestId: "one", spec: spec({ goal: "draft" }) },
    card = store.create(scope, request);
  assert.throws(() =>
    store.create(
      { ...scope, binding: null },
      {
        ...request,
        requestId: "unbound-start",
        start: true,
      },
    ),
  );
  assert.equal(store.list(scope, Number.MAX_SAFE_INTEGER, "~").length, 1);
  assert.deepEqual(store.create(scope, request), card);
  assert.throws(() => store.create(scope, { ...request, spec: spec() }));
  const start = { requestId: "start", baseRevision: 1, action: "start" };
  const first = store.act(scope, card.id, start);
  assert.equal(
    store.act(scope, card.id, { ...start, requestId: "two-click" }).jobId,
    first.jobId,
  );
  const work = store.claim(first.jobId, "r");
  assert.ok(work);
  assert.equal(store.claim(first.jobId, "r"), null);
  const changed = store.act(scope, card.id, {
    action: "import_script",
    requestId: "import",
    baseRevision: 2,
    text: "已采用的用户成片稿",
    final: true,
  });
  const second = store.act(scope, card.id, {
    action: "start",
    requestId: "new",
    baseRevision: changed.revision,
    spec: { ...store.card(card.id).spec, goal: "video", direct: true },
  });
  store.report("r", first.jobId, work.token, {
    kind: "draft",
    artifact: item("draft", "old"),
  });
  assert.notEqual(store.card(card.id).spec.scriptId, "old");
  const active = store.claim(second.jobId, "r");
  store.beginSubmit("r", second.jobId, active.token, {
    scriptId: active.job.adopted,
    prompt: "已采用的用户成片稿",
    node: "node",
    imports: [],
  });
  store.act(scope, card.id, {
    action: "stop",
    requestId: "stop",
    jobId: second.jobId,
  });
  store.report("r", second.jobId, active.token, {
    kind: "submit",
    node: "node",
    operation: second.jobId,
    task: "platform",
  });
  assert.equal(store.job(second.jobId).stage, "poll");
  assert.ok(store.job(second.jobId).stopped);
  assert.throws(() =>
    store.act({ ...scope, section: "other" }, card.id, {
      action: "start",
      requestId: "x",
      baseRevision: 4,
    }),
  );
  assert.equal(store.detail(store.card(card.id)).jobs.length, 2);
  const image = store.create(scope, {
    requestId: "retry-image",
    start: true,
    spec: spec({ goal: "image" }),
  });
  const claimImage = () => store.claim(image.jobId, "r");
  const command = (action) =>
    store.act(scope, image.id, {
      requestId: "image-" + action,
      action,
      jobId: image.jobId,
    });
  store.report("r", image.jobId, claimImage().token, {
    kind: "error",
    message: "等待 Codex 回执",
    uncertain: true,
  });
  command("reconcile");
  const reconciling = claimImage();
  assert.equal(reconciling.job.checkOnly, true);
  store.report("r", image.jobId, reconciling.token, {
    kind: "error",
    message: "已确认原生图轮次失败",
  });
  command("retry");
  const retry = claimImage();
  assert.equal(retry.job.attempt, 1);
  assert.equal(retry.job.checkOnly, false);
  assert.equal(
    store.codexCheckpoint("r", image.jobId, retry.token, {
      threadId: "replacement-thread",
      requestId: "replacement-request",
    }).dispatch,
    true,
  );
});
test("Runner 重启重发已保存的成功回执，媒体服务不被重复调用", async (t) => {
  const dir = await scratch(t),
    j = newFilmJob("j", "f", 1, spec({ goal: "draft" })),
    work = {
      job: j,
      artifacts: [],
      token: "one",
      binding: { workspaceId: "w" },
    };
  let calls = 0,
    reports = 0;
  const runner = new FilmRunner({
    request: async () => {
      reports++;
      if (reports === 1) throw Error("模拟回执丢失");
      return Response.json({ ok: true });
    },
    stateDir: dir,
    connected: () => true,
    resolveWorkspace: async () => ({ root: dir }),
    execute: async () => {
      calls++;
      return { kind: "draft", artifact: item("draft") };
    },
  });
  let journal = new FilmJournal(dir);
  try {
    await assert.rejects(runner.process(work, journal, new AbortController()));
  } finally {
    journal.close();
  }
  journal = new FilmJournal(dir);
  try {
    await runner.process(
      { ...work, token: "two" },
      journal,
      new AbortController(),
    );
  } finally {
    journal.close();
  }
  assert.equal(calls, 1);
  assert.equal(reports, 2);
});
test("Codex 逐岗接收全文并改提示词，独立质检会拦截缺失的时间段", async () => {
  const text = [
    "【全局角色锚定】",
    "女孩，手持红伞。",
    "场景：雨后的站台。",
    "【运镜铁律（全局）】",
    "1. 跟随女孩寻找失主。",
    "【声音设定（全局）】",
    "保留脚步与报站声。",
    "═══ 分镜1｜归还红伞（0-30秒）═══",
    "0-30秒：女孩把伞交还给失主。",
    "镜头：中景固定观察交接，停在两人手中的红伞。",
    "***",
    "【音效与氛围（全局）】",
    "细雨声。",
    "【负面提示词】",
    "避免人物变形。",
  ].join("\n");
  const original = item("draft"),
    items = [original];
  let job = newFilmJob("director-job", "f", 1, spec(), original),
    calls = 0;
  const invoke = () =>
    directWriting(
      {
        job,
        key: "stage" + calls,
        env: {},
        signal: new AbortController().signal,
        find: (id) => items.find((a) => a.id === id),
        http: () => assert.fail("新版本应当把改稿交给 Codex"),
      },
      async (_ctx, task) => {
        assert.equal(task.kind, "text");
        assert.match(task.instructions, /当前节点/);
        const input = JSON.parse(task.prompt);
        assert.equal(
          input.current_draft,
          calls === 0 ? original.text : items.at(-1).text,
        );
        calls++;
        const content =
          job.stage === "review"
            ? { passed: true, issues: [] }
            : {
                draft: text,
                genre_id: "narrative",
                changes: [{ location: "镜头", reason: "校核动作" }],
                issues: [],
              };
        return {
          text: JSON.stringify(content),
          origin: {
            threadId: "director-" + calls,
            turnId: "turn",
            model: "mock-codex",
          },
        };
      },
    );
  for (let i = 0; i < 5; i++) {
    const output = await invoke();
    assert.match(output.artifact.source, /Codex/);
    assert.equal(output.artifact.details.codex.threadId, "director-" + calls);
    items.push(output.artifact);
    job = applyFilmResult(job, output);
  }
  let review = await invoke();
  assert.equal(review.passed, true, review.artifact.text);
  const last = items.at(-1);
  last.text = last.details.output.draft = last.text.replaceAll("0-30", "1-30");
  review = await invoke();
  assert.equal(review.passed, false);
  assert.match(review.artifact.text, /连续覆盖|空档/);
  assert.equal(calls, 7);
});
test("WAAO 提交回包丢失后只查原操作，平台只受理一次", async (t) => {
  const dir = await scratch(t),
    journal = new FilmJournal(dir);
  try {
    const env = webEnv,
      target = webTarget;
    const job = newFilmJob(
      "waao-job",
      "f",
      1,
      spec({ goal: "video", target, direct: true }),
      item("final"),
    );
    const remote = waaoFixture({
      onGenerate(args) {
        assert.equal(args.idempotency_key, job.id);
        throw Error("response lost");
      },
    });
    const ctx = {
      env,
      job,
      journal,
      artifacts: [],
      cloud: async () => ({ accepted: true }),
      find: () => item("final"),
      signal: new AbortController().signal,
      http: remote.http,
    };
    await assert.rejects(submitVideo(ctx), (e) => e.uncertain === true);
    const recovered = await submitVideo(ctx);
    assert.equal(recovered.task, "real-protocol-task");
    assert.equal(remote.nodes.length, 1);
    assert.equal(remote.submitted, 1);
  } finally {
    journal.close();
  }
});
