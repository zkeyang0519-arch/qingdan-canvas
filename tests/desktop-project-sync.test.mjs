import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(
  new URL("../runner/desktop-project-sync.ts", import.meta.url),
);
const loadSync = async () => {
  const { outputFiles } = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const code = Buffer.from(outputFiles[0].text).toString("base64");
  return (await import(`data:text/javascript;base64,${code}`))
    .createDesktopProjectSync;
};
const syncFactory = loadSync();
const workspace = String.raw`D:\任务目录\中文 项目 & $(echo unsafe)`;

test("passes the complete Windows workspace as one argument to Codex", async () => {
  const calls = [];
  const env = { SOME_RUNNER_SETTING: "test" };
  const sync = (await syncFactory)({
    platform: "win32",
    command: "pinned-codex.exe",
    args: ["--profile", "local"],
    env,
    execute: async (...args) => calls.push(args),
  });
  await sync(workspace);

  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /(?:^|\\)powershell\.exe$/iu);
  assert.ok(calls[0][1].includes("-NoProfile"));
  assert.match(calls[0][1].at(-1), /URL Protocol/u);
  assert.match(calls[0][1].at(-1), /Get-StartApps/u);
  assert.ok(calls[0][1].every((arg) => !arg.includes(workspace)));
  assert.equal(calls[1][0], "pinned-codex.exe");
  assert.deepEqual(calls[1][1], ["--profile", "local", "app", workspace]);
  for (const [, , options] of calls) {
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.ok(options.timeout > 0 && options.timeout <= 8000);
    assert.equal(options.env, env);
  }
});

test("fails before launching Codex when Desktop availability cannot be confirmed", async () => {
  const calls = [];
  const sync = (await syncFactory)({
    platform: "win32",
    execute: async (command) => {
      calls.push(command);
      throw Error("desktop protocol not registered");
    },
  });
  await assert.rejects(sync(workspace), /Codex 桌面.*协议/u);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /(?:^|\\)powershell\.exe$/iu);
});

test("surfaces a timed out launch without retrying it", async () => {
  let calls = 0;
  const timeout = Object.assign(Error("timed out"), { killed: true });
  const sync = (await syncFactory)({
    platform: "win32",
    execute: async () => {
      if (++calls === 2) throw timeout;
    },
  });
  await assert.rejects(sync(workspace), {
    message: /Codex 桌面.*超时/u,
    cause: timeout,
  });
  assert.equal(calls, 2);
});

test("rejects paths without an absolute Windows root before starting a process", async () => {
  let calls = 0;
  const sync = (await syncFactory)({
    platform: "win32",
    execute: async () => calls++,
  });
  for (const invalid of [
    "workspace",
    "D:workspace",
    "\\workspace",
    "D:\\nul\0",
  ]) {
    await assert.rejects(sync(invalid), /绝对路径/u);
  }
  assert.equal(calls, 0);
});

test("leaves other operating systems out of automatic Desktop sync", async () => {
  let calls = 0;
  const sync = (await syncFactory)({
    platform: "linux",
    execute: async () => calls++,
  });
  await assert.rejects(sync("/work"), /仅支持 Windows/u);
  assert.equal(calls, 0);
});
