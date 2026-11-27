import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createUpdateController } from "../desktop/updates.cjs";
import { readResume, saveResume } from "../desktop/resume-state.cjs";
import { bundledAsset, installBundledWeb } from "../desktop/bundled-web.cjs";

function updateFixture({
  prepare = async () => ({ ok: true, draftsPersisted: true }),
  install,
  runtime,
  previousAttempt,
} = {}) {
  const updater = new EventEmitter();
  const events = [];
  let installs = 0;
  updater.checkForUpdates = async () => {
    updater.emit("checking-for-update");
    updater.emit("update-not-available");
  };
  updater.quitAndInstall = (...args) => {
    installs++;
    assert.deepEqual(args, [true, true]);
  };
  const controller = createUpdateController({
    updater,
    version: "0.3.0",
    prepare,
    runtime,
    previousAttempt,
    install: install || (async (run) => run()),
    changed: (state) => events.push(state),
  });
  return {
    updater,
    controller,
    events,
    installs: () => installs,
    downloaded: () => updater.emit("update-downloaded", { version: "0.4.0" }),
  };
}

function directory(t) {
  const root = fs.mkdtempSync(path.resolve(".tmp/desktop-update-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("an interrupted installer keeps a recovery notice on the old version without reinstalling automatically", async () => {
  const f = updateFixture({
    previousAttempt: {
      status: "installing",
      previousVersion: "0.3.0",
      version: "0.4.0",
    },
  });
  assert.match(f.controller.state().previousError, /上次更新未完成/);
  await f.controller.check();
  assert.match(f.controller.state().previousError, /当前版本/);
  assert.equal(f.installs(), 0);
  f.controller.close();
  const succeeded = updateFixture({
    previousAttempt: {
      status: "installing",
      previousVersion: "0.2.0",
      version: "0.3.0",
    },
  });
  assert.equal(succeeded.controller.state().previousError, "");
  succeeded.controller.close();
});

test("updater downloads automatically but never installs on ordinary quit, failure, or before package verification", async () => {
  const f = updateFixture();
  assert.equal(f.updater.autoDownload, true);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.updater.allowPrerelease, false);
  await assert.rejects(f.controller.install(), /尚未下载完成/);
  await f.controller.check();
  assert.equal(f.controller.state().status, "idle");
  f.updater.emit(
    "error",
    new Error("network failure containing internal path"),
  );
  assert.equal(f.controller.state().status, "error");
  assert.doesNotMatch(JSON.stringify(f.controller.state()), /internal path/);
  assert.equal(f.installs(), 0);
});

test("failed saves and older renderers with volatile input block update without losing the downloaded package", async () => {
  for (const saved of [
    { ok: false },
    { ok: true, hasDraft: true, draftsPersisted: false },
    { ok: true, hasDraft: true },
  ]) {
    const f = updateFixture({ prepare: async () => saved });
    f.downloaded();
    await assert.rejects(f.controller.install(), /保存|重启/);
    assert.equal(f.installs(), 0);
    assert.equal(f.controller.state().status, "error");
    assert.equal(f.controller.state().hasUpdate, true);
  }
  const f = updateFixture({
    prepare: async () => {
      throw Error("disk full");
    },
  });
  f.downloaded();
  await assert.rejects(f.controller.install(), /disk full/);
  assert.equal(f.installs(), 0);
});

test("update waits for durable draft acknowledgment and storage flush, coalesces clicks, then installs once", async () => {
  let save, flush;
  const f = updateFixture({
    prepare: () =>
      new Promise((resolve) => {
        save = resolve;
      }),
    install: (run) =>
      new Promise((resolve) => {
        flush = () => {
          run();
          resolve();
        };
      }),
  });
  f.downloaded();
  const first = f.controller.install(),
    duplicate = f.controller.install();
  assert.equal(first, duplicate);
  assert.equal(f.controller.state().status, "preparing");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.events.at(-1).status, "saving");
  assert.equal(f.installs(), 0);
  assert.equal(f.controller.state().status, "saving");
  save({ ok: true, hasDraft: true, draftsPersisted: true, unsynced: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.installs(), 0);
  flush();
  assert.equal(await first, true);
  assert.equal(f.installs(), 1);
});

test("installation error allows retry without downloading again", async () => {
  let fail = true;
  const f = updateFixture({
    install: async (run) => {
      if (fail) throw Error("flush failed");
      run();
    },
  });
  f.downloaded();
  await assert.rejects(f.controller.install(), /flush failed/);
  assert.equal(f.installs(), 0);
  fail = false;
  await f.controller.install();
  assert.equal(f.installs(), 1);
});

test("scheduled update pauses admissions, waits without interrupting tasks, and cancellation resumes dispatch", async (t) => {
  const log = [];
  let tasks = [{ id: "run-1", label: "正在修改文件" }];
  const f = updateFixture({
    runtime: {
      status: async () => ({ tasks, unknown: [] }),
      pause: async () => {
        log.push("pause");
        return { paused: true };
      },
      resume: async () => {
        log.push("resume");
      },
      checkpoint: async () => {
        log.push("checkpoint");
        return { ok: true };
      },
      stop: async () => {
        log.push("stop");
        return { stopped: true };
      },
    },
    prepare: async () => {
      log.push("save");
      return { ok: true, draftsPersisted: true };
    },
  });
  t.after(() => f.controller.close());
  f.downloaded();
  assert.deepEqual(await f.controller.install(), { scheduled: true });
  assert.equal(f.controller.state().status, "waiting");
  assert.deepEqual(log, ["pause"]);
  await f.controller.cancel();
  assert.equal(f.controller.state().scheduled, false);
  assert.deepEqual(log, ["pause", "resume"]);
  await f.controller.install();
  tasks = [];
  await f.controller.refreshActivity();
  assert.deepEqual(log, [
    "pause",
    "resume",
    "pause",
    "save",
    "checkpoint",
    "stop",
  ]);
  assert.equal(f.installs(), 1);
  await f.controller.install();
  assert.equal(
    f.installs(),
    1,
    "a committed installation cannot be dispatched twice",
  );
});

test("a saved remote receipt can survive update but unknown operations cannot be replayed or force-stopped", async (t) => {
  for (const unknown of [[], ["未知远端投递结果"]]) {
    let stopped = 0;
    const f = updateFixture({
      runtime: {
        status: async () => ({
          tasks: [{ id: "waao-receipt", checkpointedRemote: true }],
          unknown,
        }),
        pause: async () => ({ paused: true }),
        resume: async () => {},
        checkpoint: async () => ({ ok: true }),
        stop: async () => {
          stopped++;
          return { stopped: true };
        },
      },
    });
    t.after(() => f.controller.close());
    f.downloaded();
    if (unknown.length) {
      await assert.rejects(f.controller.install(), /未知|核对/);
      assert.equal(stopped, 0);
      assert.equal(f.installs(), 0);
    } else {
      await f.controller.install();
      assert.equal(f.installs(), 1);
    }
  }
});

test("unconfirmed drain, checkpoint and process exit all keep the current app and verified update package", async (t) => {
  for (const phase of ["pause", "checkpoint", "stop"]) {
    let resumed = 0;
    const runtime = {
      status: async () => ({ tasks: [], unknown: [] }),
      pause: async () => ({ paused: true }),
      checkpoint: async () => ({ ok: true }),
      stop: async () => ({ stopped: true }),
      resume: async () => {
        resumed++;
      },
    };
    runtime[phase] = async () => undefined;
    const f = updateFixture({ runtime });
    t.after(() => f.controller.close());
    f.downloaded();
    await assert.rejects(f.controller.install(), /确认|中止/);
    assert.equal(f.installs(), 0);
    assert.equal(f.controller.state().hasUpdate, true);
    assert.ok(resumed > 0);
  }
});

test("cancel while pausing fences the late pause acknowledgment before any save or install", async (t) => {
  let release;
  const f = updateFixture({
    runtime: {
      status: async () => ({ tasks: [], unknown: [] }),
      pause: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      resume: async () => {},
    },
  });
  t.after(() => f.controller.close());
  f.downloaded();
  const install = f.controller.install();
  await new Promise((resolve) => setImmediate(resolve));
  const cancel = f.controller.cancel();
  release({ paused: true });
  await Promise.all([install, cancel]);
  assert.equal(f.controller.state().status, "downloaded");
  assert.equal(f.installs(), 0);
});

test("download progress comes from the updater; missing totals stay indeterminate", (t) => {
  const f = updateFixture();
  t.after(() => f.controller.close());
  f.updater.emit("download-progress", {
    percent: 42.7,
    total: 100,
    transferred: 42,
  });
  assert.equal(f.controller.state().progress, 42.7);
  f.updater.emit("download-progress", { percent: NaN });
  assert.equal(f.controller.state().progress, null);
});

test("bundled assets are restricted to the production origin and stay within the package web directory", (t) => {
  const root = directory(t);
  assert.equal(
    bundledAsset("https://todo.zky.lol/app?room=room-a", root),
    path.join(root, "index.html"),
  );
  assert.equal(
    bundledAsset("https://todo.zky.lol/assets/app.js", root),
    path.join(root, "assets", "app.js"),
  );
  assert.equal(
    bundledAsset("https://todo.zky.lol/island-releases/v0.3.6.jpg", root),
    path.join(root, "island-releases", "v0.3.6.jpg"),
  );
  assert.equal(
    bundledAsset("https://todo.zky.lol/island/meadow/spring-v3.webp", root),
    path.join(root, "island", "meadow", "spring-v3.webp"),
  );
  for (const url of [
    "https://other.invalid/assets/app.js",
    "http://todo.zky.lol/app",
    "https://todo.zky.lol/api/session",
    "https://todo.zky.lol/assets/%2e%2e%2f%2e%2e%2fsecret",
    "https://todo.zky.lol/assets/a%5cb",
    "https://todo.zky.lol/assets/a%00b",
    "https://todo.zky.lol/assets/%ZZ",
    "https://todo.zky.lol/island-releases/%2e%2e%2f%2e%2e%2fsecret",
    "https://todo.zky.lol/island/%2e%2e%2f%2e%2e%2fsecret",
    "https://todo.zky.lol/island-other/meadow/spring-v3.webp",
  ])
    assert.equal(bundledAsset(url, root), null, url);
});

test("bundled renderer serves matching static files while API requests retain method, cookies and body", async (t) => {
  const root = directory(t);
  fs.writeFileSync(
    path.join(root, "index.html"),
    "<main>packaged renderer</main>",
  );
  let handler;
  const forwarded = [];
  const session = {
    protocol: {
      handle(scheme, fn) {
        assert.equal(scheme, "https");
        handler = fn;
      },
    },
    async fetch(request, options) {
      forwarded.push({ request, options });
      return new Response("network");
    },
  };
  installBundledWeb(session, root);
  fs.mkdirSync(path.join(root, "island-releases"));
  const thumbnail = fs.readFileSync(
    new URL("../public/island-releases/v0.3.6.jpg", import.meta.url),
  );
  fs.writeFileSync(path.join(root, "island-releases", "v0.3.6.jpg"), thumbnail);
  const image = await handler(
    new Request("https://todo.zky.lol/island-releases/v0.3.6.jpg"),
  );
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), thumbnail);
  assert.equal(
    forwarded.length,
    0,
    "release previews must work from the installed package, including offline",
  );
  const page = await handler(
    new Request("https://todo.zky.lol/app?room=room-a"),
  );
  assert.match(await page.text(), /packaged renderer/);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(
    page.headers.get("content-security-policy"),
    /script-src 'self'/,
  );
  assert.equal(forwarded.length, 0);
  for (const request of [
    new Request("https://todo.zky.lol/api/todo", {
      method: "POST",
      headers: {
        cookie: "qd_session=test-session",
        "content-type": "application/json",
      },
      body: '{"id":"todo-a"}',
    }),
    new Request("https://todo.zky.lol/app", {
      method: "POST",
      body: "preserve-post",
    }),
    new Request("https://other.invalid/assets/app.js"),
  ]) {
    assert.equal(await (await handler(request)).text(), "network");
    assert.equal(forwarded.at(-1).request, request);
    assert.deepEqual(forwarded.at(-1).options, {
      bypassCustomProtocolHandlers: true,
    });
  }
  assert.equal(
    forwarded[0].request.headers.get("cookie"),
    "qd_session=test-session",
  );
  assert.equal(await forwarded[0].request.text(), '{"id":"todo-a"}');
  const missing = await handler(
    new Request("https://todo.zky.lol/assets/not-in-this-release.js"),
  );
  assert.equal(missing.status, 404);
  assert.equal(forwarded.length, 3);
});

test("installed seasonal backgrounds load exact WebP bytes with no network, including after a fresh launch", async (t) => {
  const root = directory(t);
  const destination = path.join(root, "island", "meadow");
  fs.mkdirSync(destination, { recursive: true });
  const seasons = ["spring", "summer", "autumn", "winter"];
  for (const season of seasons)
    fs.copyFileSync(
      new URL(`../public/island/meadow/${season}-v3.webp`, import.meta.url),
      path.join(destination, `${season}-v3.webp`),
    );
  for (let launch = 0; launch < 2; launch++) {
    let handler;
    installBundledWeb(
      {
        protocol: { handle: (_, next) => (handler = next) },
        fetch: () => {
          throw Error("Network unavailable: packaged images must stay local");
        },
      },
      root,
    );
    for (const season of seasons) {
      const response = await handler(
        new Request(`https://todo.zky.lol/island/meadow/${season}-v3.webp`),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/webp");
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        fs.readFileSync(path.join(destination, `${season}-v3.webp`)),
      );
    }
    const missing = await handler(
      new Request("https://todo.zky.lol/island/meadow/missing.webp"),
    );
    assert.equal(missing.status, 404);
  }
});

test("resume keeps only trusted origin and valid room, never credentials or transient query fields", (t) => {
  const root = directory(t);
  saveResume(
    root,
    "https://todo.zky.lol/app?room=room-a&token=secret&desktop_handoff=temporary",
  );
  assert.equal(readResume(root), "https://todo.zky.lol/app?room=room-a");
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, "resume.json"), "utf8"),
    /secret|temporary/,
  );
  saveResume(root, "https://todo.zky.lol/app?room=%2Fbad");
  assert.equal(readResume(root), "https://todo.zky.lol/app");
  for (const url of [
    "https://evil.invalid/app",
    "https://user:pass@todo.zky.lol/app",
    "https://todo.zky.lol/other",
    "https://todo.zky.lol/app#secret",
  ])
    assert.throws(() => saveResume(root, url));
  fs.writeFileSync(path.join(root, "resume.json"), "bad-json");
  assert.equal(readResume(root), null);
  fs.writeFileSync(path.join(root, "resume.json"), "{}");
  assert.equal(readResume(root), null);
});
