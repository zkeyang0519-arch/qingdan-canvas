import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const { outputFiles } = await build({
  entryPoints: ["worker/execution/trusted-origin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const { trustedExecutionOrigin: allows } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
test("managed execution trusts only its explicit local listener while production requires HTTPS", () => {
  const env = {
    APP_ENV: "local",
    RUNTIME_CONTROL_SECRET: "private-host-secret",
    LOCAL_RUNTIME_ORIGIN: "http://127.0.0.1:8793",
  };
  assert.equal(
    allows(new URL("http://127.0.0.1:8793/api/agent/devices"), env),
    true,
  );
  assert.equal(
    allows(new URL("http://127.0.0.1:8788/api/runner/pair"), {
      APP_ENV: "test",
    }),
    true,
  );
  for (const changed of [
    { APP_ENV: "production" },
    { RUNTIME_CONTROL_SECRET: undefined },
    { LOCAL_RUNTIME_ORIGIN: "http://example.com:8793" },
    { LOCAL_RUNTIME_ORIGIN: "http://127.0.0.1:8793/path" },
  ])
    assert.equal(
      allows(new URL("http://127.0.0.1:8793/api/agent/devices"), {
        ...env,
        ...changed,
      }),
      false,
    );
  assert.equal(
    allows(new URL("http://127.0.0.1:8794/api/agent/devices"), env),
    false,
  );
  assert.equal(
    allows(new URL("http://127.0.0.1:8788/api/agent/devices"), {
      ...env,
      APP_ENV: "production",
    }),
    false,
  );
  assert.equal(
    allows(new URL("https://example.com/api/agent/devices"), {
      APP_ENV: "production",
    }),
    true,
  );
});
