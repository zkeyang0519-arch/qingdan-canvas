"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const net = require("node:net");

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
}
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw Error("本地服务状态文件无法读取，请保留数据后修复。");
  }
}
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(700);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}
function newer(a, b) {
  const parts = (value) =>
    String(value)
      .split(/[.-]/)
      .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const aa = parts(a),
    bb = parts(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === bb[i]) continue;
    if (i >= 3 && (aa[i] === undefined || bb[i] === undefined))
      return aa[i] === undefined;
    return (aa[i] ?? 0) > (bb[i] ?? 0);
  }
  return false;
}
function createManagedLocalService({
  root,
  dataDir,
  version,
  changed = () => {},
  spawnProcess = spawn,
  isPortInUse = portInUse,
  environment = process.env,
  ports = { app: 8790, web: 8788 },
  publicHost = "127.0.0.1",
  onHandoff,
}) {
  root = path.resolve(root);
  dataDir = path.resolve(dataDir);
  if (
    ![ports.app, ports.web].every(
      (port) => Number.isInteger(port) && port > 1024 && port <= 65535,
    ) ||
    ports.app === ports.web
  )
    throw Error("Invalid local service ports");
  if (!["127.0.0.1", "localhost"].includes(publicHost))
    throw Error("Invalid local service hostname");
  const configFile = path.join(dataDir, "service.json"),
    stateFile = path.join(dataDir, "storage.json");
  let state = {
    status: "stopped",
    version,
    managed: true,
    enabled: false,
    url: "http://" + publicHost + ":" + ports.app + "/app",
    tasks: [],
    unknown: [],
  };
  let child,
    starting,
    stopping,
    config,
    manifest,
    serial = 0,
    exitPromise,
    paused = false;
  const pending = new Map();
  const lockFile = path.join(dataDir, "service-owner.json");
  const alive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  };
  async function releaseOwner(token) {
    const owner = await readJson(lockFile, null);
    if (owner?.token === token)
      await fs.unlink(lockFile).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
  async function claimOwner(token) {
    await fs.mkdir(dataDir, { recursive: true });
    const old = await readJson(lockFile, null);
    if (old) {
      if (!old.token || alive(old.parentPid) || alive(old.childPid))
        throw Error("这个数据目录仍由另一项本地服务使用，暂不重复启动。");
      await fs.unlink(lockFile);
    }
    const file = await fs.open(lockFile, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ token, parentPid: process.pid }));
      await file.sync();
    } finally {
      await file.close();
    }
  }
  const publish = (value) => {
    state = { ...state, ...value };
    changed({ ...state });
    return { ...state };
  };
  async function load() {
    config ||= await readJson(configFile, { enabled: false });
    manifest ||= await readJson(path.join(root, "runtime.json"), null);
    if (!manifest)
      return publish({
        status: "unsupported",
        enabled: config.enabled,
        error: "当前安装包未内置本地服务。",
      });
    if (
      manifest.version !== version ||
      manifest.protocol !== 1 ||
      manifest.dataSchema !== 1
    )
      throw Error("界面与本地服务版本或协议不一致，请修复安装包。");
    publish({ enabled: config.enabled });
    return state;
  }
  function rpc(action, input = {}) {
    if (!child?.connected)
      return Promise.reject(Error("受管本地服务尚未连接。"));
    const target = child,
      id = String(++serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(Error("等待本地服务" + action + "确认超时。"));
        },
        action === "checkpoint" ? 30000 : 20000,
      );
      pending.set(id, { resolve, reject, timer });
      target.send({ id, action, input }, (error) => {
        if (error && pending.has(id)) {
          clearTimeout(timer);
          pending.delete(id);
          reject(Error("本地服务控制连接已断开。"));
        }
      });
    });
  }
  async function snapshot(label) {
    const source = path.join(dataDir, "data");
    try {
      await fs.access(source);
    } catch {
      return;
    }
    const destination = path.join(
      dataDir,
      "backups",
      label.replace(/[^a-zA-Z0-9._-]/g, "_") + "-" + Date.now(),
    );
    if (!destination.startsWith(path.join(dataDir, "backups") + path.sep))
      throw Error("备份路径无效。");
    await fs.cp(source, destination, {
      recursive: true,
      dereference: false,
      filter: async (file) => !(await fs.lstat(file)).isSymbolicLink(),
    });
    await atomicJson(path.join(dataDir, "last-backup.json"), {
      path: destination,
      version: label,
    });
  }
  async function start({ retry = false } = {}) {
    if (starting) return starting;
    if (stopping) throw Error("本地服务正在退出，请等待确认。");
    if (child && child.exitCode === null) {
      if (retry && state.status === "error") {
        await rpc("activity");
        config.enabled = true;
        await atomicJson(configFile, config);
        return publish({ status: "online", enabled: true, error: "" });
      }
      return state;
    }
    let claimedToken;
    starting = (async () => {
      await load();
      if (!manifest) return state;
      if ((await isPortInUse(ports.app)) || (await isPortInUse(ports.web))) {
        return publish({
          status: "external",
          managed: false,
          error: "已有独立本地服务运行，沿用其配置和连接；轻岛不会关闭它。",
        });
      }
      const previous = await readJson(stateFile, null);
      if (
        previous &&
        (previous.schema > manifest.dataSchema ||
          newer(previous.version, version))
      )
        throw Error(
          "现有数据来自较新版本，未验证兼容性，已停止启动；不会自动降级或清空数据。",
        );
      const attempts =
        previous?.version === version ? previous.attempts || 0 : 0;
      if (attempts >= 2 && !retry)
        throw Error("本地服务连续启动失败，请点击重试或修复；已停止自动重启。");
      const ownerToken = randomUUID();
      await claimOwner(ownerToken);
      claimedToken = ownerToken;
      if (previous && previous.version !== version)
        await snapshot(previous.version);
      await atomicJson(stateFile, {
        schema: manifest.dataSchema,
        version,
        attempts: retry ? 1 : attempts + 1,
        cleanShutdown: false,
      });
      await fs.mkdir(path.join(dataDir, "data"), { recursive: true });
      const moduleLink = path.join(dataDir, "data", "node_modules");
      const info = await fs.lstat(moduleLink).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (info && !info.isSymbolicLink())
        throw Error("本地服务依赖路径被占用，请先检查数据目录。");
      if (info) await fs.unlink(moduleLink);
      await fs.symlink(
        path.join(root, "node_modules"),
        moduleLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      publish({ status: "starting", managed: true, error: "" });
      const processHandle = (child = spawnProcess(
        path.join(root, "node.exe"),
        [path.join(root, "service.mjs")],
        {
          cwd: root,
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            ...environment,
            QINGDAN_SERVICE_ROOT: root,
            QINGDAN_SERVICE_DATA: path.join(dataDir, "data"),
            QINGDAN_SERVICE_VERSION: version,
            QINGDAN_SERVICE_PAUSED: paused ? "1" : "0",
            QINGDAN_SERVICE_APP_PORT: String(ports.app),
            QINGDAN_SERVICE_WEB_PORT: String(ports.web),
            QINGDAN_SERVICE_PUBLIC_HOST: publicHost,
          },
        },
      ));
      let resolveExit;
      exitPromise = new Promise((resolve) => {
        resolveExit = resolve;
      });
      processHandle.once("exit", (code, signal) => {
        void releaseOwner(ownerToken).catch(() => {});
        resolveExit({ code, signal });
        if (child === processHandle) {
          child = null;
          for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(Error("本地服务已退出。"));
          }
          pending.clear();
          if (!stopping)
            publish({
              status: "error",
              error: "本地服务意外退出，数据和回执已保留。请重试连接。",
            });
        }
      });
      const launched = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("本地服务启动超时，未自动重启。请查看服务诊断。")),
          60000,
        );
        processHandle.once("error", () => {
          clearTimeout(timer);
          if (child === processHandle) child = null;
          void releaseOwner(ownerToken).catch(() => {});
          reject(Error("本地服务程序无法启动，请修复安装。"));
        });
        processHandle.once("exit", () => {
          clearTimeout(timer);
          reject(Error("本地服务未能完成启动，数据已保留。"));
        });
        processHandle.on("message", (message) => {
          if (message?.type === "handoff" && typeof message.id === "string") {
            Promise.resolve()
              .then(() => {
                if (!onHandoff) throw Error("当前服务未连接轻岛窗口。");
                return onHandoff(message.descriptor);
              })
              .then(
                () =>
                  processHandle.connected &&
                  processHandle.send({
                    type: "handoff-result",
                    id: message.id,
                    ok: true,
                  }),
              )
              .catch(
                () =>
                  processHandle.connected &&
                  processHandle.send({
                    type: "handoff-result",
                    id: message.id,
                    error: "轻岛窗口暂未完成切换，请稍后重试。",
                  }),
              );
          } else if (message?.type === "ready") {
            clearTimeout(timer);
            if (message.version !== version || message.protocol !== 1)
              reject(Error("本地服务握手版本不匹配。"));
            else resolve();
          } else if (message?.type === "startup-error") {
            clearTimeout(timer);
            reject(Error(message.error || "本地服务启动失败。"));
          } else if (message?.id && pending.has(message.id)) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            clearTimeout(request.timer);
            if (message.error) request.reject(Error(message.error));
            else request.resolve(message.result);
          }
        });
      });
      // Attach all IPC/error listeners before yielding to filesystem work.
      await atomicJson(lockFile, {
        token: ownerToken,
        parentPid: process.pid,
        childPid: processHandle.pid,
      });
      await launched;
      await atomicJson(stateFile, {
        schema: manifest.dataSchema,
        version,
        attempts: 0,
        cleanShutdown: false,
      });
      config.enabled = true;
      await atomicJson(configFile, config);
      return publish({
        status: "online",
        enabled: true,
        managed: true,
        error: "",
      });
    })()
      .catch(async (error) => {
        if (!child && claimedToken)
          await releaseOwner(claimedToken).catch(() => {});
        publish({ status: "error", error: error.message });
        throw error;
      })
      .finally(() => {
        starting = null;
      });
    return starting;
  }
  return {
    state: () => ({ ...state }),
    async initialize() {
      await load();
      if (config.enabled) return start();
      return state;
    },
    start,
    async openWorkspace(identity) {
      if (state.status === "external") return { url: state.url };
      if (state.status !== "online") throw Error("本地服务尚未就绪。");
      return rpc("open-workspace", identity);
    },
    async configureContext(context) {
      if (state.status === "online" && context?.accountId)
        return rpc("context", { accountId: context.accountId });
    },
    async status() {
      if (starting || stopping)
        return { tasks: [], unknown: ["本地服务正在启动或退出"] };
      if (state.status === "external") {
        const owner = await readJson(lockFile, null);
        if (owner && (alive(owner.childPid) || alive(owner.parentPid)))
          return {
            tasks: [],
            unknown: ["上一轮受管服务仍在运行，请等待任务结束后重新检测。"],
          };
      }
      if (!child)
        return state.status === "error" && state.enabled
          ? { tasks: [], unknown: [state.error] }
          : { tasks: [], unknown: [] };
      return rpc("activity");
    },
    async pause() {
      paused = true;
      if (starting) await starting;
      if (child) return rpc("pause");
      return { paused: true };
    },
    async resume() {
      paused = false;
      if (starting) await starting;
      if (child) return rpc("resume");
      if (config?.enabled && state.managed) await start({ retry: true });
      return { resumed: true };
    },
    async checkpoint() {
      if (child) return rpc("checkpoint");
      if (state.enabled && state.status === "error")
        throw Error("服务退出状态未确认，暂不安装。");
      return { ok: true };
    },
    async stop() {
      if (stopping) return stopping;
      if (!child) return { stopped: true };
      stopping = (async () => {
        const result = await rpc("stop");
        if (!result?.stopped) throw Error("本地服务未确认安全退出。");
        const exit = await Promise.race([
          exitPromise,
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(Error("无法确认本地服务子进程退出，已中止安装。")),
              20000,
            );
            timer.unref?.();
          }),
        ]);
        if (exit.code !== 0)
          throw Error("本地服务异常退出，已中止安装以保留当前版本。");
        await snapshot(version);
        await atomicJson(stateFile, {
          schema: manifest.dataSchema,
          version,
          attempts: 0,
          cleanShutdown: true,
        });
        publish({ status: "stopped" });
        return { stopped: true };
      })().finally(() => {
        stopping = null;
      });
      return stopping;
    },
    async disable() {
      const activity = await this.status();
      if (activity.tasks.length || activity.unknown.length)
        throw Error("仍有运行中或待核对任务，暂不能停用本地服务。");
      await this.pause();
      await this.stop();
      config.enabled = false;
      await atomicJson(configFile, config);
      return publish({ enabled: false });
    },
  };
}
module.exports = { createManagedLocalService, atomicJson, newer };
