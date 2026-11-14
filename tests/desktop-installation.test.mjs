import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createDesktopInstallation,
  compareDesktopVersions,
  validateDesktopRelease,
  fetchDesktopAsset,
  requestDesktopExit,
} from "../scripts/lib/desktop-installation.mjs";

const bytes = Buffer.from("isolated installer fixture");
const checksum = createHash("sha512").update(bytes).digest("base64");
function metadata(version = "0.3.1") {
  return JSON.stringify({
    version,
    path: `Qingdao-Setup-${version}-x64.exe`,
    sha512: checksum,
    files: [
      {
        url: `Qingdao-Setup-${version}-x64.exe`,
        sha512: checksum,
        size: bytes.length,
      },
    ],
  });
}
async function fixture(t, { version = null, running = [], ...options } = {}) {
  await fs.mkdir(".tmp", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".tmp/desktop-installation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { version, running };
  const events = [],
    statuses = [];
  const manager = createDesktopInstallation({
    projectRoot: root,
    env: { LOCALAPPDATA: root },
    inspect: async () => structuredClone(state),
    release: async () => validateDesktopRelease(metadata()),
    fetchImpl: async () => {
      events.push("download");
      return new Response(bytes);
    },
    requestExit: async () => {
      events.push("save-and-exit");
      state.running = [];
    },
    install: async (file) => {
      assert.deepEqual(await fs.readFile(file), bytes);
      assert.equal(state.running.length, 0);
      events.push("install");
      state.version = "0.3.1";
    },
    wait: async () => {},
    ...options,
  });
  return {
    root,
    state,
    events,
    statuses,
    manager,
    ensure: (signal) =>
      manager.ensure({
        profile: root,
        signal,
        onStatus: (message) => statuses.push(message),
      }),
  };
}

test("release metadata binds the exact versioned x64 installer to its size and SHA-512", () => {
  assert.match(
    validateDesktopRelease(metadata()).url,
    /\/download\/v0\.3\.1\/Qingdao-Setup-0\.3\.1-x64\.exe$/,
  );
  for (const change of [
    { version: "../0.3.1" },
    { path: "https://untrusted.example/run.exe" },
    { sha512: "x" },
    {
      files: [
        { url: "Qingdao-Setup-0.3.1-x64.exe", sha512: checksum, size: 0 },
      ],
    },
  ])
    assert.throws(() =>
      validateDesktopRelease(
        JSON.stringify({ ...JSON.parse(metadata()), ...change }),
      ),
    );
  assert.equal(compareDesktopVersions("0.10.0", "0.9.9"), 1);
  assert.throws(() => compareDesktopVersions("latest", "0.3.1"));
});
test("first installation downloads, verifies and installs before reporting the executable ready", async (t) => {
  const f = await fixture(t);
  const result = await f.ensure();
  assert.equal(result.version, "0.3.1");
  assert.equal(result.changed, true);
  assert.deepEqual(f.events, ["download", "install"]);
  assert.deepEqual(
    await fs.readdir(path.join(f.root, "Qingdao/installer-cache")),
    [],
  );
});
test("an equal or newer installed version opens without downloading, closing or downgrading", async (t) => {
  for (const version of ["0.3.1", "0.4.0"]) {
    const f = await fixture(t, { version, running: [100] });
    assert.equal((await f.ensure()).version, version);
    assert.deepEqual(f.events, []);
  }
});
test("a running old version only exits after the full installer checksum passed", async (t) => {
  const f = await fixture(t, { version: "0.3.0", running: [100] });
  await f.ensure();
  assert.deepEqual(f.events, ["download", "save-and-exit", "install"]);
});
test("an old stopped version updates without sending a shutdown command", async (t) => {
  const f = await fixture(t, { version: "0.3.0" });
  await f.ensure();
  assert.deepEqual(f.events, ["download", "install"]);
});
test("corrupt and interrupted downloads leave the old process untouched and clean partial files", async (t) => {
  for (const body of [Buffer.alloc(bytes.length), bytes.subarray(1)]) {
    const f = await fixture(t, {
      version: "0.3.0",
      running: [100],
      fetchImpl: async () => new Response(body),
    });
    await assert.rejects(f.ensure(), /校验失败/);
    assert.equal(f.state.running[0], 100);
    assert.deepEqual(f.events, []);
    assert.deepEqual(
      await fs.readdir(path.join(f.root, "Qingdao/installer-cache")),
      [],
    );
  }
});
test("failed draft saving and unsupported legacy shutdown never invoke the installer", async (t) => {
  for (const requestExit of [
    async () => {
      throw Error("draft could not be saved");
    },
    requestDesktopExit,
  ]) {
    const f = await fixture(t, {
      version: "0.3.0",
      running: [100],
      requestExit,
    });
    await assert.rejects(f.ensure(), /draft|退出轻岛/);
    assert.deepEqual(f.events, ["download"]);
    assert.deepEqual(f.state.running, [100]);
  }
});
test("a saved acknowledgment without process exit never authorizes installation", async (t) => {
  const f = await fixture(t, {
    version: "0.3.0",
    running: [100],
    requestExit: async () => {},
  });
  await assert.rejects(f.ensure(), /尚未完全退出/);
  assert.deepEqual(f.events, ["download"]);
});
test("installation completes after saved shutdown even if the browser then disconnects", async (t) => {
  const controller = new AbortController();
  let f;
  f = await fixture(t, {
    version: "0.3.0",
    running: [100],
    requestExit: async () => {
      f.events.push("save-and-exit");
      f.state.running = [];
      controller.abort();
    },
  });
  assert.equal((await f.ensure(controller.signal)).changed, true);
  assert.deepEqual(f.events, ["download", "save-and-exit", "install"]);
});
test("cancellation before preparation never closes or installs anything", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const f = await fixture(t, { version: "0.3.0", running: [100] });
  await assert.rejects(f.ensure(controller.signal), { name: "AbortError" });
  assert.deepEqual(f.events, []);
});
test("a failed installer or unchanged executable is never reported as successfully updated", async (t) => {
  for (const install of [
    async () => {
      throw Error("OS blocked installation");
    },
    async () => {},
  ]) {
    const f = await fixture(t, { version: "0.3.0", install });
    await assert.rejects(f.ensure(), /blocked|安装成功/);
  }
});
test("release-network failure permits an existing app with a visible warning but cannot pretend to install", async (t) => {
  const release = async () => {
    throw Error("offline");
  };
  const present = await fixture(t, { version: "0.3.0", release });
  assert.match((await present.ensure()).warning, /暂时无法检查/);
  assert.deepEqual(present.events, []);
  const absent = await fixture(t, { release });
  await assert.rejects(absent.ensure(), /还没有安装/);
});
test("download redirects cannot escape GitHub's release asset hosts", async () => {
  let calls = 0;
  await assert.rejects(
    fetchDesktopAsset("https://github.com/example", {
      fetchImpl: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/payload.exe" },
        });
      },
    }),
    /不受信任/,
  );
  assert.equal(calls, 1);
});
