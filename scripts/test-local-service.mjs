import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createManagedLocalService } from "../desktop/local-service.cjs";
const root = path.resolve(".tmp/local-service-package");
const manifest = JSON.parse(
  await readFile(path.join(root, "runtime.json"), "utf8"),
);
const directory = await mkdtemp(path.resolve(".tmp/local-service-smoke-"));
const port = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
const ports = { app: await port(), web: await port() };
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(path|pathext|systemroot|windir|comspec|tmp|temp|userprofile|appdata|localappdata|systemdrive|node_extra_ca_certs|ssl_cert_file|https?_proxy|no_proxy)$/i.test(
      key,
    ),
  ),
);
let diagnostic = "",
  service;
try {
  service = createManagedLocalService({
    root,
    dataDir: directory,
    version: manifest.version,
    ports,
    environment,
    spawnProcess: (command, args, options) => {
      const child = spawn(command, args, {
        ...options,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      child.stderr.on("data", (value) => {
        diagnostic = (diagnostic + value).slice(-12000);
      });
      return child;
    },
  });
  assert.equal((await service.start()).status, "online");
  const origin = "http://127.0.0.1:" + ports.app;
  const response = await fetch(origin + "/api/local-service/version", {
    headers: { Origin: origin },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, manifest.version);
  const web = await fetch(origin + "/app", {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(web.status, 200);
  assert.match(await web.text(), /<html/i);
  const signin = await service.openWorkspace({
    origin: "https://todo.zky.lol",
    accountId: "isolated-qa-account",
    name: "隔离验收账号",
    expiresAt: Date.now() + 3600000,
  });
  const ticket = await fetch(signin.url, {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(ticket.status, 303);
  const cookie = ticket.headers.get("set-cookie").split(";")[0];
  const sessionBefore = await (
    await fetch(origin + "/api/session", { headers: { Cookie: cookie } })
  ).json();
  assert.equal(sessionBefore.user.name, "隔离验收账号");
  const auth = {
    Cookie: cookie,
    Origin: origin,
    "X-QD-Account": sessionBefore.user.id,
    "Content-Type": "application/json",
  };
  const configured = await fetch(origin + "/api/agent/chat/models", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      action: "add",
      service: "验收用模型",
      model: "qa-model",
      baseUrl: "https://models.example.com/v1",
      apiKey: "isolated-qa-key-not-real",
      apiFormat: "responses",
    }),
  });
  assert.equal(configured.status, 200);
  const modelsBefore = await configured.json();
  const profile = modelsBefore.profiles.find(
    (item) => item.model === "qa-model",
  );
  assert.ok(profile);
  const selected = await fetch(origin + "/api/agent/chat/models", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ action: "default", id: profile.id }),
  });
  assert.equal(selected.status, 200);
  const pairing = await fetch(origin + "/api/agent/devices/pairings", {
    method: "POST",
    headers: auth,
    body: "{}",
  });
  assert.equal(
    pairing.status,
    200,
    "managed runtime must permit its configured loopback port for pairing",
  );
  const native = await fetch(
    "http://127.0.0.1:" + ports.web + "/api/runner/execution/poll",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(
    native.status,
    401,
    "native authentication must still be required on the configured port",
  );
  const fixture = {
    model: "existing-model-fixture",
    mcp: "existing-mcp-fixture",
    remoteReceipt: "original-waao-receipt",
    draft: "未提交输入",
    project: "isolated-project",
  };
  const retained = path.join(directory, "data", "persistence-fixture.json");
  await mkdir(path.dirname(retained), { recursive: true });
  await writeFile(retained, JSON.stringify(fixture));
  assert.deepEqual((await service.status()).tasks, []);
  assert.equal((await service.pause()).paused, true);
  const blocked = await fetch(origin + "/api/agent/chat/send", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(blocked.status, 423);
  assert.equal((await service.checkpoint()).ok, true);
  assert.equal((await service.stop()).stopped, true);
  assert.deepEqual(JSON.parse(await readFile(retained, "utf8")), fixture);
  assert.equal((await service.start()).status, "online");
  await service.resume();
  assert.deepEqual(JSON.parse(await readFile(retained, "utf8")), fixture);
  const sessionAfter = await (
    await fetch(origin + "/api/session", { headers: { Cookie: cookie } })
  ).json();
  assert.equal(sessionAfter.user.id, sessionBefore.user.id);
  const modelsAfter = await (
    await fetch(origin + "/api/agent/chat/models", { headers: auth })
  ).json();
  assert.equal(modelsAfter.defaultId, profile.id);
  assert.equal(
    modelsAfter.profiles.find((item) => item.id === profile.id).model,
    "qa-model",
  );
  assert.equal(
    (await fetch(signin.url, { redirect: "manual" })).status,
    401,
    "login handoff tickets cannot be reused",
  );
  await service.pause();
  await service.stop();
  console.log(
    JSON.stringify({
      version: manifest.version,
      isolated: true,
      realRuntime: true,
      start: "passed",
      pause: "passed",
      checkpoint: "passed",
      restart: "passed",
      session: "restored",
      model: "restored",
      retainedFixture: "passed",
      note: "Real local service and session/model restore; installer and renderer restoration are separate acceptance.",
    }),
  );
} catch (error) {
  console.error(error.message);
  if (diagnostic) console.error(diagnostic);
  process.exitCode = 1;
} finally {
  if (service?.state().status === "online") {
    await service.pause().catch(() => {});
    await service.stop().catch(() => {});
  }
  if (!["online", "starting"].includes(service?.state().status)) {
    const target = path.resolve(directory),
      parent = path.resolve(".tmp");
    if (
      path.dirname(target) !== parent ||
      !path.basename(target).startsWith("local-service-smoke-")
    )
      throw Error("Unexpected smoke cleanup directory");
    await rm(target, { recursive: true, force: true }).catch(() => {});
  }
}
