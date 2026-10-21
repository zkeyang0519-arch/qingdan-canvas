import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDeployConfig } from "./deploy-config.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
try {
  parseDeployConfig(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  console.log("部署配置检查通过（未部署）。");
  process.exit(0);
}
const run = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL(file, import.meta.url)), ...args],
      { cwd: root, stdio: "inherit", windowsHide: true },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`命令退出：${code}`)),
    );
  });
await run("../node_modules/vite/bin/vite.js", ["build"]);
await run("../node_modules/wrangler/bin/wrangler.js", ["deploy"]);
