import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");
const hash = (x) => createHash("sha256").update(x).digest("hex");
test(
  "真实 Worker 在当前项目建卡并派单，保留旧绑定回执，隔离私有媒体",
  { timeout: 90000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const dir = await mkdtemp(path.resolve(".tmp", "film-worker-"));
    let mf;
    t.after(async () => {
      try {
        await mf?.dispose();
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    });
    await build({
      entryPoints: ["worker/index.ts"],
      bundle: true,
      platform: "neutral",
      format: "esm",
      external: ["cloudflare:*", "node:*"],
      conditions: ["workerd", "browser"],
      mainFields: ["module", "main"],
      outfile: path.join(dir, "worker.mjs"),
      logLevel: "silent",
    });
    const options = convertV4MiniflareOptions({
      name: "film-worker",
      port: 0,
      inspectorPort: 0,
      modules: true,
      scriptPath: path.join(dir, "worker.mjs"),
      cf: false,
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      log: new Log(LogLevel.ERROR),
      d1Databases: ["DB"],
      r2Buckets: ["FILES"],
      durableObjects: {
        AGENT_CHATS: { className: "AgentChatRouter", useSQLite: true },
      },
      bindings: {
        APP_ENV: "test",
        RUNNER_ENABLED: "true",
        EXECUTION_ENABLED: "true",
        CHAT_ENABLED: "false",
      },
      outboundService: () => new Response(null, { status: 503 }),
    });
    Object.assign(options, {
      isolatedResourcePersistencePath: path.join(dir, "isolated"),
      resourcePersistencePath: path.join(dir, "state"),
      unsafeEnableSharedStorage: true,
      unsafeDevRegistryPath: path.join(dir, "registry"),
    });
    mf = new Miniflare(options);
    const db = await mf.getD1Database("DB");
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const parts = (await readFile(path.join("migrations", name), "utf8"))
        .replace(/^--.*$/gm, "")
        .split(";")
        .filter((v) => v.trim());
      await db.batch(parts.map((v) => db.prepare(v)));
    }
    const session = "a".repeat(64),
      device = "d".repeat(64);
    await db.batch([
      db.prepare(
        "INSERT INTO accounts(id,username,name,password_hash,created_at) VALUES('alice','alice','Alice','hash','today')",
      ),
      db
        .prepare("INSERT INTO account_sessions VALUES(?,?,?)")
        .bind(hash(session), "alice", Date.now() + 3600000),
      db.prepare(
        "INSERT INTO rooms VALUES('canvas','test','alice','invite','today')",
      ),
      db
        .prepare(
          "INSERT INTO agent_devices(runner_id,owner_id,device_name,secret_hash,workspaces_json,connection_epoch) VALUES('runner','alice','Device','hash',?,1)",
        )
        .bind(JSON.stringify([{ workspaceId: "work", name: "Test" }])),
      db.prepare(
        "INSERT INTO agent_bindings VALUES('binding','alice','canvas','section','runner','work',1,1)",
      ),
      db
        .prepare(
          "INSERT INTO agent_connection_tokens VALUES(?,'runner','runner-connect',1,?)",
        )
        .bind(hash(device), Date.now() + 3600000),
    ]);
    const base = "https://app.test/api/agent/films",
      params = "?canvas=canvas&section=section",
      headers = { Cookie: "qd_session=" + session, "X-QD-Account": "alice" };
    const send = (suffix = "", body, query = params) =>
      mf.dispatchFetch(base + suffix + query, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const parsed = async (r) => {
      const resp = await r,
        raw = await resp.text();
      assert.ok(resp.ok, resp.status + " " + raw);
      return JSON.parse(raw);
    };
    const native = (suffix, body) =>
      parsed(
        mf.dispatchFetch("https://app.test/api/runner/films/" + suffix, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + device,
            "X-Film-Connection": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    const req = {
      requestId: "create",
      spec: { title: "红伞", brief: "女孩归还红伞", goal: "draft" },
    };
    const f = await parsed(send("", req));
    assert.equal((await parsed(send("", req))).id, f.id);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ajpXxsAAAAASUVORK5CYII=",
      "base64",
    );
    const media = base + "/" + f.id + "/media/ref" + params;
    const stored = await mf.dispatchFetch(media, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
      },
      body: png,
    });
    assert.ok(stored.ok, stored.status + " " + (await stored.text()));
    const ranged = await mf.dispatchFetch(media, {
      headers: { ...headers, Range: "bytes=1-4" },
    });
    assert.equal(ranged.status, 206);
    assert.deepEqual(
      Buffer.from(await ranged.arrayBuffer()),
      png.subarray(1, 5),
    );
    assert.equal(
      (await send("/" + f.id, undefined, "?canvas=canvas&section=other"))
        .status,
      403,
    );
    assert.equal(
      (
        await mf.dispatchFetch(media, {
          headers: { ...headers, "X-QD-Account": "other" },
        })
      ).status,
      401,
    );
    const start = await parsed(
      send("/" + f.id + "/actions", {
        action: "start",
        baseRevision: 1,
        requestId: "start",
      }),
    );
    assert.equal(
      (await native("poll", { capabilities: { protocol: 1, services: {} } }))
        .work,
      null,
    );
    const { work } = await native("poll", {
      capabilities: { protocol: 2, services: { deepseek: true } },
    });
    assert.equal(work.job.id, start.jobId);
    assert.deepEqual(
      (await native("poll", { capabilities: { protocol: 1, services: {} } }))
        .work,
      null,
    );
    const receipt = {
      jobId: start.jobId,
      token: work.token,
      result: {
        kind: "draft",
        artifact: {
          id: "draft1",
          kind: "draft",
          title: "稿件",
          text: "完整的短片初稿",
        },
      },
    };
    await native("report", receipt);
    await native("report", receipt);
    const detail = await parsed(send("/" + f.id));
    assert.equal(detail.jobs[0].state, "done");
    assert.equal(detail.card.spec.scriptId, "draft1");
    assert.equal(detail.artifacts.filter((a) => a.kind === "draft").length, 1);
    assert.equal(detail.artifacts.filter((a) => a.kind === "image").length, 1);
    const previousRevision = detail.card.rev;
    const saveWorking = {
      action: "save",
      requestId: "update-working-copy",
      baseRevision: previousRevision,
      spec: { ...detail.card.spec, title: "红伞第二稿", refs: ["ref"] },
    };
    const saved = await parsed(send("/" + f.id + "/actions", saveWorking));
    assert.deepEqual(
      await parsed(send("/" + f.id + "/actions", saveWorking)),
      saved,
    );
    const revisions = "/" + f.id + "/revisions";
    const archived = await parsed(send(revisions + "/" + previousRevision));
    assert.equal(archived.spec.title, "红伞");
    assert.deepEqual(archived.spec.refs, detail.card.spec.refs);
    assert.equal(archived.spec.scriptId, "draft1");
    const latest = await parsed(send(revisions + "/" + saved.revision));
    assert.deepEqual(latest.spec.refs, ["ref"]);
    assert.equal(
      (await parsed(send(revisions))).revisions.filter(
        (row) => row.rev === previousRevision,
      ).length,
      1,
    );
    assert.equal(
      (
        await send(
          revisions + "/" + previousRevision,
          undefined,
          "?canvas=canvas&section=other",
        )
      ).status,
      403,
    );

    const oneClick = { ...req, requestId: "create-and-start", start: true };
    const launched = await parsed(send("", oneClick));
    assert.ok(launched.jobId);
    assert.deepEqual(await parsed(send("", oneClick)), launched);
    const resumed = await parsed(send("/" + launched.id));
    assert.equal(resumed.jobs.length, 1);
    assert.equal(resumed.jobs[0].binding.bindingId, "binding");
    assert.equal(resumed.jobs[0].state, "queued");
    const picture = await parsed(
      send("", {
        requestId: "image-start",
        start: true,
        spec: { ...req.spec, goal: "image" },
      }),
    );
    // Release the earlier one-click draft so that this device can take its picture step.
    await parsed(
      send("/" + launched.id + "/actions", {
        action: "stop",
        jobId: launched.jobId,
        requestId: "stop-draft",
      }),
    );
    const imageWork = (
      await native("poll", {
        capabilities: { protocol: 2, services: { codexImage: true } },
      })
    ).work;
    assert.equal(imageWork.job.id, picture.jobId);
    const held = { jobId: picture.jobId, token: imageWork.token };
    const reservation = {
      threadId: "native-thread",
      requestId: "creative-request",
      model: "fixture-codex",
    };
    assert.equal(
      (await native("codex-turn", { ...held, checkpoint: reservation }))
        .dispatch,
      true,
    );
    const existing = await native("codex-turn", {
      ...held,
      checkpoint: { ...reservation, threadId: "late-thread" },
    });
    assert.equal(existing.dispatch, false);
    assert.equal(existing.checkpoint.threadId, "native-thread");
    await native("codex-turn", {
      ...held,
      checkpoint: { ...reservation, turnId: "native-turn" },
    });
    const imageUrl =
      base.replace("/agent/", "/runner/") +
      "/" +
      picture.id +
      "/media/image-version";
    const out = await mf.dispatchFetch(imageUrl, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + device,
        "X-Film-Connection": "1",
        "X-Film-Job": held.jobId,
        "X-Film-Token": held.token,
        "X-Film-Hash": hash(png),
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
      },
      body: png,
    });
    assert.ok(out.ok, await out.text());
    const imageReceipt = {
      kind: "image",
      key: "reference",
      artifact: {
        kind: "image",
        id: "image-version",
        mediaId: "image-version",
        title: "定妆图",
        source: "Codex 原生生图",
        details: {
          codex: {
            ...reservation,
            turnId: "native-turn",
            itemId: "native-image",
          },
        },
      },
    };
    await assert.rejects(
      native("report", {
        ...held,
        result: {
          ...imageReceipt,
          artifact: { ...imageReceipt.artifact, details: {} },
        },
      }),
      /409/,
    );
    await native("report", { ...held, result: imageReceipt });
    const finished = await parsed(send("/" + picture.id));
    assert.equal(finished.jobs[0].state, "done");
    assert.equal(finished.artifacts[0].details.codex.turnId, "native-turn");
    const gallery = (await parsed(send(""))).films.find(
      (f) => f.id === picture.id,
    ).media;
    assert.deepEqual(gallery, [
      {
        filmId: picture.id,
        id: "image-version",
        title: "定妆图",
        label: "图 1 · 定妆图",
      },
    ]);

    const draft = await parsed(
      send("/" + picture.id + "/actions", {
        action: "import_script",
        requestId: "save-video-script",
        baseRevision: finished.card.rev,
        final: true,
        text: "0–30 秒，跟拍 @图片1。",
        spec: {
          ...finished.card.spec,
          refs: ["image-version"],
          goal: "video",
          direct: true,
        },
      }),
    );
    const video = await parsed(
      send("/" + picture.id + "/actions", {
        action: "start",
        requestId: "render-video",
        baseRevision: draft.revision,
      }),
    );
    const videoWork = (
      await native("poll", {
        capabilities: { protocol: 2, services: { waao: true } },
      })
    ).work;
    assert.equal(videoWork.job.stage, "submit");
    const videoLease = { jobId: video.jobId, token: videoWork.token };
    const submission = {
      scriptId: videoWork.job.adopted,
      node: "video-node",
      prompt: "0–30 秒，跟拍 @图片1。\n\n@图片1　定妆图",
      imports: [
        {
          id: "image-version",
          position: 1,
          assetId: "waao-asset",
          node: "waao-image",
        },
      ],
    };
    await assert.rejects(native("begin-submit", videoLease), /409/);
    await assert.rejects(
      native("begin-submit", {
        ...videoLease,
        submission: { ...submission, imports: [] },
      }),
      /409/,
    );
    await native("begin-submit", { ...videoLease, submission });
    const inProgress = (await parsed(send("/" + picture.id))).jobs.find(
      (j) => j.id === video.jobId,
    );
    assert.deepEqual(inProgress.waaoSubmission, submission);
    assert.equal(inProgress.remote, undefined);
    const accepted = {
      kind: "submit",
      task: "waao-task",
      node: "video-node",
      operation: video.jobId,
    };
    await assert.rejects(
      native("report", {
        ...videoLease,
        result: { ...accepted, node: "other-node" },
      }),
      /409/,
    );
    await native("report", { ...videoLease, result: accepted });
    const polling = (await parsed(send("/" + picture.id))).jobs.find(
      (j) => j.id === video.jobId,
    );
    assert.equal(polling.stage, "poll");
    assert.equal(polling.remote.task, "waao-task");
    assert.deepEqual(polling.waaoSubmission, submission);
  },
);
