import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(path.resolve(".tmp/local-runner-client-"));
await build({
  entryPoints: ["src/agent/DevicePanel.jsx"],
  outfile: path.join(dir, "client.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
});
const { localRunnerRequest } = await import(
  pathToFileURL(path.join(dir, "client.mjs"))
);
test.after(() => rm(dir, { recursive: true, force: true }));
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

test("the ordinary local page and Vite page call the Agent bridge with the current browser session", async () => {
  for (const port of [8788, 5178]) {
    globalThis.window = {
      location: new URL(`http://127.0.0.1:${port}/?room=moon`),
    };
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, ...options };
      return Response.json({ sessions: [{ threadId: "session-a" }] });
    };
    const result = await localRunnerRequest("/codex/sessions?searchTerm=moon", {
      accountId: "alice",
    });
    assert.equal(
      request.url,
      "http://127.0.0.1:8790/api/local-runner/codex/sessions?searchTerm=moon",
    );
    assert.equal(request.credentials, "include");
    assert.equal(request.headers["X-QD-Account"], "alice");
    assert.equal(request.headers["X-Qingdan-Local"], "1");
    assert.equal(result.sessions[0].threadId, "session-a");
  }
});

test("an Agent-origin page retains same-origin requests and POST selection never targets the ordinary Worker", async () => {
  globalThis.window = { location: new URL("http://127.0.0.1:8790/") };
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, ...options };
    return Response.json({ ok: true });
  };
  await localRunnerRequest("/codex/select", {
    accountId: "alice",
    method: "POST",
    body: { threadId: "session-a" },
  });
  assert.equal(request.url, "/api/local-runner/codex/select");
  assert.equal(request.credentials, "same-origin");
  assert.deepEqual(JSON.parse(request.body), { threadId: "session-a" });
});

test("an unavailable bridge explains the local service issue instead of exposing a browser network error", async () => {
  globalThis.window = { location: new URL("http://127.0.0.1:8788/") };
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(
    localRunnerRequest("/codex/sessions", { accountId: "alice" }),
    /本机.*服务/,
  );
});

test("the client preserves an account conflict instead of treating it as a missing service", async () => {
  globalThis.window = { location: new URL("http://127.0.0.1:8788/") };
  globalThis.fetch = async () =>
    Response.json(
      { code: "OWNER_MISMATCH", error: "这台电脑已绑定其他轻单账号。" },
      { status: 403 },
    );
  await assert.rejects(localRunnerRequest("/status", { accountId: "bob" }), {
    code: "OWNER_MISMATCH",
    status: 403,
    message: "这台电脑已绑定其他轻单账号。",
  });
});
