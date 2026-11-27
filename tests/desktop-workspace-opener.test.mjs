import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  createWorkspaceOpener,
  focusWindowsWorkspace,
} from "../desktop/workspace-opener.cjs";
import { windowsWorkspaceFocus } from "../desktop/workspace-focus-windows.cjs";

const url = "https://todo.zky.lol/app?room=one";

test("rapid capsule clicks share one native lookup and one external launch", async () => {
  let finish, probes = 0, launches = 0, clock = 1000;
  const open = createWorkspaceOpener({
    platform: "win32",
    focus: () => { probes++; return new Promise((resolve) => { finish = resolve; }); },
    openExternal: async (value) => { assert.equal(value, url); launches++; },
    now: () => clock,
  });
  const first = open(url), repeated = open(url);
  assert.equal(first, repeated);
  await new Promise((r) => setImmediate(r));
  finish("absent");
  await first;
  assert.equal(probes, 1);
  assert.equal(launches, 1);
  const early = open(url);
  await new Promise((r) => setImmediate(r));
  finish("absent");
  await early;
  assert.equal(launches, 1);
  clock += 3000;
  const afterClose = open(url);
  await new Promise((r) => setImmediate(r));
  finish("absent");
  await afterClose;
  assert.equal(launches, 2);
});

test("an existing page is focused every time without opening another tab, including after the launch window", async () => {
  let probes = 0, launches = 0;
  const open = createWorkspaceOpener({
    platform: "win32",
    focus: async () => { probes++; return "focused"; },
    openExternal: async () => { launches++; },
  });
  await open(url);
  await open(url);
  assert.equal(probes, 2);
  assert.equal(launches, 0);
});

test("lookup failure never creates a duplicate and a later user retry can succeed", async () => {
  let status = "unavailable", launches = 0;
  const open = createWorkspaceOpener({
    platform: "win32",
    focus: async () => status,
    openExternal: async () => { launches++; },
  });
  await assert.rejects(open(url), /暂时无法响应/);
  status = "focused";
  assert.equal(await open(url), true);
  assert.equal(launches, 0);
});

test("browser focus changes for different destinations run sequentially", async () => {
  const probes = [], callbacks = [];
  const open = createWorkspaceOpener({
    platform: "win32",
    focus: (value) => { probes.push(value); return new Promise((r) => callbacks.push(r)); },
    openExternal: async () => {},
  });
  const first = open(url), second = open(url.replace("one", "two"));
  await new Promise((r) => setImmediate(r));
  assert.equal(probes.length, 1);
  callbacks[0]("focused");
  await first;
  await new Promise((r) => setImmediate(r));
  assert.equal(probes.length, 2);
  callbacks[1]("focused");
  await second;
});

test("unsafe destinations are rejected before lookup; launch failures remain retryable", async () => {
  let launches = 0;
  const open = createWorkspaceOpener({
    platform: "win32",
    focus: async () => "absent",
    openExternal: async () => { if (++launches === 1) throw Error("browser failed"); },
  });
  for (const value of ["file:///app", "https://evil.test/app", "https://todo.zky.lol/api/session"])
    assert.throws(() => open(value));
  await assert.rejects(open(url), /browser failed/);
  await open(url);
  assert.equal(launches, 2);
});

test("Windows lookup passes URLs as data and never interpolates them into PowerShell", async () => {
  const input = 'https://todo.zky.lol/app?room=$(throw-attack)`"';
  assert.equal(await focusWindowsWorkspace(input, {
    env: { SystemRoot: "C:\\Windows" },
    exec(file, args, options, done) {
      assert.match(file, /WindowsPowerShell/);
      assert.equal(args.at(-1), windowsWorkspaceFocus);
      assert.equal(args.includes(input), false);
      assert.equal(options.env.QINGDAO_WORKSPACE_TARGET, input);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 12000);
      done(null, "focused\r\n");
    },
  }), "focused");
});

test("Windows native focus helper compiles; empty input exits before inspecting any windows", {
  skip: process.platform !== "win32", timeout: 20000,
}, async () => {
  const { stdout } = await promisify(execFile)(
    path.win32.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsWorkspaceFocus],
    { windowsHide: true, timeout: 15000, env: { ...process.env, QINGDAO_WORKSPACE_TARGET: "" } },
  );
  assert.equal(stdout.trim(), "unavailable");
});
