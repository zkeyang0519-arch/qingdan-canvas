import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
const root = fileURLToPath(new URL("..", import.meta.url));
await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
await build({
  entryPoints: [path.join(root, "desktop/portable-state.mjs")],
  bundle: true,
  format: "iife",
  globalName: "QingdaoPortable",
  outfile: path.join(root, ".tmp/portable-state.js"),
});
const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const input = process.argv.slice(2),
  forwarded = [];
for (let i = 0; i < input.length; i += 2) {
  if (
    !["--profile", "--origin", "--account", "--output"].includes(input[i]) ||
    !input[i + 1]
  )
    throw Error("参数需为 --profile、--origin、--account、--output 及其值。");
  // Electron's default launcher can interpret standalone argument values as
  // another app entry. Keep each named value in a single argument.
  forwarded.push(`--qingdao-${input[i].slice(2)}=${input[i + 1]}`);
}
const child = spawn(
  electron,
  [path.join(root, "desktop/export-portable.cjs"), ...forwarded],
  { env, stdio: "inherit", windowsHide: true },
);
child.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
