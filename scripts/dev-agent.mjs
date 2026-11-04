import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createExperienceServer } from "./lib/agent-experience-server.mjs";
import { ExperienceService } from "./lib/agent-experience-service.mjs";
import { stopOwnedChild } from "./lib/stop-child.mjs";
import { startExperience } from "./lib/agent-experience-launcher.mjs";
import { createLocalRunnerApi } from "./lib/local-runner-api.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (Number(process.versions.node.split(".")[0]) < 24)
  throw Error("本机 Codex 体验需要 Node.js 24 或以上版本。");
let child,
  service,
  deviceController,
  closing = false;
// Bind before touching the durable harness state: a second launcher must not
// alter the running launcher's sessions or open another Codex process.
const server = createExperienceServer({
  service: new Proxy(
    {},
    {
      get:
        (_, key) =>
        (...args) => {
          if (!service) throw Error("本机服务正在准备，请稍后重试。");
          return service[key](...args);
        },
    },
  ),
  upstream: "http://127.0.0.1:8788",
  runnerApi: createLocalRunnerApi({
    getController: () => deviceController,
    upstream: "http://127.0.0.1:8788",
  }),
});
const run = (script, args = []) =>
  new Promise((resolve, reject) => {
    if (closing) {
      resolve();
      return;
    }
    child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: path.join(root, ".tmp/wrangler-logs/"),
        QINGDAN_RUNNER_ENABLED: "true",
      },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 || closing
        ? resolve()
        : reject(Error(`开发服务退出：${code}`)),
    );
  });
async function close() {
  if (closing) return;
  closing = true;
  await deviceController?.close();
  await service?.close();
  await stopOwnedChild(child);
  server.closeConnections();
  server.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8790, "127.0.0.1", resolve);
  });
  await startExperience({
    root,
    run,
    isClosing: () => closing,
    onReady: async () => {
      const { RunnerDeviceController } =
        await import("../runner/dist/index.js");
      if (closing) return;
      service = new ExperienceService({ projectRoot: root });
      deviceController = new RunnerDeviceController({
        stateDir: path.join(root, ".tmp/runner-device"),
        serverOrigin: "http://127.0.0.1:8788",
      });
      await deviceController.start();
      if (closing) {
        await deviceController.close();
        return;
      }
      console.log(
        "\n轻单 Agent 体验入口：http://127.0.0.1:8790\n登录并进入画布后，点击右上角“Agent 验证”。\n",
      );
    },
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await close();
}
