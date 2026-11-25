"use strict";

const busyStages = new Set(["preparing", "saving", "stopping", "installing"]);
const safeUpdateError = (error) => {
  const code = String(error?.code || "");
  if (/ENOSPC|DISK_FULL/.test(code))
    return "磁盘空间不足，更新未安装。请释放空间后重试。";
  if (/SHA512|CHECKSUM|SIGNATURE|DIGEST|PUBLISHER/i.test(code))
    return "更新包校验或签名验证失败，未安装。请重新检查更新。";
  if (/ENOTFOUND|ECONN|ETIMEDOUT|NETWORK|HTTP/i.test(code))
    return "更新下载连接失败，请检查网络后重试。";
  return "更新下载或校验失败，现有版本仍可使用。请重新检查更新。";
};
function createUpdateController({
  updater,
  version,
  prepare,
  install,
  changed = () => {},
  runtime = {},
  persist = async () => {},
  channel = "stable",
  pollMs = 2000,
}) {
  let state = {
    status: updater ? "idle" : "unsupported",
    currentVersion: version,
    channel,
    tasks: [],
    unknown: [],
    scheduled: false,
    hasUpdate: false,
  };
  let checking = null,
    action = null,
    pauseWork = null,
    cancelWork = null;
  let ready = false,
    downloadedVersion,
    requested = false,
    committed = false,
    generation = 0,
    polling = false,
    closed = false;
  const listeners = [];
  const publish = (next) => {
    const previous = JSON.stringify(state);
    state = {
      currentVersion: version,
      channel,
      version: downloadedVersion,
      tasks: state.tasks || [],
      unknown: [],
      hasUpdate: ready,
      scheduled: requested,
      ...next,
    };
    if (previous === JSON.stringify(state)) return;
    changed({
      ...state,
      tasks: [...state.tasks],
      unknown: [...(state.unknown || [])],
    });
  };
  const inspect = async () => {
    const result = (await runtime.status?.()) || { tasks: [], unknown: [] };
    if (
      !Array.isArray(result.tasks) ||
      !Array.isArray(result.unknown) ||
      result.tasks.some((t) => !t || typeof t.id !== "string")
    )
      throw Error("无法核实运行任务，暂不安装更新。请检查本地服务。");
    return result;
  };
  const resume = async () => {
    if (pauseWork) await pauseWork.catch(() => {});
    await runtime.resume?.();
  };
  const failInstall = async (error, phase) => {
    committed = false;
    requested = false;
    let recoveryError = "";
    try {
      await resume();
    } catch {
      recoveryError = " 本地服务尚未恢复，请在本地服务设置中重试连接。";
    }
    await persist({
      status: "failed",
      phase,
      version: downloadedVersion,
      error: String(error.message || "更新未完成").slice(0, 400),
    }).catch(() => {});
    publish({
      status: "error",
      phase,
      error:
        String(error.message || "更新未完成").slice(0, 400) + recoveryError,
      retry: recoveryError ? "resume" : ready ? "install" : "check",
      scheduled: false,
    });
  };
  async function finish(token) {
    let phase = "saving";
    try {
      if (token !== generation || !requested) return { cancelled: true };
      const activity = await inspect();
      if (activity.unknown.length)
        throw Error("还有结果未知的操作，请先核对原回执，暂不安装。");
      if (activity.tasks.some((t) => !t.checkpointedRemote)) {
        publish({ status: "waiting", tasks: activity.tasks, scheduled: true });
        await persist({ status: "waiting", version: downloadedVersion });
        return { scheduled: true };
      }
      publish({
        status: "saving",
        tasks: activity.tasks,
        scheduled: true,
        phase,
      });
      await persist({ status: "saving", version: downloadedVersion });
      const saved = await prepare();
      if (
        !saved?.ok ||
        (saved.hasDraft && !saved.draftsPersisted) ||
        (saved.unsynced && !saved.draftsPersisted)
      )
        throw Error(
          saved?.error || "未提交输入或待同步内容尚未完整保存，暂不重启。",
        );
      const checkpoint = await runtime.checkpoint?.();
      if (runtime.checkpoint && checkpoint?.ok !== true)
        throw Error("本地服务检查点保存未确认，更新已中止。");
      const finalActivity = await inspect();
      if (
        finalActivity.unknown.length ||
        finalActivity.tasks.some((t) => !t.checkpointedRemote)
      )
        throw Error("保存期间发现仍在运行或未核对的任务，更新已中止。");
      phase = "stopping";
      publish({
        status: "stopping",
        phase,
        tasks: finalActivity.tasks,
        scheduled: true,
      });
      await persist({ status: "stopping", version: downloadedVersion });
      const stopped = await runtime.stop?.();
      if (runtime.stop && stopped?.stopped !== true)
        throw Error("未能确认受管本地服务安全退出，更新已中止。");
      phase = "installing";
      await persist({ status: "installing", version: downloadedVersion });
      publish({ status: "installing", phase, scheduled: true });
      await install(() => {
        if (committed) return;
        committed = true;
        updater.quitAndInstall(true, true);
      });
      if (!committed) throw Error("安装器没有启动，已保留当前应用。");
      return true;
    } catch (error) {
      await failInstall(error, phase);
      throw error;
    }
  }
  async function tick() {
    if (closed || polling || action || cancelWork || committed || !ready)
      return;
    polling = true;
    const token = generation;
    try {
      const activity = await inspect();
      if (token !== generation || action || committed || closed) return;
      if (requested) {
        if (activity.unknown.length)
          throw Error("存在尚未核对的操作，预约更新已暂停，请先核对原任务。");
        if (!activity.tasks.some((t) => !t.checkpointedRemote)) {
          action = finish(token).finally(() => {
            action = null;
          });
          await action;
        } else
          publish({
            status: "waiting",
            tasks: activity.tasks,
            scheduled: true,
          });
      } else if (state.status !== "error")
        publish({
          status: "downloaded",
          tasks: activity.tasks,
          unknown: activity.unknown,
          scheduled: false,
        });
    } catch (error) {
      if (requested) await failInstall(error, "waiting");
      else if (!state.error)
        publish({
          ...state,
          unknown: ["任务状态尚未确认"],
          error: error.message,
        });
    } finally {
      polling = false;
    }
  }
  if (updater) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.channel = channel === "beta" ? "beta" : "latest";
    updater.allowDowngrade = false;
    updater.allowPrerelease = channel !== "stable";
    const on = (event, fn) => {
      updater.on(event, fn);
      listeners.push([event, fn]);
    };
    on("checking-for-update", () => {
      if (!ready && !requested) publish({ status: "checking" });
    });
    on("update-available", (info) => {
      if (!ready && !requested) {
        downloadedVersion = info.version;
        publish({ status: "available" });
      }
    });
    on("update-not-available", () => {
      if (!ready && !requested)
        publish({ status: "idle", message: "当前已是最新版本" });
    });
    on("download-progress", (info) => {
      if (ready || requested) return;
      publish({
        status: "downloading",
        progress: Number.isFinite(info.percent)
          ? Math.max(0, Math.min(100, info.percent))
          : null,
        transferred: info.transferred,
        total: info.total,
        bytesPerSecond: info.bytesPerSecond,
      });
    });
    on("update-downloaded", (info) => {
      if (requested || committed) return;
      ready = true;
      downloadedVersion = info.version;
      publish({ status: "downloaded" });
      void tick();
    });
    on("error", (error) => {
      if (requested || committed || busyStages.has(state.status)) {
        generation++;
        void failInstall(
          Error("安装更新失败，请检查磁盘与安装器后重试。"),
          state.status,
        );
      } else {
        ready = false;
        publish({
          status: "error",
          error: safeUpdateError(error),
          retry: "check",
        });
      }
    });
  }
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();
  return {
    state: () => ({
      ...state,
      tasks: [...state.tasks],
      unknown: [...(state.unknown || [])],
    }),
    refreshActivity: tick,
    check() {
      if (
        !updater ||
        ready ||
        action ||
        ["available", "downloading"].includes(state.status)
      )
        return Promise.resolve({ ...state });
      if (checking) return checking;
      checking = Promise.resolve()
        .then(() => updater.checkForUpdates())
        .catch((error) =>
          publish({
            status: "error",
            error: safeUpdateError(error),
            retry: "check",
          }),
        )
        .finally(() => {
          checking = null;
        });
      return checking.then(() => ({ ...state }));
    },
    install() {
      if (action) return action;
      if (committed) return Promise.resolve(true);
      if (requested) return Promise.resolve({ scheduled: true });
      if (!ready) return Promise.reject(Error("更新包尚未下载完成。"));
      requested = true;
      const token = ++generation;
      publish({ status: "preparing", phase: "preparing", scheduled: true });
      action = (async () => {
        try {
          await persist({ status: "preparing", version: downloadedVersion });
          pauseWork = Promise.resolve().then(() => runtime.pause?.());
          const paused = await pauseWork;
          if (runtime.pause && paused?.paused !== true)
            throw Error("无法确认已暂停接收新任务，更新已中止。");
          if (token !== generation || !requested) {
            await resume();
            return { cancelled: true };
          }
          return await finish(token);
        } catch (error) {
          if (requested) await failInstall(error, "preparing");
          throw error;
        } finally {
          pauseWork = null;
          action = null;
        }
      })();
      return action;
    },
    cancel() {
      if (cancelWork) return cancelWork;
      if (!requested || !["waiting", "preparing"].includes(state.status))
        return Promise.reject(
          Error("当前阶段不能取消，请等待保存或安装结束。"),
        );
      requested = false;
      generation++;
      cancelWork = (async () => {
        await resume();
        await persist({ status: "cancelled", version: downloadedVersion });
        publish({
          status: "downloaded",
          scheduled: false,
          message: "已取消预约，继续接收任务。",
        });
        return { cancelled: true };
      })()
        .catch((error) => {
          publish({
            status: "error",
            phase: "resuming",
            error: "预约已取消，但本地服务尚未恢复，请重试连接。",
            retry: "resume",
          });
          throw error;
        })
        .finally(() => {
          cancelWork = null;
        });
      return cancelWork;
    },
    async recover() {
      if (state.retry === "resume") {
        await resume();
        publish({ status: ready ? "downloaded" : "idle", scheduled: false });
        return this.state();
      }
      return ready ? this.install() : this.check();
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const [event, fn] of listeners) updater?.off?.(event, fn);
    },
  };
}
module.exports = { createUpdateController, safeUpdateError };
