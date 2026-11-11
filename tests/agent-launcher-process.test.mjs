import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import * as manager from "../scripts/lib/agent-install.mjs";
import {
  lifecycleCheckout,
  until,
  pause,
} from "./fixtures/lifecycle-checkout.mjs";

test(
  "shutdown during source control registration drains the late endpoint before exit",
  { timeout: 10000 },
  async (t) => {
    const f = await lifecycleCheckout(t, true);
    const marker = path.join(f.root, "control-drained");
    await writeFile(
      path.join(f.root, "scripts/lib/agent-install-bridge.mjs"),
      `
    export * from ${JSON.stringify(new URL("../scripts/lib/agent-install-bridge.mjs", import.meta.url).href)};
    import { openSourceControl as open } from ${JSON.stringify(new URL("../scripts/lib/agent-install-bridge.mjs", import.meta.url).href)};
    import { writeFileSync } from 'node:fs';
    export async function openSourceControl(options) {
      await new Promise(resolve => setTimeout(resolve, 20));
      process.emit('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 50));
      const control = await open(options), close = control.close;
      control.close = () => { writeFileSync(${JSON.stringify(marker)}, 'drained'); return close(); };
      return control;
    }
  `,
    );
    const child = await f.launch();
    await until(() => child.exitCode !== null || child.signalCode !== null);
    assert.equal(
      await readFile(marker, "utf8").catch(() => "missing"),
      "drained",
      "late source control escaped the shared close drain",
    );
    assert.equal(
      (await f.events()).filter((event) => event.event === "controller-created")
        .length,
      0,
    );
  },
);

for (const source of [true, false]) {
  test(
    `${source ? "source" : "installed"} launcher preserves the real pending Controller through web failures and HMAC CLI recovery`,
    { timeout: 35000 },
    async (t) => {
      const f = await lifecycleCheckout(t, source);
      await f.launch();
      await until(async () =>
        (await f.events()).some((event) => event.event === "web-exit"),
      );
      await pause(150);
      assert.equal(
        (await f.events()).filter(
          (event) => event.event === "controller-close-begin",
        ).length,
        0,
        "first web failure closed the Runner",
      );
      await until(
        async () =>
          (await manager.diagnose(f.options)).status === "recovery_required",
      );
      const before = await manager.diagnose(f.options),
        events = await f.events();
      assert.equal(
        events.filter((event) => event.event === "web-exit").length,
        4,
      );
      for (const name of ["build", "controller-created", "controller-start"])
        assert.equal(events.filter((event) => event.event === name).length, 1);
      assert.equal(
        events.filter((event) => event.event === "controller-close-begin")
          .length,
        0,
      );
      assert.ok(
        events.filter((event) => event.event === "pair-token").length >= 3,
        "real N6 pairing retries stopped with the web backend",
      );
      const runnerId = await readFile(path.join(f.root, "runner-id"), "utf8");
      await writeFile(path.join(f.root, "web-allow"), "yes");
      const result = await f.recoverCli();
      assert.equal(result.accepted, true);
      await until(async () => (await manager.diagnose(f.options)).ready);
      const recovered = await manager.diagnose(f.options);
      assert.equal(recovered.pid, before.pid);
      assert.equal(recovered.instanceId, before.instanceId);
      assert.equal(
        (await f.events()).filter(
          (event) => event.event === "controller-created",
        ).length,
        1,
      );
      assert.equal(
        await readFile(path.join(f.root, "runner-id"), "utf8"),
        runnerId,
      );
      // Crash only this fixture launcher, then use the normal manual start path.
      process.kill(recovered.pid, "SIGKILL");
      await until(() => !manager.processExists(recovered.pid));
      await until(
        async () =>
          (await f.options.probePort(8790)) &&
          (await f.options.probePort(8788)),
      );
      await manager.stop(f.options);
      await f.launch();
      await until(async () => (await manager.diagnose(f.options)).ready);
      assert.equal(
        await readFile(path.join(f.root, "runner-id"), "utf8"),
        runnerId,
      );
      assert.notEqual(
        (await manager.diagnose(f.options)).instanceId,
        before.instanceId,
      );
      await manager.stop(f.options);
      const final = await f.events();
      assert.equal(
        final.filter((event) => event.event === "controller-close-begin")
          .length,
        1,
      );
      assert.equal(
        final.filter((event) => event.event === "controller-close-end").length,
        1,
      );
    },
  );
}
