import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const stage = path.join(root, ".tmp", "desktop-package");
const args = process.argv.slice(2);
const run = (command, commandArgs, cwd = root) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`Desktop build exited ${code}`)),
    );
  });
const npm = process.env.npm_execpath;
if (!npm) throw Error("Run this script through npm run desktop:package.");
const pkg = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const desktopPkg = JSON.parse(
  await fs.readFile(path.join(root, "desktop", "package.json"), "utf8"),
);
if (pkg.version !== desktopPkg.version)
  throw Error("Desktop and root package versions must match.");
// All contents are copied from an explicit allowlist. Never package the checkout,
// .dev.vars, source profile, Agent credentials, or Cloudflare deployment files.
if (!args.includes("--skip-web-build"))
  await run(process.execPath, [
    path.join(root, "node_modules/vite/bin/vite.js"),
    "build",
  ]);
await fs.access(path.join(root, "dist", "index.html"));
// Keep node_modules between builds; replace only the bounded staged source trees.
await fs.mkdir(stage, { recursive: true });
for (const directory of ["desktop", "shared"]) {
  const target = path.resolve(stage, directory);
  if (path.dirname(target) !== stage) throw Error("Invalid staging path");
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
}
for (const file of await fs.readdir(path.join(root, "desktop"))) {
  if (file.endsWith(".cjs"))
    await fs.copyFile(
      path.join(root, "desktop", file),
      path.join(stage, "desktop", file),
    );
}
await fs.copyFile(
  path.join(root, "shared/desktop-origins.cjs"),
  path.join(stage, "shared/desktop-origins.cjs"),
);
for (const file of ["package.json", "package-lock.json"])
  await fs.copyFile(path.join(root, "desktop", file), path.join(stage, file));
await run(
  process.execPath,
  [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  stage,
);
await run(process.execPath, [
  path.join(root, "node_modules/electron-builder/out/cli/cli.js"),
  "--config",
  "electron-builder.config.cjs",
  "--win",
  "--x64",
  "--publish",
  "never",
  ...(args.includes("--dir") ? ["--dir"] : []),
  `--config.electronVersion=${pkg.devDependencies.electron}`,
  ...(process.env.QINGDAO_REQUIRE_SIGNING === "true"
    ? ["--config.forceCodeSigning=true"]
    : []),
  ...(process.env.CI
    ? []
    : [
        `--config.electronDist=${path.join(root, "node_modules/electron/dist")}`,
      ]),
]);
