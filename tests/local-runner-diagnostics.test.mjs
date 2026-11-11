import test from "node:test";
import assert from "node:assert/strict";
import { readLocalRunnerDiagnostics } from "../scripts/lib/local-runner-diagnostics.mjs";

const probe = (inspect, extra = {}) =>
  readLocalRunnerDiagnostics({
    projectRoot: process.cwd(),
    command: process.execPath,
    args: ["-e", "process.stdout.write('codex-cli 9.8.7-test\\n')", "--"],
    inspect,
    ...extra,
  });

test("diagnostics reports the executable version and reads only account state", async () => {
  const operations = [];
  const result = await probe((work) =>
    work(
      new Proxy(
        {},
        {
          get: (_, method) => async () => {
            operations.push(method);
            if (method !== "account")
              throw Error("A diagnostic must not start work");
            return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
          },
        },
      ),
    ),
  );
  assert.equal(result.codex.version, "9.8.7-test");
  assert.equal(result.codex.authenticated, true);
  assert.equal(result.codex.available, true);
  assert.deepEqual(operations, ["account"]);
  assert.equal(result.service.nodeVersion, process.versions.node);
});

test("a failed account probe preserves the observed version and leaves login unknown", async () => {
  const result = await probe(() => {
    throw Error("incompatible app-server");
  });
  assert.equal(result.codex.version, "9.8.7-test");
  assert.equal(result.codex.authenticated, null);
  assert.equal(result.codex.available, false);
  assert.match(result.codex.error, /检查/);
});

test("a failed executable probe never reports a configured version or a signed-out account", async () => {
  let inspected = false;
  const result = await probe(
    (work) => {
      inspected = true;
      return work({
        account: async () => ({
          account: { type: "chatgpt" },
          requiresOpenaiAuth: true,
        }),
      });
    },
    {
      args: ["-e", "process.exit(2)", "--"],
    },
  );
  assert.equal(result.codex.version, null);
  assert.equal(result.codex.authenticated, null);
  assert.equal(result.codex.available, false);
  assert.equal(inspected, false);
});

test("account state distinguishes a signed-out account from an auth-free provider", async () => {
  const signedOut = await probe((work) =>
    work({
      account: async () => ({ account: null, requiresOpenaiAuth: true }),
    }),
  );
  assert.equal(signedOut.codex.authenticated, false);
  const provider = await probe((work) =>
    work({
      account: async () => ({ account: null, requiresOpenaiAuth: false }),
    }),
  );
  assert.equal(provider.codex.authenticated, true);
});

test("an incomplete account result does not pretend that authentication succeeded", async () => {
  const result = await probe((work) => work({ account: async () => ({}) }));
  assert.equal(result.codex.authenticated, null);
  assert.equal(result.codex.available, false);
});
