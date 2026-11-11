import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: { index: "runner/index.ts", main: "runner/main.ts" },
  outdir: "runner/dist",
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  external: ["ws"],
  sourcemap: true,
  logLevel: "info",
});
await mkdir(new URL("../runner/dist/", import.meta.url), { recursive: true });
await copyFile(
  new URL("../runner/credential-helper.ps1", import.meta.url),
  new URL("../runner/dist/credential-helper.ps1", import.meta.url),
);
