import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { forwardInstalledDesktop } from "../desktop/forward-installed.cjs";
import {
  registerDesktopProfile,
  resolveDesktopProfile,
  installedDesktopExecutable,
} from "../desktop/profile-location.cjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.resolve(".tmp/desktop-profile-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    appData: path.join(root, "roaming"),
    local: path.join(root, "local"),
  };
}

test("source registration and packaged upgrades retain the complete existing profile in place", (t) => {
  const f = fixture(t);
  const old = path.join(f.root, "source", ".tmp", "desktop-profile");
  fs.mkdirSync(path.join(old, "IndexedDB"), { recursive: true });
  fs.writeFileSync(path.join(old, "Cookies"), "encrypted-session-fixture");
  fs.writeFileSync(path.join(old, "IndexedDB", "todo"), "pending-todo-fixture");
  const source = resolveDesktopProfile({
    projectRoot: path.join(f.root, "source"),
    appData: f.appData,
    env: {},
  });
  assert.equal(source, old);
  for (let version = 0; version < 3; version++) {
    const packaged = resolveDesktopProfile({
      packaged: true,
      projectRoot: path.join(f.local, `version-${version}`),
      appData: f.appData,
      env: {},
    });
    assert.equal(packaged, old);
    assert.equal(
      fs.readFileSync(path.join(packaged, "Cookies"), "utf8"),
      "encrypted-session-fixture",
    );
    assert.equal(
      fs.readFileSync(path.join(packaged, "IndexedDB", "todo"), "utf8"),
      "pending-todo-fixture",
    );
  }
});

test("a new installation has stable data outside versioned program files and later sources cannot replace it", (t) => {
  const f = fixture(t);
  const expected = path.join(f.appData, "Qingdao", "profile");
  assert.equal(
    resolveDesktopProfile({ packaged: true, appData: f.appData, env: {} }),
    expected,
  );
  assert.equal(
    registerDesktopProfile({
      appData: f.appData,
      profile: path.join(f.root, "other-worktree"),
    }),
    expected,
  );
  assert.equal(
    resolveDesktopProfile({ packaged: true, appData: f.appData, env: {} }),
    expected,
  );
});

test("unavailable or malformed registered profiles fail closed instead of creating a blank account", (t) => {
  const f = fixture(t);
  const old = registerDesktopProfile({
    appData: f.appData,
    profile: path.join(f.root, "old"),
  });
  fs.rmdirSync(old);
  assert.throws(
    () =>
      resolveDesktopProfile({ packaged: true, appData: f.appData, env: {} }),
    /原轻岛数据目录暂时不可用/,
  );
  assert.equal(
    fs.existsSync(path.join(f.appData, "Qingdao", "profile")),
    false,
  );
  fs.writeFileSync(
    path.join(f.appData, "Qingdao", "profile-location.json"),
    '{"version":1,"profile":"../relative"}',
  );
  assert.throws(
    () =>
      resolveDesktopProfile({ packaged: true, appData: f.appData, env: {} }),
    /原轻岛数据目录暂时不可用/,
  );
});

test("explicit QA profiles never alter the user's profile registration", (t) => {
  const f = fixture(t);
  const isolated = path.join(f.root, "qa");
  assert.equal(
    resolveDesktopProfile({
      packaged: true,
      appData: f.appData,
      env: { QINGDAN_DESKTOP_PROFILE: isolated },
    }),
    isolated,
  );
  assert.equal(fs.existsSync(f.appData), false);
});

test("installed executable is a fixed per-user file and source mode can opt out", (t) => {
  const f = fixture(t);
  const executable = path.join(f.local, "Programs", "Qingdao", "Qingdao.exe");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "fixture-executable");
  assert.equal(
    installedDesktopExecutable({ env: { LOCALAPPDATA: f.local } }),
    executable,
  );
  assert.equal(
    installedDesktopExecutable({
      env: { LOCALAPPDATA: f.local, QINGDAN_DESKTOP_SOURCE: "1" },
    }),
    null,
  );
  assert.equal(
    installedDesktopExecutable({ env: { LOCALAPPDATA: "../relative" } }),
    null,
  );
});

test("legacy source bootstrap forwards only descriptor over stdin, while packaged and isolated instances never forward", async (t) => {
  const f = fixture(t);
  const executable = path.join(f.local, "Programs", "Qingdao", "Qingdao.exe");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "fixture");
  const descriptor = {
    version: 1,
    endpoint: "http://127.0.0.1:61234",
    nonce: "c".repeat(64),
  };
  let received = "",
    unreferenced = false;
  const calls = [];
  const args = {
    profile: path.join(f.root, "old-profile"),
    descriptor,
    env: { LOCALAPPDATA: f.local, ELECTRON_RUN_AS_NODE: "1" },
    spawnImpl(file, argv, options) {
      calls.push({ file, argv, options });
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdin.on("data", (chunk) => (received += chunk));
      child.unref = () => {
        unreferenced = true;
      };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  };
  assert.equal(await forwardInstalledDesktop(args), true);
  assert.equal(calls[0].file, executable);
  assert.deepEqual(calls[0].argv, ["--qingdan-desktop-handoff"]);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(calls[0].options.env.QINGDAN_DESKTOP_PROFILE, args.profile);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(unreferenced, true);
  assert.deepEqual(JSON.parse(received), descriptor);
  assert.equal(
    await forwardInstalledDesktop({ ...args, packaged: true }),
    false,
  );
  assert.equal(
    await forwardInstalledDesktop({
      ...args,
      env: { ...args.env, QINGDAN_DESKTOP_PROFILE: args.profile },
    }),
    false,
  );
  assert.equal(calls.length, 1);
});
