"use strict";
const { spawn } = require("node:child_process");
const { installedDesktopExecutable } = require("./profile-location.cjs");

// Older running local services may still launch desktop/main.cjs. Forward only
// a public broker descriptor; credentials are claimed by the installed process.
async function forwardInstalledDesktop({
  packaged,
  descriptor,
  profile,
  env = process.env,
  spawnImpl = spawn,
  fsImpl,
}) {
  if (packaged || env.QINGDAN_DESKTOP_PROFILE) return false;
  const executable = installedDesktopExecutable({ env, fsImpl });
  if (!executable) return false;
  const environment = {
    ...env,
    QINGDAN_DESKTOP_PROFILE: profile,
    QINGDAN_DESKTOP_WEB_LAUNCH_PORT: "8791",
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawnImpl(
    executable,
    descriptor ? ["--qingdan-desktop-handoff"] : [],
    {
      env: environment,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: [descriptor ? "pipe" : "ignore", "ignore", "ignore"],
    },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  if (descriptor)
    await new Promise((resolve, reject) => {
      child.stdin.once("error", reject);
      child.stdin.end(JSON.stringify(descriptor), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  child.unref();
  return true;
}

module.exports = { forwardInstalledDesktop };
