import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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
