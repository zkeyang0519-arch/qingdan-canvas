import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const vite = fileURLToPath(
  new URL("../node_modules/vite/bin/vite.js", import.meta.url),
);
let active;
const run = (file, args) =>
  new Promise((resolve, reject) => {
    active = spawn(process.execPath, [file, ...args], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    active.once("error", reject);
    active.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`命令退出：${code}`)),
    );
  });
process.on("SIGINT", () => {
  active?.kill("SIGINT");
  process.exit(0);
});
process.on("SIGTERM", () => {
  active?.kill();
  process.exit(0);
});
try {
  await run(vite, ["build"]);
  await run(wrangler, [
    "d1",
    "migrations",
    "apply",
    "qingdan-canvas",
    "--local",
  ]);
  console.log(
    "\n轻单协作画布：http://127.0.0.1:8788\n本地开发使用模拟 D1 / R2 / Durable Objects，不创建云端资源。\n",
  );
  await run(wrangler, [
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8788",
    "--inspector-port",
    "0",
    "--var",
    "APP_ENV:local",
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
