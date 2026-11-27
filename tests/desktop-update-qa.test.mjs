import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { configureUpdateQa } from "../desktop/qa-mode.cjs";
import { channelDetails } from "../desktop/channel.cjs";
test("beta identities, ports and cookies are separate from stable", () => {
  const a = channelDetails("0.3.12"),
    b = channelDetails("0.3.12-beta.1");
  for (const key of ["appId", "productName", "protocol", "publicHost"])
    assert.notEqual(a[key], b[key]);
  assert.notEqual(a.ports.app, b.ports.app);
  assert.notEqual(a.ports.web, b.ports.web);
});
test("installed updater QA is opt-in and restricted to beta and disposable CI profile", () => {
  const calls = [],
    app = { commandLine: { appendSwitch: (...args) => calls.push(args) } };
  const root = path.resolve(".tmp/disposable-runner"),
    profile = path.join(root, "profile");
  const env = {
    QINGDAO_UPDATE_QA: "1",
    RUNNER_ENVIRONMENT: "github-hosted",
    CI: "true",
    RUNNER_TEMP: root,
    QINGDAO_QA_FEED: "http://127.0.0.1:12345/updates/",
    QINGDAO_QA_DEBUG_PORT: "12346",
  };
  assert.equal(
    configureUpdateQa({ app, profile, channel: "beta", env: {} }),
    null,
  );
  for (const value of [
    { CI: "false" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { QINGDAO_QA_FEED: "https://example.com/updates/" },
    { QINGDAO_QA_DEBUG_PORT: "0" },
  ])
    assert.throws(() =>
      configureUpdateQa({
        app,
        profile,
        channel: "beta",
        env: { ...env, ...value },
      }),
    );
  assert.throws(() =>
    configureUpdateQa({ app, profile, channel: "stable", env }),
  );
  assert.throws(() =>
    configureUpdateQa({
      app,
      profile: path.dirname(root),
      channel: "beta",
      env,
    }),
  );
  assert.equal(calls.length, 0);
  assert.equal(
    configureUpdateQa({ app, profile, channel: "beta", env }).feed,
    env.QINGDAO_QA_FEED,
  );
  assert.deepEqual(calls, [
    ["remote-debugging-address", "127.0.0.1"],
    ["remote-debugging-port", "12346"],
  ]);
});

test("local acceptance requires the exact installed Beta, run marker and private profile without debugging", (t) => {
  const id = randomUUID(),
    root = path.resolve(".tmp", "qingdao-update-local-" + id),
    profile = path.join(root, "profile");
  mkdirSync(profile, { recursive: true });
  mkdirSync(path.join(root, "installed"));
  const executable = path.join(root, "installed", "QingdaoBeta.exe");
  writeFileSync(executable, "fixture");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    QINGDAO_UPDATE_QA: "local",
    QINGDAO_LOCAL_QA_ROOT: root,
    QINGDAO_LOCAL_QA_ID: id,
    QINGDAO_QA_FEED: "http://127.0.0.1:12345/updates/",
  };
  const app = {
    getPath: () => executable,
    commandLine: {
      appendSwitch: () => assert.fail("local QA must not expose debugging"),
    },
  };
  const options = { app, profile, channel: "beta", env };
  assert.throws(() => configureUpdateQa(options));
  writeFileSync(
    path.join(root, "qa-run.json"),
    JSON.stringify({ schema: 1, id, feed: env.QINGDAO_QA_FEED }),
  );
  assert.deepEqual(configureUpdateQa(options), { feed: env.QINGDAO_QA_FEED });
  assert.throws(() => configureUpdateQa({ ...options, channel: "stable" }));
  assert.throws(() => configureUpdateQa({ ...options, profile: root }));
  assert.throws(() =>
    configureUpdateQa({
      ...options,
      env: { ...env, QINGDAO_LOCAL_QA_ID: "another" },
    }),
  );
  assert.throws(() =>
    configureUpdateQa({
      ...options,
      env: { ...env, QINGDAO_QA_FEED: "https://example.com/updates/" },
    }),
  );
});
