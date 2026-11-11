import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  symlink,
} from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { once } from "node:events";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const exec = promisify(execFile);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

let manager;
try {
  manager = await import("../scripts/lib/agent-install.mjs");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

test("diagnosis cannot occupy a port while the application starts", async (t) => {
  const f = await fixture(t);
  await manager.install({ ...f, checkDependencies: false });
  const reservation = net.createServer((socket) => socket.destroy());
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const applicationPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const otherPort = net.createServer((socket) => socket.destroy());
  otherPort.listen(0, "127.0.0.1");
  await once(otherPort, "listening");
  const application = net.createServer((socket) => socket.destroy());
  t.after(async () => {
    if (application.listening)
      await new Promise((resolve) => application.close(resolve));
    await new Promise((resolve) => otherPort.close(resolve));
  });
  let startup;
  const startApplication = () => {
    if (!startup)
      startup = new Promise((resolve) => {
        application.once("error", resolve);
        application.listen(applicationPort, "127.0.0.1", () => resolve(null));
      });
    return startup;
  };
  const ports = { 8790: applicationPort, 8788: otherPort.address().port };
  const listen = net.Server.prototype.listen;
  const connect = net.createConnection;
  // Redirect the production diagnostics to isolated ports. Start the real
  // application during the probe, before a listening probe can release its port.
  t.mock.method(net.Server.prototype, "listen", function (port, ...args) {
    if (!ports[port]) return listen.call(this, port, ...args);
    if (port === 8790) {
      const callback = args.pop();
      return listen.call(this, ports[port], ...args, () => {
        void startApplication().then(() => callback());
      });
    }
    return listen.call(this, ports[port], ...args);
  });
  t.mock.method(net, "createConnection", function (options, ...args) {
    const port = typeof options === "number" ? options : options?.port;
    if (ports[port]) {
      if (port === 8790) void startApplication();
      options =
        typeof options === "number"
          ? ports[port]
          : { ...options, port: ports[port] };
    }
    return connect.call(this, options, ...args);
  });
  await manager.diagnose({ ...f, probePort: undefined });
  const error = await startup;
  assert.equal(error?.code, undefined, "the diagnostic probe blocked application startup");
  assert.equal(application.listening, true);
});

test("stop waits for process exit after the authenticated control record disappears", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.root, "scripts/dev-agent.mjs"),
    `
    import { closeLifecycleControl } from ${JSON.stringify(new URL("../scripts/lib/agent-install-bridge.mjs", import.meta.url).href)};
    setInterval(() => {}, 1000);
    process.once('SIGTERM', async () => {
      await closeLifecycleControl();
      setTimeout(() => process.exit(0), 750);
    });
  `,
  );
  await manager.install({ ...f, checkDependencies: false });
  const running = await manager.start(f);
  try {
    const result = await manager.stop(f);
    assert.equal(result.stopped, true);
    assert.equal(
      manager.processExists(running.pid),
      false,
      "stop reported success while the launcher still held its working directory",
    );
  } finally {
    const deadline = Date.now() + 5000;
    while (manager.processExists(running.pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(manager.processExists(running.pid), false);
  }
});

test("installation lifecycle module exists", () =>
  assert.ok(manager, "local installation lifecycle is missing"));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qd-install 中文 path'-"));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "runner"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "qingdan-canvas",
      scripts: { "dev:agent": "node scripts/dev-agent.mjs" },
    }),
  );
  await writeFile(
    path.join(root, "runner/protocol-version.json"),
    JSON.stringify({ codexVersion: "0.166.0-alpha.6", nodeMajor: 24 }),
  );
  await writeFile(
    path.join(root, "scripts/dev-agent.mjs"),
    "setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0));\n",
  );
  // The lifecycle owns a real detached fixture process. Only the fixed-port
  // preflight is injected so running the suite never displaces a developer's app.
  const f = {
    root,
    stateDir: path.join(root, ".tmp/agent-install-test"),
    probePort: async () => true,
    probeReady: async () => true,
  };
  t.after(async () => {
    await manager.stop({ ...f, interruptActive: true }).catch(() => {});
    const resolvedRoot = path.resolve(root);
    assert.ok(
      resolvedRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    );
    await rm(resolvedRoot, { recursive: true, force: true });
  });
  return f;
}

test(
  "unsafe installation targets cannot create or delete outside the owned directory",
  { skip: !manager },
  async (t) => {
    const f = await fixture(t);
    for (const stateDir of [
      f.root,
      path.join(f.root, ".tmp"),
      path.join(f.root, ".tmp/runner-device"),
      "relative",
      path.join(f.root, "../agent-install"),
    ]) {
      await assert.rejects(
        manager.install({ ...f, stateDir, checkDependencies: false }),
        /unsafe|absolute|installation directory/i,
      );
    }
    assert.equal(
      await readFile(path.join(f.root, "package.json"), "utf8")
        .then(JSON.parse)
        .then((v) => v.name),
      "qingdan-canvas",
    );
  },
);

test(
  "install and uninstall retain runtime data, credentials, and logs",
  { skip: !manager },
  async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.root, ".tmp/runner-device"), { recursive: true });
    await writeFile(
      path.join(f.root, ".tmp/runner-device/retained.txt"),
      "local credential reference",
    );
    await manager.install({ ...f, checkDependencies: false });
    const before = await readFile(path.join(f.stateDir, "control.key"), "utf8");
    await writeFile(path.join(f.stateDir, "service.log"), "retained log");
    await manager.uninstall(f);
    assert.equal(
      await readFile(
        path.join(f.root, ".tmp/runner-device/retained.txt"),
        "utf8",
      ),
      "local credential reference",
    );
    assert.equal(
      await readFile(path.join(f.stateDir, "service.log"), "utf8"),
      "retained log",
    );
    await assert.rejects(access(path.join(f.stateDir, "install.json")));
    await manager.install({ ...f, checkDependencies: false });
    assert.equal(
      await readFile(path.join(f.stateDir, "control.key"), "utf8"),
      before,
    );
    assert.equal((await manager.diagnose(f)).installed, true);
  },
);

test(
  "duplicate start uses the authenticated live instance and stop closes only that instance",
  { skip: !manager, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await manager.install({ ...f, checkDependencies: false });
    const first = await manager.start(f);
    const second = await manager.start(f);
    assert.equal(first.pid, second.pid);
    assert.equal(second.alreadyRunning, true);
    assert.equal(first.instanceId, second.instanceId);
    assert.equal((await manager.diagnose(f)).status, "running");
    await manager.stop(f);
    assert.equal((await manager.diagnose(f)).status, "stopped");
  },
);

test(
  "foreign process and stale pid records never authorize killing or adoption",
  { skip: !manager, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await manager.install({ ...f, checkDependencies: false });
    const foreign = spawn(
      process.execPath,
      ["-e", "setInterval(() => {},1000)"],
      { windowsHide: true, stdio: "ignore" },
    );
    t.after(() => foreign.kill());
    const record = {
      pid: foreign.pid,
      instanceId: "foreign",
      projectRoot: f.root,
    };
    await writeFile(
      path.join(f.stateDir, "runtime.json"),
      JSON.stringify(record),
    );
    await assert.rejects(manager.stop(f), /unverified|identity|foreign/i);
    await assert.rejects(manager.start(f), /unverified|identity|foreign/i);
    assert.doesNotThrow(() => process.kill(foreign.pid, 0));
    await writeFile(
      path.join(f.stateDir, "runtime.json"),
      JSON.stringify({ ...record, pid: 2147483647 }),
    );
    assert.equal((await manager.diagnose(f)).status, "stale");
    await manager.stop(f);
    assert.doesNotThrow(() => process.kill(foreign.pid, 0));
  },
);

test(
  "active or unreadable records block ordinary stop; explicit interruption permits graceful shutdown",
  { skip: !manager, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await manager.install({ ...f, checkDependencies: false });
    await manager.start(f);
    const ledger = path.join(f.root, ".tmp/agent-experience/sessions.json");
    await mkdir(path.dirname(ledger), { recursive: true });
    await writeFile(
      ledger,
      JSON.stringify({ sessions: { one: { status: "running" } } }),
    );
    await assert.rejects(manager.stop(f), /active|unknown/i);
    assert.equal((await manager.diagnose(f)).status, "running");
    await writeFile(ledger, "broken json");
    await assert.rejects(manager.stop(f), /active|unknown/i);
    await manager.stop({ ...f, interruptActive: true });
    assert.equal((await manager.diagnose(f)).status, "stopped");
  },
);

test(
  "occupied port is reported and never adopted",
  { skip: !manager },
  async (t) => {
    const f = await fixture(t);
    await manager.install({ ...f, checkDependencies: false });
    const outsider = net.createServer();
    outsider.listen(0, "127.0.0.1");
    await once(outsider, "listening");
    t.after(() => outsider.close());
    const probePort = () =>
      new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(outsider.address().port, "127.0.0.1", () =>
          probe.close(() => resolve(true)),
        );
      });
    await assert.rejects(
      manager.start({ ...f, probePort }),
      /8790.*8788.*occupied/i,
    );
    assert.equal(
      (await manager.diagnose({ ...f, probePort })).status,
      "unmanaged",
    );
    assert.equal(outsider.listening, true);
    await assert.rejects(access(path.join(f.stateDir, "runtime.json")));
  },
);

test(
  "invalid control secret cannot stop or adopt a managed process",
  { skip: !manager, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await manager.install({ ...f, checkDependencies: false });
    const first = await manager.start(f);
    const key = path.join(f.stateDir, "control.key");
    const secret = await readFile(key, "utf8");
    try {
      await writeFile(key, "0".repeat(64));
      await assert.rejects(manager.stop(f), /identity/i);
      await assert.rejects(manager.start(f), /unverified|foreign/i);
      assert.equal((await manager.diagnose(f)).status, "unverified");
      assert.doesNotThrow(() => process.kill(first.pid, 0));
    } finally {
      await writeFile(key, secret);
    }
    await manager.stop(f);
  },
);

test(
  "an authenticated launcher is still starting until its application responds",
  { skip: !manager, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await manager.install({ ...f, checkDependencies: false });
    const waiting = {
      ...f,
      probeReady: async () => false,
      startupTimeoutMs: 600,
    };
    const first = await manager.start(waiting);
    assert.equal(first.ready, false);
    assert.equal(first.status, "starting");
    assert.equal((await manager.diagnose(waiting)).status, "starting");
    const second = await manager.start(f);
    assert.equal(second.pid, first.pid);
    assert.equal(second.ready, true);
    assert.equal(second.alreadyRunning, true);
  },
);

test(
  "a crashing launcher cannot report ready",
  { skip: !manager, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      path.join(f.root, "scripts/dev-agent.mjs"),
      "throw Error('fixture startup failed');\n",
    );
    await manager.install({ ...f, checkDependencies: false });
    await assert.rejects(
      manager.start({ ...f, probeReady: async () => false }),
      /exited while starting/i,
    );
    assert.match(
      await readFile(path.join(f.stateDir, "service.log"), "utf8"),
      /fixture startup failed/,
    );
  },
);

test(
  "install and uninstall respect a lifecycle operation already in progress",
  { skip: !manager },
  async (t) => {
    const f = await fixture(t);
    await manager.install({ ...f, checkDependencies: false });
    const entered = deferred(),
      release = deferred();
    const pending = manager.start({
      ...f,
      probePort: async () => {
        entered.resolve();
        await release.promise;
        return false;
      },
    });
    const result = pending.catch((error) => error);
    await entered.promise;
    try {
      await assert.rejects(
        manager.install({ ...f, checkDependencies: false }),
        /operation.*progress/i,
      );
      await assert.rejects(manager.uninstall(f), /operation.*progress/i);
    } finally {
      release.resolve();
    }
    assert.match((await result).message, /occupied/i);
  },
);

test(
  "simultaneous stale-lock contenders never enter lifecycle work together",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await manager.install({ ...f, checkDependencies: false });
    const lockFile = path.join(f.stateDir, "operation.lock");
    await writeFile(lockFile, JSON.stringify({ pid: 2147483647 }));
    const originalRead = fsPromises.readFile,
      originalUnlink = fsPromises.unlink;
    const bothRead = deferred(),
      entered = deferred(),
      overlap = deferred(),
      release = deferred(),
      rejected = deferred();
    let reads = 0,
      unlinks = 0,
      entrants = 0;
    // Force the former TOCTOU schedule while keeping real filesystem operations:
    // A and B read the old identity; B unlinks only after A enters protected work.
    t.mock.method(fsPromises, "readFile", async (file, ...args) => {
      const value = await originalRead(file, ...args);
      if (file === lockFile) {
        if (++reads === 2) bothRead.resolve();
        await bothRead.promise;
      }
      return value;
    });
    t.mock.method(fsPromises, "unlink", async (file, ...args) => {
      if (file === lockFile && ++unlinks === 2) await entered.promise;
      return originalUnlink(file, ...args);
    });
    syncBuiltinESMExports();
    const probePort = async () => {
      if (++entrants === 1) entered.resolve();
      else overlap.resolve();
      await release.promise;
      return false;
    };
    const contenders = [
      manager.start({ ...f, probePort }),
      manager.start({ ...f, probePort }),
    ].map((promise) =>
      promise.catch((error) => {
        rejected.resolve();
        return error;
      }),
    );
    try {
      const outcome = await Promise.race([
        overlap.promise.then(() => "overlap"),
        rejected.promise.then(() => "rejected"),
      ]);
      assert.equal(
        outcome,
        "rejected",
        "a second contender entered while the first held the lifecycle lock",
      );
      await entered.promise;
      assert.equal(entrants, 1);
    } finally {
      release.resolve();
      await Promise.all(contenders);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  },
);

test("an empty legacy lock left by a crash cannot block lifecycle operations", async (t) => {
  const f = await fixture(t);
  await manager.install({ ...f, checkDependencies: false });
  await writeFile(path.join(f.stateDir, "operation.lock"), "");
  await assert.rejects(
    manager.start({ ...f, probePort: async () => false }),
    /occupied/i,
  );
  await manager.uninstall(f);
  assert.equal((await manager.diagnose(f)).installed, false);
});

test(
  "process death releases a held lifecycle lock without deleting another owner's lock",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await manager.install({ ...f, checkDependencies: false });
    const moduleUrl = new URL(
      "../scripts/lib/agent-install.mjs",
      import.meta.url,
    ).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    const { start } = await import(${JSON.stringify(moduleUrl)});
    setInterval(() => {}, 1000);
    await start({ ...${JSON.stringify({ root: f.root, stateDir: f.stateDir })}, probePort: async () => {
      process.send({ held: true });
      await new Promise(() => {});
    }});
  `,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    assert.deepEqual((await once(child, "message"))[0], { held: true });
    await assert.rejects(manager.uninstall(f), /operation.*progress/i);
    child.kill();
    await exited;
    await manager.uninstall(f);
    assert.equal((await manager.diagnose(f)).installed, false);
  },
);

test(
  "installed PowerShell entry works outside the checkout and is removed on uninstall",
  { skip: process.platform !== "win32" || !manager },
  async (t) => {
    const f = await fixture(t);
    const installed = await manager.install({ ...f, checkDependencies: false });
    assert.equal(typeof installed.entryPoint, "string");
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installed.entryPoint,
        "-Action",
        "diagnose",
      ],
      { cwd: os.tmpdir(), windowsHide: true },
    );
    assert.equal(JSON.parse(stdout).installed, true);
    await manager.uninstall(f);
    await assert.rejects(access(installed.entryPoint));
    assert.equal((await manager.diagnose(f)).status, "not_installed");
  },
);

test(
  "a linked install directory cannot mutate its target",
  { skip: !manager },
  async (t) => {
    const f = await fixture(t);
    const target = path.join(f.root, "preserved");
    await mkdir(target);
    await writeFile(path.join(target, "control.key"), "preserve me");
    await mkdir(path.dirname(f.stateDir));
    await symlink(
      target,
      f.stateDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      manager.install({ ...f, checkDependencies: false }),
      /unsafe|links|junctions/i,
    );
    assert.equal(
      await readFile(path.join(target, "control.key"), "utf8"),
      "preserve me",
    );
  },
);

test("incomplete or malformed control keys cannot be published by install", async (t) => {
  const f = await fixture(t);
  await mkdir(f.stateDir, { recursive: true });
  const keyFile = path.join(f.stateDir, "control.key");
  for (const invalid of [
    "",
    "abcd",
    "invalid secret",
    "A".repeat(64),
    `${"a".repeat(64)}\n`,
  ]) {
    await writeFile(keyFile, invalid);
    await assert.rejects(
      manager.install({ ...f, checkDependencies: false }),
      /invalid.*control key/i,
    );
    assert.equal(
      await readFile(keyFile, "utf8"),
      invalid,
      "invalid key must be retained for diagnosis",
    );
    await assert.rejects(access(path.join(f.stateDir, "install.json")));
  }
});

test(
  "control and reinstall reject an invalid key without replacing a live instance's identity",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await manager.install({ ...f, checkDependencies: false });
    const running = await manager.start(f);
    const manifestFile = path.join(f.stateDir, "install.json");
    const originalManifest = await readFile(manifestFile, "utf8");
    const manifest = JSON.parse(originalManifest);
    const keyFile = path.join(f.stateDir, "control.key");
    const secret = await readFile(keyFile, "utf8");
    try {
      for (const invalid of ["", "abcd", "invalid secret"]) {
        await writeFile(keyFile, invalid);
        await assert.rejects(
          manager.requestControl(manifest, "stop"),
          /invalid.*control key/i,
        );
        await assert.rejects(manager.start(f), /invalid.*control key/i);
        await assert.rejects(
          manager.install({ ...f, checkDependencies: false }),
          /invalid.*control key/i,
        );
        assert.equal(await readFile(keyFile, "utf8"), invalid);
        assert.equal(await readFile(manifestFile, "utf8"), originalManifest);
        assert.doesNotThrow(() => process.kill(running.pid, 0));
      }
    } finally {
      await writeFile(keyFile, secret);
    }
    assert.equal((await manager.diagnose(f)).pid, running.pid);
  },
);

test("the launcher bridge rejects an incomplete control key before publishing runtime identity", async (t) => {
  const f = await fixture(t);
  await manager.install({ ...f, checkDependencies: false });
  const manifest = JSON.parse(
    await readFile(path.join(f.stateDir, "install.json"), "utf8"),
  );
  await writeFile(path.join(f.stateDir, "control.key"), "");
  const bridgeUrl = new URL(
    "../scripts/lib/agent-install-bridge.mjs",
    import.meta.url,
  ).href;
  await assert.rejects(
    exec(
      process.execPath,
      [
        "--import",
        bridgeUrl,
        path.join(manifest.projectRoot, "scripts/dev-agent.mjs"),
      ],
      {
        timeout: 2000,
        windowsHide: true,
        env: {
          ...process.env,
          QINGDAN_AGENT_PROJECT_ROOT: manifest.projectRoot,
          QINGDAN_AGENT_INSTALL_DIR: manifest.stateDir,
        },
      },
    ),
    /invalid.*control key/i,
  );
  await assert.rejects(access(path.join(f.stateDir, "runtime.json")));
});
