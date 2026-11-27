"use strict";
const { execFile } = require("node:child_process");
const path = require("node:path");
const { parseAppUrl } = require("./window-policy.cjs");
const { windowsWorkspaceFocus } = require("./workspace-focus-windows.cjs");

function focusWindowsWorkspace(url, { exec = execFile, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const executable = path.win32.join(
      env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    exec(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsWorkspaceFocus],
      {
        windowsHide: true,
        timeout: 12000,
        maxBuffer: 4096,
        encoding: "utf8",
        env: { ...env, QINGDAO_WORKSPACE_TARGET: url },
      },
      (error, stdout) => {
        if (error)
          return reject(Error("暂时无法唤回浏览器中的轻单，请稍后再试。"));
        const status = stdout.trim();
        if (!["focused", "absent", "unavailable"].includes(status))
          return reject(Error("未能确认浏览器状态，请稍后再试。"));
        resolve(status);
      },
    );
  });
}

function createWorkspaceOpener({
  openExternal,
  platform = process.platform,
  focus = focusWindowsWorkspace,
  now = Date.now,
}) {
  const pending = new Map();
  let queue = Promise.resolve(), lastLaunch = null;
  return (input) => {
    const url = parseAppUrl(input).href;
    if (pending.has(url)) return pending.get(url);
    // Tab selection is serialized, including requests for different projects.
    const operation = queue.catch(() => {}).then(async () => {
      const status = platform === "win32" ? await focus(url) : "absent";
      if (status === "focused") {
        lastLaunch = null;
        return true;
      }
      if (status !== "absent")
        throw Error("已打开的浏览器暂时无法响应，请稍后再点轻岛小舱。" );
      // shell.openExternal resolves before the browser creates its tab. Cover
      // that brief launch interval in addition to coalescing in-flight clicks.
      if (lastLaunch?.url === url && now() - lastLaunch.at < 2500) return true;
      await openExternal(url);
      lastLaunch = { url, at: now() };
      return true;
    });
    pending.set(url, operation);
    queue = operation;
    const clear = () => pending.delete(url);
    operation.then(clear, clear);
    return operation;
  };
}

module.exports = { createWorkspaceOpener, focusWindowsWorkspace };
