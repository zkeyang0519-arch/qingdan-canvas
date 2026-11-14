import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createDesktopHandoff,
  validateDesktopContext,
} from "./desktop-handoff-broker.mjs";

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
} = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot))
    throw new Error("桌面启动器需要项目的绝对路径。");
  const root = path.resolve(projectRoot);
  const environment = { ...env };
  // Editors built on Electron can export this. The companion needs GUI mode.
  delete environment.ELECTRON_RUN_AS_NODE;
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

  async function launchOnce(context, signal) {
    signal?.throwIfAborted();
    let directory;
    try {
      directory = electronDirectory
        ? path.resolve(electronDirectory)
        : path.dirname(
            createRequire(path.join(root, "package.json")).resolve("electron"),
          );
    } catch (error) {
      throw new Error("桌面依赖未安装，请先在轻单项目运行 npm ci。", {
        cause: error,
      });
    }
    let executable = runtimePath(directory);
    if (!executable) {
      onStatus("首次使用正在下载桌面运行时，请稍候（仅首次需要）…");
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
      fsImpl.mkdirSync(profile, { recursive: true });
      output = fsImpl.openSync(path.join(profile, "desktop.log"), "a");
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
          path.join(root, "desktop/main.cjs"),
          ...(broker ? ["--qingdan-desktop-handoff"] : []),
        ],
        {
          cwd: root,
          env: { ...environment },
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
        return { started: true, applied: true };
      }
      // This acknowledges only process creation, not login or window readiness.
      return { started: true };
    } catch (error) {
      if (error.handoff) throw error;
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

  function launch(input, { signal } = {}) {
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
      const request = handoffTail.then(() => launchOnce(context, signal));
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
    const request = launchOnce().then(
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
