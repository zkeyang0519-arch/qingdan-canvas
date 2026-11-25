import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const stage = path.resolve(root, ".tmp/local-service-package");
const pkg = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const version = process.env.QINGDAO_BUILD_VERSION || pkg.version;
if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version))
  throw Error("Invalid local service build version");
if (Number(process.versions.node.split(".")[0]) < 24)
  throw Error("Build the local service with Node.js 24 or newer.");
const npm = process.env.npm_execpath;
if (!npm) throw Error("Run through npm run desktop:service:package.");
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npm, ...args], {
      cwd: stage,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error("Local service dependency staging failed: " + code)),
    );
  });
await fs.mkdir(stage, { recursive: true });
if (
  (await fs.lstat(stage)).isSymbolicLink() ||
  path.dirname(stage) !== path.join(root, ".tmp")
)
  throw Error("Unsafe local service staging path");
const sourceDirs = [
  "scripts",
  "shared",
  "runner",
  "worker",
  "migrations",
  "codex-connector",
  "desktop",
  "web",
];
for (const name of sourceDirs) {
  const target = path.resolve(stage, name);
  if (path.dirname(target) !== stage) throw Error("Unsafe staged source path");
  await fs.rm(target, { recursive: true, force: true });
}
for (const name of [
  "scripts",
  "shared",
  "runner",
  "worker",
  "migrations",
  "codex-connector",
]) {
  await fs.cp(path.join(root, name), path.join(stage, name), {
    recursive: true,
    filter: async (file) => {
      const info = await fs.lstat(file);
      if (info.isSymbolicLink()) return false;
      const relative = path.relative(path.join(root, name), file);
      if (
        relative
          .split(path.sep)
          .some(
            (p) =>
              p.startsWith(".") ||
              ["node_modules", "output", "tests"].includes(p),
          )
      )
        return false;
      return (
        info.isDirectory() ||
        /\.(?:mjs|cjs|js|ts|json|ps1|sql|txt|html)$/.test(file)
      );
    },
  });
}
await fs.mkdir(path.join(stage, "desktop"), { recursive: true });
for (const name of (await fs.readdir(path.join(root, "desktop"))).filter(
  (name) => name.endsWith(".cjs"),
))
  await fs.copyFile(
    path.join(root, "desktop", name),
    path.join(stage, "desktop", name),
  );
await fs.cp(path.join(root, "dist"), path.join(stage, "web"), {
  recursive: true,
});
await fs.copyFile(process.execPath, path.join(stage, "node.exe"));
await fs.writeFile(
  path.join(stage, "service.mjs"),
  'import "./scripts/desktop-service.mjs";\n',
);
await build({
  absWorkingDir: root,
  entryPoints: ["worker/index.ts"],
  outfile: path.join(stage, "worker.mjs"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "browser", "import"],
  mainFields: ["module", "main"],
  external: ["cloudflare:*", "node:*"],
  loader: { ".html": "text", ".sql": "text", ".txt": "text" },
  logLevel: "info",
});
const dependencies = Object.fromEntries(
  [
    "@earendil-works/pi-coding-agent",
    "qingdan-pi-cli",
    "@earendil-works/pi-mcp",
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/server",
    "ws",
    "zod",
    "esbuild",
    "wrangler",
    "jsonc-parser",
    "js-yaml",
    "fflate",
  ].map((name) => [name, pkg.dependencies[name] || pkg.devDependencies[name]]),
);
const lockText = await fs.readFile(
  path.join(root, "package-lock.json"),
  "utf8",
);
const dependencyDigest = createHash("sha256")
  .update(JSON.stringify(dependencies) + lockText)
  .digest("hex");
const previous = JSON.parse(
  await fs.readFile(path.join(stage, "runtime.json"), "utf8").catch(() => "{}"),
);
const dependenciesPresent = await fs
  .access(path.join(stage, "node_modules/wrangler/package.json"))
  .then(
    () => true,
    () => false,
  );
const runtimePackage = {
  name: "qingdao-local-service",
  version,
  private: true,
  type: "module",
  engines: { node: ">=24" },
  dependencies,
};
await fs.writeFile(
  path.join(stage, "package.json"),
  JSON.stringify(runtimePackage, null, 2),
);
const lock = JSON.parse(lockText);
lock.name = runtimePackage.name;
lock.version = version;
lock.packages[""] = { ...runtimePackage };
delete lock.packages[""].private;
delete lock.packages[""].type;
if (
  !dependenciesPresent ||
  previous.dependencyDigest !== dependencyDigest ||
  process.argv.includes("--force-dependencies")
) {
  await fs.writeFile(
    path.join(stage, "package-lock.json"),
    JSON.stringify(lock, null, 2),
  );
  await run([
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  await run([
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
}
const workerDigest = createHash("sha256")
  .update(await fs.readFile(path.join(stage, "worker.mjs")))
  .digest("hex");
await fs.writeFile(
  path.join(stage, "runtime.json"),
  JSON.stringify(
    {
      version,
      protocol: 1,
      dataSchema: 1,
      nodeVersion: process.versions.node,
      workerDigest,
      dependencyDigest,
    },
    null,
    2,
  ),
);
console.log(
  "Packaged local service " +
    version +
    " with matching worker, Runner, Pi and Node runtime.",
);
