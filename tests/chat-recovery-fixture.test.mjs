import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { chatRecoveryServer } from "./fixtures/chat-recovery-server.mjs";

const { Miniflare } = createRequire(
  new URL("../node_modules/wrangler/package.json", import.meta.url),
)("miniflare");

test("chat recovery fixture disposes its running worker when database setup fails", async (t) => {
  let cleanup,
    runtime,
    disposed = false;
  const originalDispose = Miniflare.prototype.dispose;
  t.mock.method(Miniflare.prototype, "getD1Database", async function () {
    runtime = this;
    await this.ready;
    throw Error("fixture database startup failure");
  });
  t.mock.method(Miniflare.prototype, "dispose", async function () {
    await originalDispose.call(this);
    if (this === runtime) disposed = true;
  });
  try {
    await assert.rejects(
      chatRecoveryServer({
        after: (callback) => {
          cleanup = callback;
        },
      }),
      /fixture database startup failure/,
    );
    assert.equal(typeof cleanup, "function");
    assert.ok(runtime);
    await cleanup();
    assert.equal(disposed, true);
  } finally {
    // Also clean up under the old, broken fixture so this regression can fail
    // without itself hanging the entire suite.
    if (!disposed) await runtime?.dispose();
  }
});
