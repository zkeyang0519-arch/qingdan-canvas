import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

for (const change of ["replacement", "close"]) {
  test(`a delayed project directory check rejects after client ${change}`, async (t) => {
    // Redirect only this module instance's filesystem import. All other filesystem
    // operations stay real; only the external directory lookup is deferred.
    const connectorUrl = new URL(
      `../connector.mjs?stat-fence=${change}`,
      import.meta.url,
    ).href;
    const fsUrl =
      "data:text/javascript," +
      encodeURIComponent(`
      // ${change}
      export { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
      export const entered = Promise.withResolvers();
      export const completion = Promise.withResolvers();
      export function stat() { entered.resolve(); return completion.promise; }
    `);
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (
          specifier === "node:fs/promises" &&
          context.parentURL === connectorUrl
        )
          return { url: fsUrl, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    let Connector, controlled;
    try {
      ({ Connector } = await import(connectorUrl));
      controlled = await import(fsUrl);
    } finally {
      hooks.deregister();
    }
    const c = new Connector({ stateDir: "unused", autoRetry: false });
    t.after(() => c.close());
    const original = {
      connected: true,
      readSession: async () => ({
        threadId: "old-thread",
        title: "old",
        cwd: "C:\\old",
        updatedAt: 1,
      }),
      close() {
        this.connected = false;
      },
    };
    c.client = original;
    c.view.status = "ready";
    const result = c.readSession("old-thread").then(
      (value) => ({ value }),
      (error) => ({ code: error.code }),
    );
    await controlled.entered.promise;
    if (change === "replacement") {
      c.client = {
        connected: true,
        close() {
          this.connected = false;
        },
      };
      c.connection.generation++;
    } else await c.close();
    controlled.completion.resolve({ isDirectory: () => true });
    assert.deepEqual(await result, { code: "CONNECTION_CHANGED" });
    assert.equal(
      c.status().status,
      change === "replacement" ? "ready" : "closed",
    );
  });
}
