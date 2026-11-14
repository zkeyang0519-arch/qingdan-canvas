import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createExperienceServer } from "./lib/agent-experience-server.mjs";
import { ExperienceService } from "./lib/agent-experience-service.mjs";
import { stopOwnedChild } from "./lib/stop-child.mjs";
import {
  startExperience,
  createWebSupervisor,
} from "./lib/agent-experience-launcher.mjs";
import {
  hasLifecycleControl,
  openSourceControl,
  setLifecycleHooks,
  closeLifecycleControl,
} from "./lib/agent-install-bridge.mjs";
import { createLocalRunnerApi } from "./lib/local-runner-api.mjs";
import { createLocalDesktopApi } from "./lib/local-desktop-api.mjs";
import { createDesktopLauncher } from "./lib/desktop-launcher.mjs";
import { readLocalRunnerDiagnostics } from "./lib/local-runner-diagnostics.mjs";
import {
  prepareExecutionTrial,
  listExecutionProjects,
} from "./lib/execution-trial.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (Number(process.versions.node.split(".")[0]) < 24)
  throw Error("本机 Codex 体验需要 Node.js 24 或以上版本。");
let child,
  service,
  deviceController,
  sourceControlOpening,
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
  desktopApi: createLocalDesktopApi({
    upstream: "http://127.0.0.1:8788",
    launch: createDesktopLauncher({ projectRoot: root }).launch,
  }),
  runnerApi: createLocalRunnerApi({
    getController: () => deviceController,
    upstream: "http://127.0.0.1:8788",
    getDiagnostics: () =>
      readLocalRunnerDiagnostics({
        projectRoot: root,
        inspect: (work) => {
          if (!service) throw Error("本机服务正在准备。");
          return service.inspect(work);
        },
      }),
    prepareTrial: (input) =>
      prepareExecutionTrial({ ...input, projectRoot: root }),
    listTrials: ({ ownerId, state }) =>
      listExecutionProjects({
        projectRoot: root,
        ownerId,
        workspaces: state.workspaces,
      }),
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
        QINGDAN_EXECUTION_ENABLED: "true",
        QINGDAN_CHAT_ENABLED: "true",
        QINGDAN_PROJECT_SUMMARY_ENABLED: "true",
        QINGDAN_BATCH_QUEUE_ENABLED: "true",
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
const supervisor = createWebSupervisor({
  run: () => run(path.join(root, "scripts/dev.mjs")),
  onState: (state) => {
    if (state.phase === "recovery_required")
      console.error(
        "网页后端重试已耗尽；Runner 状态保留。请运行 recover-web 恢复网页服务。",
      );
  },
});
setLifecycleHooks({
  status: supervisor.status,
  recoverWeb: () => {
    if (closing) throw Error("Launcher is closing.");
    return supervisor.recover();
  },
});
let closePromise;
function close() {
  if (closePromise) return closePromise;
  closing = true;
  supervisor.close();
  closePromise = (async () => {
    // N6 owns cancellation and queue drain. Never clear its pending timer or
    // replace the controller merely because the web child is unavailable.
    await deviceController?.close();
    await service?.close();
    await stopOwnedChild(child);
    server.closeConnections();
    await new Promise((resolve) => server.close(resolve));
    // Registration performs async ACL/lock work. A signal during that wait must
    // drain its late endpoint as part of this same shutdown promise.
    await sourceControlOpening?.catch(() => {});
    await closeLifecycleControl();
  })();
  return closePromise;
}
const requestClose = () => {
  void close().catch((error) => console.error(error.message));
};
process.once("SIGINT", requestClose);
process.once("SIGTERM", requestClose);
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8790, "127.0.0.1", resolve);
  });
  const sourceMode = !hasLifecycleControl();
  if (sourceMode && !closing) {
    sourceControlOpening = openSourceControl({ root });
    await sourceControlOpening;
  }
  console.log(
    `本机管理：node scripts/agent-install.mjs diagnose${sourceMode ? " --source" : ""}；网页恢复：node scripts/agent-install.mjs recover-web${sourceMode ? " --source" : ""}`,
  );
  await startExperience({
    root,
    run,
    isClosing: () => closing,
    supervisor,
    onReady: async () => {
      const { RunnerDeviceController } =
        await import("../runner/dist/index.js");
      if (closing) return;
      service = new ExperienceService({ projectRoot: root });
      deviceController = new RunnerDeviceController({
        stateDir: path.join(root, ".tmp/runner-device"),
        serverOrigin: "http://127.0.0.1:8788",
        executionEnabled: true,
      });
      await deviceController.start();
      if (closing) return;
      console.log(
        "\n轻单 Agent 入口：http://127.0.0.1:8790\n登录并进入画布后，点击顶部“Agent”；电脑设置中可查看诊断与恢复。\n",
      );
    },
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await close();
}
