"use strict";

// Renderer never supplies a feed, file path, or installation command.
function createUpdateController({
  updater,
  version,
  prepare,
  install,
  changed = () => {},
}) {
  let state = {
    status: updater ? "idle" : "unsupported",
    currentVersion: version,
  };
  let checking = null,
    installing = null,
    ready = false;
  const publish = (next) => {
    state = { currentVersion: version, ...next };
    changed({ ...state });
  };
  const failed = () =>
    publish({
      status: "error",
      error: "更新未完成，请检查网络后重试。现有版本仍可继续使用。",
    });
  if (updater) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.on("checking-for-update", () => publish({ status: "checking" }));
    updater.on("update-available", (info) =>
      publish({ status: "available", version: info.version }),
    );
    updater.on("update-not-available", () =>
      publish({ status: "idle", message: "当前已是最新版本" }),
    );
    updater.on("download-progress", (info) =>
      publish({
        status: "downloading",
        version: state.version,
        progress: Math.round(info.percent),
      }),
    );
    updater.on("update-downloaded", (info) => {
      ready = true;
      publish({ status: "downloaded", version: info.version });
    });
    updater.on("error", () => {
      ready = false;
      failed();
    });
  }
  return {
    state: () => ({ ...state }),
    check() {
      if (
        !updater ||
        ready ||
        installing ||
        ["available", "downloading"].includes(state.status)
      )
        return Promise.resolve({ ...state });
      if (checking) return checking;
      checking = Promise.resolve()
        .then(() => updater.checkForUpdates())
        .catch(failed)
        .finally(() => {
          checking = null;
        });
      return checking.then(() => ({ ...state }));
    },
    install() {
      if (installing) return installing;
      if (!ready) return Promise.reject(Error("更新包尚未下载完成。"));
      const downloadedVersion = state.version;
      installing = (async () => {
        try {
          publish({ status: "installing", version: downloadedVersion });
          const saved = await prepare();
          if (!saved?.ok || (saved.hasDraft && !saved.draftsPersisted))
            throw Error(
              "未提交的输入还没有保存，暂不重启。请返回轻岛处理后重试。",
            );
          await install(() => updater.quitAndInstall(true, true));
          return true;
        } catch (error) {
          publish({
            status: "downloaded",
            version: downloadedVersion,
            error: error.message,
          });
          throw error;
        } finally {
          installing = null;
        }
      })();
      return installing;
    },
  };
}
module.exports = { createUpdateController };
