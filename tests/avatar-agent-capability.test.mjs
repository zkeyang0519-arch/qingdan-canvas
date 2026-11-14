import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["worker/avatars.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { updateAvatar } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

for (const [environment, enabled] of [
  ["local", true],
  ["test", true],
  ["production", false],
  ["preview", false],
]) {
  test(`${environment} avatar updates retain the authoritative Agent capability`, async () => {
    const pending = [];
    const env = {
      APP_ENV: environment,
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } }),
            all: async () => ({ results: [] }),
          }),
        }),
      },
      FILES: { put: async () => {}, delete: async () => {} },
    };
    const user = { id: "avatar-fixture", username: "fixture", name: "Test" };
    for (const method of ["PUT", "DELETE"]) {
      const response = await updateAvatar(
        new Request("https://release.invalid/api/profile/avatar", {
          method,
          ...(method === "PUT"
            ? {
                headers: { "Content-Type": "image/png" },
                body: Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=",
                  "base64",
                ),
              }
            : {}),
        }),
        env,
        user,
        { waitUntil: (promise) => pending.push(promise) },
      );
      assert.equal(response.status, 200);
      const session = await response.json();
      assert.equal(session.user.id, user.id);
      assert.deepEqual(session.features, { agent: enabled }, method);
      user.avatar_version = session.user.avatarVersion;
    }
    await Promise.all(pending);
  });
}
