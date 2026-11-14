import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

let createDesktopLauncher;
try {
  ({ createDesktopLauncher } =
    await import("../scripts/lib/desktop-launcher.mjs"));
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

async function fixture(t, { installed = true, behavior, ...options } = {}) {
  await mkdir(new URL("../.tmp/", import.meta.url), { recursive: true });
  const projectRoot = await mkdtemp(
    new URL("../.tmp/desktop-launcher-", import.meta.url),
  );
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const electronDirectory = path.join(projectRoot, "node_modules", "electron");
  await mkdir(path.join(electronDirectory, "dist"), { recursive: true });
  await writeFile(
    path.join(electronDirectory, "install.js"),
    "// fixture installer\n",
  );
  const runtime = path.join(electronDirectory, "dist", "electron.exe");
  const install = () => {
    fs.writeFileSync(
      path.join(electronDirectory, "path.txt"),
      "electron.exe\n",
    );
    fs.writeFileSync(runtime, "fixture runtime");
  };
  if (installed) install();
  const calls = [],
    closed = [],
    statuses = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.unref = () => {
      child.unreferenced = true;
    };
    const call = { executable, args, options, child };
    calls.push(call);
    behavior?.({ call, install });
    return child;
  };
  let time = 100;
  const env = {
    QINGDAN_DESKTOP_PROFILE: path.join(projectRoot, "my desktop profile"),
    QINGDAN_DESKTOP_URL: "http://127.0.0.1:61111/app",
    ELECTRON_RUN_AS_NODE: "1",
    PATH: "fixture-path",
  };
  assert.equal(typeof createDesktopLauncher, "function");
  const launcher = createDesktopLauncher({
    projectRoot,
    electronDirectory,
    spawnImpl,
    nodePath: path.join(projectRoot, "node.exe"),
    env,
    fsImpl: {
      ...fs,
      closeSync(fd) {
        closed.push(fd);
        return fs.closeSync(fd);
      },
    },
    onStatus: (text) => statuses.push(text),
    now: () => time,
    ...options,
  });
  return {
    launcher,
    calls,
    closed,
    statuses,
    env,
    install,
    runtime,
    projectRoot,
    electronDirectory,
    advance: (n) => {
      time += n;
    },
  };
}

test("desktop launch uses fixed project paths, isolated GUI environment and closes the shared log descriptor", async (t) => {
  const f = await fixture(t);
  const pending = f.launcher.launch();
  const call = f.calls[0];
  assert.equal(call.executable, f.runtime);
  assert.deepEqual(call.args, [path.join(f.projectRoot, "desktop/main.cjs")]);
  assert.equal(call.options.cwd, f.projectRoot);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(f.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(call.options.env.QINGDAN_DESKTOP_URL, f.env.QINGDAN_DESKTOP_URL);
  assert.equal(
    call.options.env.QINGDAN_DESKTOP_PROFILE,
    f.env.QINGDAN_DESKTOP_PROFILE,
  );
  assert.equal(call.options.stdio[0], "ignore");
  assert.equal(call.options.stdio[1], call.options.stdio[2]);
  assert.deepEqual(f.closed, []);
  call.child.emit("spawn");
  assert.deepEqual(await pending, { started: true });
  assert.deepEqual(f.closed, [call.options.stdio[1]]);
  assert.equal(call.child.unreferenced, true);
});

test("authenticated launch sends only a descriptor over stdin and waits for native application", async (t) => {
  const context = {
    accountId: "alice",
    roomId: "room-a",
    sessionToken: "a".repeat(64),
  };
  let acknowledge,
    closed = false,
    received = "";
  const descriptor = {
    version: 1,
    endpoint: "http://127.0.0.1:61234",
    nonce: "b".repeat(64),
  };
  const f = await fixture(t, {
    createHandoffImpl: async (input) => {
      assert.deepEqual(input, context);
      return {
        descriptor,
        result: new Promise((r) => (acknowledge = r)),
        close: async () => {
          closed = true;
        },
      };
    },
    behavior: ({ call }) => {
      call.child.stdin.on("data", (c) => (received += c));
      queueMicrotask(() => call.child.emit("spawn"));
    },
  });
  const pending = f.launcher.launch(context);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls[0].args.at(-1), "--qingdan-desktop-handoff");
  assert.equal(
    JSON.stringify(f.calls[0].args).includes(context.sessionToken),
    false,
  );
  assert.equal(
    JSON.stringify(f.calls[0].options.env).includes(context.sessionToken),
    false,
  );
  assert.deepEqual(JSON.parse(received), descriptor);
  let settled = false;
  pending.then(() => (settled = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  acknowledge({ applied: true });
  assert.deepEqual(await pending, { started: true, applied: true });
  assert.equal(closed, true);
});

test("different account or room handoffs never borrow another target's launch result", async (t) => {
  const targets = [],
    acknowledgements = [];
  const f = await fixture(t, {
    createHandoffImpl: async (input) => {
      targets.push(input);
      return {
        descriptor: {
          version: 1,
          endpoint: "http://127.0.0.1:61234",
          nonce: "b".repeat(64),
        },
        result: new Promise((r) => acknowledgements.push(r)),
        close: async () => {},
      };
    },
    behavior: ({ call }) => {
      call.child.stdin.resume();
      queueMicrotask(() => call.child.emit("spawn"));
    },
  });
  const a = {
      accountId: "alice",
      roomId: "room-a",
      sessionToken: "a".repeat(64),
    },
    b = { accountId: "bob", roomId: "room-b", sessionToken: "c".repeat(64) };
  const first = f.launcher.launch(a),
    duplicate = f.launcher.launch(a),
    second = f.launcher.launch(b),
    third = f.launcher.launch(a);
  assert.equal(first, duplicate);
  assert.notEqual(first, second);
  assert.notEqual(first, third);
  await new Promise((r) => setImmediate(r));
  assert.equal(targets.length, 1);
  acknowledgements[0]({ applied: true });
  await first;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(targets[1], b);
  acknowledgements[1]({
    applied: false,
    code: "cancelled",
    error: "已取消切换",
  });
  await assert.rejects(second, /取消/);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(targets[2], a);
  acknowledgements[2]({ applied: true });
  await third;
});

test("concurrent desktop launch requests share one Promise and recent duplicate clicks do not spawn again", async (t) => {
  const f = await fixture(t);
  const first = f.launcher.launch(),
    second = f.launcher.launch();
  assert.equal(first, second);
  assert.equal(f.calls.length, 1);
  f.calls[0].child.emit("spawn");
  await first;
  assert.equal(f.launcher.launch(), first);
  assert.equal(f.calls.length, 1);
  f.advance(1001);
  const later = f.launcher.launch();
  assert.equal(f.calls.length, 2);
  f.calls[1].child.emit("spawn");
  await later;
});

test("first launch installs the fixed Electron runtime once before coalesced GUI spawn", async (t) => {
  const f = await fixture(t, { installed: false });
  const first = f.launcher.launch(),
    second = f.launcher.launch();
  assert.equal(first, second);
  const installer = f.calls[0];
  assert.equal(installer.executable, path.join(f.projectRoot, "node.exe"));
  assert.deepEqual(installer.args, [
    path.join(f.electronDirectory, "install.js"),
  ]);
  assert.equal(installer.options.shell, false);
  assert.equal(installer.options.windowsHide, true);
  assert.equal(installer.options.stdio[0], "ignore");
  assert.match(f.statuses[0], /首次.*下载/);
  f.install();
  installer.child.emit("exit", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].executable, f.runtime);
  f.calls[1].child.emit("spawn");
  assert.deepEqual(await first, { started: true });
});

test("installer failure is actionable, spawns no GUI, and can be retried", async (t) => {
  const f = await fixture(t, { installed: false });
  const first = f.launcher.launch();
  f.calls[0].child.emit("exit", 1);
  await assert.rejects(first, /desktop:install/);
  assert.equal(f.calls.length, 1);
  f.install();
  const retry = f.launcher.launch();
  f.calls[1].child.emit("spawn");
  assert.deepEqual(await retry, { started: true });
});

test("successful installer exit without a runtime is reported rather than launching another path", async (t) => {
  const f = await fixture(t, { installed: false });
  const pending = f.launcher.launch();
  f.calls[0].child.emit("exit", 0);
  await assert.rejects(pending, /未就绪.*desktop:install/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.closed, []);
});

test("runtime marker cannot escape Electron dist when choosing the executable", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.electronDirectory, "path.txt"),
    "../../outside.exe",
  );
  await writeFile(
    path.join(f.projectRoot, "node_modules", "outside.exe"),
    "untrusted fixture",
  );
  const pending = f.launcher.launch();
  assert.equal(f.calls[0].executable, path.join(f.projectRoot, "node.exe"));
  f.calls[0].child.emit("exit", 0);
  await assert.rejects(pending, /未就绪/);
  assert.equal(f.calls.length, 1);
});

test("failed GUI spawn closes the log descriptor and does not poison the next launch", async (t) => {
  const f = await fixture(t);
  const first = f.launcher.launch();
  f.calls[0].child.emit(
    "error",
    Object.assign(new Error("spawn denied"), { code: "EACCES" }),
  );
  await assert.rejects(first, /桌面.*启动失败.*EACCES/);
  assert.deepEqual(f.closed, [f.calls[0].options.stdio[1]]);
  const retry = f.launcher.launch();
  f.calls[1].child.emit("spawn");
  await retry;
  assert.equal(f.closed.length, 2);
});

test("synchronous spawn errors also close the opened log descriptor", async (t) => {
  const f = await fixture(t, {
    behavior() {
      throw new Error("synchronous spawn failure");
    },
  });
  await assert.rejects(f.launcher.launch(), /桌面.*启动失败/);
  assert.equal(f.closed.length, 1);
});

test("installed Qingdao takes priority over source Electron and keeps handoff credentials off argv", async (t) => {
  const f = await fixture(t, { installed: false });
  const local = path.join(f.projectRoot, "local");
  const executable = path.join(local, "Programs", "Qingdao", "Qingdao.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "installed desktop fixture");
  await rm(f.electronDirectory, { recursive: true, force: true });
  const calls = [];
  let received = "";
  const descriptor = {
    version: 1,
    endpoint: "http://127.0.0.1:61234",
    nonce: "b".repeat(64),
  };
  const launcher = createDesktopLauncher({
    projectRoot: f.projectRoot,
    env: { ...f.env, LOCALAPPDATA: local },
    spawnImpl(file, args, options) {
      calls.push({ file, args, options });
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdin.on("data", (chunk) => (received += chunk));
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    createHandoffImpl: async () => ({
      descriptor,
      result: Promise.resolve({ applied: true }),
      close: async () => {},
    }),
  });
  const context = {
    accountId: "alice",
    roomId: "room-a",
    sessionToken: "a".repeat(64),
  };
  assert.deepEqual(await launcher.launch(context), {
    started: true,
    applied: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, executable);
  assert.deepEqual(calls[0].args, ["--qingdan-desktop-handoff"]);
  assert.equal(
    calls[0].options.env.QINGDAN_DESKTOP_PROFILE,
    f.env.QINGDAN_DESKTOP_PROFILE,
  );
  assert.equal(JSON.stringify(calls[0]).includes(context.sessionToken), false);
  assert.deepEqual(JSON.parse(received), descriptor);
});
