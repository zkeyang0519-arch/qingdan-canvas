import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["runner/index.ts"],
  outfile: "runner/dist/index.js",
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  sourcemap: true,
  logLevel: "info",
});
