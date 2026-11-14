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
    assert.equal(f.controller.state().status, "downloaded");
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
  assert.equal(f.controller.state().status, "installing");
  assert.equal(f.events.at(-1).status, "installing");
  assert.equal(f.installs(), 0);
  assert.equal(f.controller.state().status, "installing");
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
  for (const url of [
    "https://other.invalid/assets/app.js",
    "http://todo.zky.lol/app",
    "https://todo.zky.lol/api/session",
    "https://todo.zky.lol/assets/%2e%2e%2f%2e%2e%2fsecret",
    "https://todo.zky.lol/assets/a%5cb",
    "https://todo.zky.lol/assets/a%00b",
    "https://todo.zky.lol/assets/%ZZ",
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
