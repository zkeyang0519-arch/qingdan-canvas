import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import profileLocation from "../../desktop/profile-location.cjs";
import { createDesktopInstallation } from "./desktop-installation.mjs";
import {
  createDesktopHandoff,
  validateDesktopContext,
} from "./desktop-handoff-broker.mjs";

const {
  installedDesktopExecutable,
  registerDesktopProfile,
  resolveDesktopProfile,
} = profileLocation;

function childOutcome(child, event) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      child.removeListener(event, completed);
      reject(error);
    };
    const completed = (code) => {
      child.removeListener("error", failed);
      resolve(code);
    };
    child.once("error", failed);
    child.once(event, completed);
  });
}

export function createDesktopLauncher({
  projectRoot,
  env = process.env,
  onStatus = () => {},
  spawnImpl = spawn,
  fsImpl = fs,
  electronDirectory,
  nodePath = process.execPath,
  now = Date.now,
  cooldownMs = 1000,
  createHandoffImpl = createDesktopHandoff,
  installationManager,
} = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot))
    throw new Error("桌面启动器需要项目的绝对路径。");
  const root = path.resolve(projectRoot);
  const environment = { ...env };
  // Editors built on Electron can export this. The companion needs GUI mode.
  delete environment.ELECTRON_RUN_AS_NODE;
  const desktopInstallation =
    installationManager ||
    (process.platform === "win32" &&
    environment.LOCALAPPDATA &&
    !environment.QINGDAN_DESKTOP_PROFILE &&
    environment.QINGDAN_DESKTOP_SOURCE !== "1"
      ? createDesktopInstallation({ projectRoot: root, env: environment })
      : null);
  const profile = path.resolve(
    environment.QINGDAN_DESKTOP_PROFILE ||
      path.join(root, ".tmp/desktop-profile"),
  );
  let pending = null,
    recent = null,
    lastStartedAt = -Infinity;
  let installation = null,
    handoffTail = Promise.resolve(),
    lastHandoff = null;

  function runtimePath(directory) {
    const marker = path.join(directory, "path.txt");
    if (!fsImpl.existsSync(marker)) return null;
    const relative = fsImpl.readFileSync(marker, "utf8").trim();
    if (!relative || path.isAbsolute(relative)) return null;
    const dist = path.join(directory, "dist");
    const candidate = path.resolve(dist, relative);
    const within = path.relative(dist, candidate);
    if (
      !within ||
      within === ".." ||
      within.startsWith(".." + path.sep) ||
      path.isAbsolute(within)
    )
      return null;
    return fsImpl.existsSync(candidate) && fsImpl.statSync(candidate).isFile()
      ? candidate
      : null;
  }

  async function launchOnce(context, signal, report) {
    const status = (message) => {
      onStatus(message);
      report?.(message);
    };
    signal?.throwIfAborted();
    let installedExecutable = installedDesktopExecutable({
      env: environment,
      fsImpl,
    });
    const selectedProfile =
      installedExecutable &&
      !environment.QINGDAN_DESKTOP_PROFILE &&
      environment.APPDATA
        ? registerDesktopProfile({
            appData: environment.APPDATA,
            profile,
            fsImpl,
          })
        : resolveDesktopProfile({
            projectRoot: root,
            appData: environment.APPDATA,
            env: environment,
            fsImpl,
          });
    const provisioned = desktopInstallation
      ? await desktopInstallation.ensure({
          profile: selectedProfile,
          signal,
          onStatus: status,
        })
      : null;
    if (provisioned) installedExecutable = provisioned.executable;
    if (signal?.aborted && provisioned?.changed) {
      // Installation has already committed. Restore the last saved canvas even
      // if the browser disappeared; never reuse a cancelled login handoff.
      context = undefined;
      signal = undefined;
    }
    signal?.throwIfAborted();
    const launchEnvironment = {
      ...environment,
      QINGDAN_DESKTOP_PROFILE: selectedProfile,
      ...(installedExecutable && !environment.QINGDAN_DESKTOP_PROFILE
        ? { QINGDAN_DESKTOP_WEB_LAUNCH_PORT: "8791" }
        : {}),
    };
    let directory;
    if (!installedExecutable)
      try {
        directory = electronDirectory
          ? path.resolve(electronDirectory)
          : path.dirname(
              createRequire(path.join(root, "package.json")).resolve(
                "electron",
              ),
            );
      } catch (error) {
        throw new Error("桌面依赖未安装，请先在轻单项目运行 npm ci。", {
          cause: error,
        });
      }
    let executable = installedExecutable || runtimePath(directory);
    if (!executable) {
      status("首次使用正在下载桌面运行时，请稍候（仅首次需要）…");
      if (!installation)
        installation = (async () => {
          try {
            const installer = spawnImpl(
              nodePath,
              [path.join(directory, "install.js")],
              {
                cwd: root,
                env: { ...environment },
                stdio: ["ignore", "inherit", "inherit"],
                shell: false,
                windowsHide: true,
              },
            );
            if ((await childOutcome(installer, "exit")) !== 0)
              throw new Error("installer exited unsuccessfully");
          } catch (error) {
            throw new Error(
              "桌面运行时下载未完成，请运行 npm run desktop:install 后重试。",
              { cause: error },
            );
          }
        })().finally(() => {
          installation = null;
        });
      await installation;
      executable = runtimePath(directory);
      if (!executable)
        throw new Error(
          "桌面运行时未就绪，请检查下载设置并运行 npm run desktop:install。",
        );
    }

    let output;
    try {
      fsImpl.mkdirSync(selectedProfile, { recursive: true });
      output = fsImpl.openSync(path.join(selectedProfile, "desktop.log"), "a");
    } catch (error) {
      throw new Error("无法准备桌面日志目录，请检查项目目录权限后重试。", {
        cause: error,
      });
    }
    let broker, abort;
    try {
      signal?.throwIfAborted();
      if (context) broker = await createHandoffImpl(context);
      if (broker && signal) {
        abort = () => {
          void broker.close();
        };
        signal.addEventListener("abort", abort, { once: true });
        signal.throwIfAborted();
      }
      const child = spawnImpl(
        executable,
        [
          ...(!installedExecutable
            ? [path.join(root, "desktop/main.cjs")]
            : []),
          ...(broker ? ["--qingdan-desktop-handoff"] : []),
        ],
        {
          cwd: root,
          env: launchEnvironment,
          detached: true,
          shell: false,
          windowsHide: true,
          stdio: [broker ? "pipe" : "ignore", output, output],
        },
      );
      await childOutcome(child, "spawn");
      if (broker)
        await new Promise((resolve, reject) => {
          const fail = () =>
            reject(new Error("桌面交接管道不可用，请退出旧版桌面窗口后重试。"));
          child.stdin.once("error", fail);
          child.stdin.end(JSON.stringify(broker.descriptor), (error) => {
            if (error) fail();
            else resolve();
          });
        });
      child.unref();
      if (broker) {
        const result = await broker.result;
        if (!result.applied)
          throw Object.assign(new Error(result.error), { handoff: true });
        return {
          started: true,
          applied: true,
          ...(provisioned
            ? {
                version: provisioned.version,
                ...(provisioned.warning
                  ? { warning: provisioned.warning }
                  : {}),
              }
            : {}),
        };
      }
      // This acknowledges only process creation, not login or window readiness.
      return {
        started: true,
        ...(provisioned ? { version: provisioned.version } : {}),
      };
    } catch (error) {
      if (error.handoff || error.desktopInstall) throw error;
      throw new Error(
        `桌面窗口启动失败（${error.code || error.message}）。请检查桌面运行时，必要时运行 npm run desktop:install。`,
        { cause: error },
      );
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      fsImpl.closeSync(output);
      if (broker) await broker.close();
    }
  }

  function launch(input, { signal, onStatus: report } = {}) {
    if (input !== undefined) {
      let context;
      try {
        context = validateDesktopContext(input);
      } catch (error) {
        return Promise.reject(error);
      }
      const key = createHash("sha256")
        .update(JSON.stringify(context))
        .digest("hex");
      if (lastHandoff?.key === key) return lastHandoff.request;
      const request = handoffTail.then(() =>
        launchOnce(context, signal, report),
      );
      lastHandoff = { key, request };
      handoffTail = request
        .catch(() => {})
        .finally(() => {
          if (lastHandoff?.request === request) lastHandoff = null;
        });
      return request;
    }
    if (pending) return pending;
    const age = now() - lastStartedAt;
    if (recent && age >= 0 && age < cooldownMs) return recent;
    const request = launchOnce(undefined, signal, report).then(
      (result) => {
        pending = null;
        lastStartedAt = now();
        recent = request;
        return result;
      },
      (error) => {
        pending = null;
        recent = null;
        throw error;
      },
    );
    pending = request;
    return request;
  }

  return { launch };
}
