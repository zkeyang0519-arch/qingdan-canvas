import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { discoverCodex } from "../discovery.mjs";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const input = path.resolve(process.argv[2]);
await mkdir(path.join(root, ".tmp"), { recursive: true });
const evidence = await mkdtemp(
  path.join(root, ".tmp", "codex-portable-verification-"),
);
const relocated = path.join(evidence, "移动后的连接程序 with spaces");
const state = path.join(evidence, "isolated-state");
const report = { at: new Date().toISOString(), passed: false, checks: [] };
let child, exited, runtime;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 20000) {
  const until = Date.now() + timeout;
  let value;
  while (Date.now() < until) {
    try {
      value = await fn();
      if (value) return value;
    } catch {}
    await pause(100);
  }
  throw Error("Timed out waiting for verification state");
}
async function api(route, body) {
  const r = await fetch(runtime.url + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + runtime.token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.code ?? "HTTP " + r.status);
  return value;
}
try {
  const list = await readdir(input);
  assert.equal(
    list.includes("data"),
    false,
    "release must not contain runtime state",
  );
  await cp(input, relocated, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const found = await discoverCodex();
  assert.ok(found.candidates.length, "real Codex required for portable smoke");
  // Simulate a machine without Node/npm on PATH; launch only the bundled runtime.
  const env = {
    ...process.env,
    PATH: [
      path.dirname(found.candidates[0].command),
      path.join(process.env.SystemRoot, "System32"),
      path.join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
      ),
      process.env.SystemRoot,
    ].join(";"),
  };
  delete env.QINGDAN_CODEX_BIN;
  child = spawn(
    path.join(relocated, "node.exe"),
    [path.join(relocated, "app/main.mjs"), "--data-dir", state],
    {
      cwd: relocated,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  exited = new Promise((resolve) => child.once("exit", resolve));
  runtime = await waitFor(async () =>
    JSON.parse(await readFile(path.join(state, "runtime.json"), "utf8")),
  );
  let status = await waitFor(async () => {
    const s = await api("/api/status");
    return ["ready", "login_required", "error"].includes(s.status) ? s : null;
  });
  assert.equal(status.status, "ready", status.error?.code);
  report.checks.push({
    name: "relocated-bundled-runtime-without-system-node",
    passed: true,
    version: status.version,
  });
  const page = await api("/api/sessions");
  assert.ok(Array.isArray(page.sessions));
  report.checks.push({
    name: "real-session-list",
    count: page.sessions.length,
  });
  if (page.sessions[0]) {
    const selected = await api(
      "/api/session?id=" + encodeURIComponent(page.sessions[0].threadId),
    );
    assert.equal(selected.threadId, page.sessions[0].threadId);
    report.checks.push({
      name: "selected-project",
      matches: true,
      directoryExists: selected.directoryExists,
    });
  }
  if (page.nextCursor) {
    const next = await api(
      "/api/sessions?cursor=" + encodeURIComponent(page.nextCursor),
    );
    report.checks.push({
      name: "real-pagination",
      count: next.sessions.length,
    });
  }
  const repeated = await exec(
    path.join(relocated, "node.exe"),
    [path.join(relocated, "app/main.mjs"), "--data-dir", state],
    { cwd: relocated, env, windowsHide: true, timeout: 10000 },
  );
  assert.equal(JSON.parse(repeated.stdout.trim()).reused, true);
  assert.equal(
    JSON.parse(await readFile(path.join(state, "runtime.json"), "utf8")).pid,
    child.pid,
  );
  report.checks.push({ name: "duplicate-launch-reuses-process", passed: true });
  assert.equal((await fetch(runtime.url + "/api/status")).status, 401);
  report.checks.push({ name: "local-api-requires-credential", passed: true });
  const invalid = await api("/api/config", {
    manualPath: path.join(evidence, "missing-codex.exe"),
  });
  assert.equal(invalid.error.code, "CODEX_PATH_INVALID");
  assert.equal((await api("/api/config", { manualPath: "" })).status, "ready");
  report.checks.push({
    name: "manual-path-error-and-auto-recovery",
    passed: true,
  });
  assert.equal((await api("/api/connect", {})).status, "ready");
  report.checks.push({ name: "real-reconnect", passed: true });
  const diagnostics = await api("/api/diagnostics");
  assert.equal(JSON.stringify(diagnostics).includes(runtime.token), false);
  assert.equal(
    JSON.stringify(diagnostics).includes(found.candidates[0].command),
    false,
  );
  report.diagnostics = diagnostics;
  const ps = path.join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const owned = await exec(
    ps,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Select-Object -ExpandProperty ProcessId`,
    ],
    { windowsHide: true, timeout: 10000 },
  );
  const childPids = owned.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  await api("/api/quit", {});
  await Promise.race([
    exited,
    pause(10000).then(() => {
      throw Error("connector did not exit");
    }),
  ]);
  await waitFor(async () => {
    try {
      await readFile(path.join(state, "runtime.json"));
      return false;
    } catch (e) {
      return e.code === "ENOENT";
    }
  }, 3000);
  for (const pid of childPids)
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 3000);
  report.checks.push({
    name: "clean-shutdown",
    connectorExited: true,
    ownedChildrenExited: childPids.length,
  });
  report.passed = true;
} catch (e) {
  report.error = String(e.message);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    if (runtime) await api("/api/quit", {}).catch(() => {});
    await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null) child.kill();
  }
  await writeFile(
    path.join(evidence, "verification.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ...report, evidence }, null, 2));
}
