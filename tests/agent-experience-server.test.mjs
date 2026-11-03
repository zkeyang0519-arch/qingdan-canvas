import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { ExperienceService } from "../scripts/lib/agent-experience-service.mjs";
import { createExperienceServer } from "../scripts/lib/agent-experience-server.mjs";

const localHeader = { "x-qingdan-local": "1" };
test("confirmed terminal failures allow a fresh test, while unresolved runs remain blocked", async () => {
  const stateDir = await mkdtemp(
    path.resolve(".tmp/agent-experience-failure-"),
  );
  let child;
  const spawn = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    return child;
  };
  try {
    const service = new ExperienceService({
      stateDir,
      projectRoot: process.cwd(),
      spawn,
    });
    const first = await service.start(crypto.randomUUID());
    const reportDir = `${first.workspace}.runner`;
    await mkdir(reportDir, { recursive: true });
    const db = new DatabaseSync(path.join(reportDir, "runner.sqlite"));
    db.exec("CREATE TABLE runs (data TEXT NOT NULL)");
    db.prepare("INSERT INTO runs(data) VALUES (?)").run(
      JSON.stringify({ active: true, terminal: false }),
    );
    await writeFile(
      path.join(reportDir, "report.json"),
      JSON.stringify({
        passed: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: "Codex failed",
      }),
    );
    child.emit("exit", 1);
    assert.equal((await service.status()).current.status, "needs_review");
    await assert.rejects(service.start(crypto.randomUUID()), /核对/);
    db.prepare("UPDATE runs SET data=?").run(
      JSON.stringify({ active: false, terminal: true }),
    );
    db.close();
    assert.equal((await service.status()).current.status, "failed");
    const next = await service.start(crypto.randomUUID());
    assert.notEqual(next.id, first.id);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("local API rejects foreign origins, missing marker, and arbitrary execution input", async () => {
  let starts = 0;
  const service = {
    status: () => ({ current: null }),
    start: async () => {
      starts++;
      return { id: "test" };
    },
  };
  const server = createExperienceServer({
    service,
    upstream: "http://127.0.0.1:8788",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/api/local-codex/status`)).status, 403);
    assert.equal(
      (
        await fetch(`${origin}/api/local-codex/status`, {
          headers: { ...localHeader, Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    const get = await fetch(`${origin}/api/local-codex/status`, {
      headers: localHeader,
    });
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { current: null });
    const post = (body) =>
      fetch(`${origin}/api/local-codex/tests`, {
        method: "POST",
        headers: {
          ...localHeader,
          Origin: origin,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post({ requestId: crypto.randomUUID(), cwd: "C:/" })).status,
      400,
    );
    assert.equal((await post({ requestId: "../escape" })).status, 400);
    assert.equal(starts, 0);
    assert.equal((await post({ requestId: crypto.randomUUID() })).status, 202);
    assert.equal(starts, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("proxy preserves cookies and rewrites only a validated local origin", async () => {
  const worker = createServer((req, res) => {
    res.setHeader(
      "set-cookie",
      "session=local; HttpOnly; SameSite=Lax; Path=/",
    );
    res.end(
      JSON.stringify({
        cookie: req.headers.cookie,
        origin: req.headers.origin,
      }),
    );
  });
  await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${worker.address().port}`;
  const server = createExperienceServer({ service: {}, upstream });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/api/example`, {
      method: "POST",
      headers: { Origin: origin, Cookie: "session=local" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      cookie: "session=local",
      origin: upstream,
    });
    assert.match(response.headers.get("set-cookie"), /HttpOnly/);
    assert.equal(
      (
        await fetch(`${origin}/api/example`, {
          headers: { Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => worker.close(resolve));
  }
});

test("proxy rejects absolute request targets and forged Host headers", async () => {
  let reached = 0;
  const upstream = createServer((_req, res) => {
    reached++;
    res.end("unexpected");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const server = createExperienceServer({ service: {}, upstream: target });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const request = (path, host = `127.0.0.1:${port}`) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path, headers: { Host: host } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    assert.equal(await request(`${target}/secret`), 403);
    assert.equal(await request("/", "evil.test"), 403);
    assert.equal(reached, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("test launch is durable and idempotent; restart requires reconciliation of the same workspace", async () => {
  const stateDir = await mkdtemp(path.resolve(".tmp/agent-experience-test-"));
  const launches = [];
  const spawn = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    launches.push({ child, args });
    return child;
  };
  const options = { stateDir, projectRoot: process.cwd(), spawn };
  try {
    const service = new ExperienceService(options);
    const id = crypto.randomUUID();
    const first = await service.start(id);
    const repeated = await service.start(id);
    assert.equal(first.id, repeated.id);
    assert.equal(launches.length, 1);
    await assert.rejects(service.start(crypto.randomUUID()), /核对|运行/);
    const recovered = new ExperienceService(options);
    assert.equal((await recovered.status()).current.status, "needs_review");
    await assert.rejects(recovered.start(crypto.randomUUID()), /核对|运行/);
    await recovered.reconcile(id);
    assert.equal(launches.length, 2);
    assert.deepEqual(launches[0].args, launches[1].args);
    assert.ok(
      first.workspace.startsWith(path.join(stateDir, "projects") + path.sep),
    );
    const reportDir = `${first.workspace}.runner`;
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "report.json"),
      JSON.stringify({
        passed: true,
        finishedAt: new Date().toISOString(),
        runs: [{ key: "summary", result: { overview: "verified" } }],
      }),
    );
    launches[1].child.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await recovered.status()).current.status, "passed");
    assert.equal((await recovered.start(id)).status, "passed");
    assert.equal(launches.length, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
