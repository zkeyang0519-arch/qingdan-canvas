"use strict";
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { parseAppUrl } = require("./window-policy.cjs");
const args = process.argv.slice(2),
  options = {};
for (const argument of args) {
  const at = argument.indexOf("=");
  if (at > 0) options[argument.slice(0, at)] = argument.slice(at + 1);
}
let profile, output, origin, account;
try {
  if (
    !path.isAbsolute(options["--qingdao-profile"] || "") ||
    !path.isAbsolute(options["--qingdao-output"] || "")
  )
    throw Error(
      "需明确指定绝对路径 --qingdao-profile、--qingdao-output，以及 --qingdao-origin、--qingdao-account。",
    );
  profile = fs.realpathSync(options["--qingdao-profile"]);
  if (
    !fs.statSync(profile).isDirectory() ||
    !fs.existsSync(path.join(profile, "Local Storage"))
  )
    throw Error("指定目录不是已有 Electron 轻岛资料目录。");
  output = path.resolve(options["--qingdao-output"]);
  if (fs.existsSync(output)) throw Error("输出文件已存在，已保留原文件。");
  origin = parseAppUrl(options["--qingdao-origin"] + "/app").origin;
  account = options["--qingdao-account"];
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(account || ""))
    throw Error("请指定需导出的账号 ID。");
  app.setPath("userData", profile);
  // Chromium's profile lock prevents opening live Electron storage. This
  // helper never kills a running application or copies its database files.
  if (!app.requestSingleInstanceLock())
    throw Error("原轻岛仍在运行，请从托盘保存退出后再导出。");
} catch (error) {
  console.error(error.message);
  app.exit(1);
}
app.whenReady().then(async () => {
  let window;
  try {
    const storage = session.defaultSession;
    storage.setPermissionRequestHandler((_w, _p, callback) => callback(false));
    // No cloud requests or normal app scripts run while exporting the profile.
    storage.webRequest.onBeforeRequest(
      { urls: ["ws://*/*", "wss://*/*"] },
      (_d, cb) => cb({ cancel: true }),
    );
    for (const scheme of ["http", "https"])
      await storage.protocol.handle(
        scheme,
        (request) =>
          new Response(
            new URL(request.url).origin === origin
              ? "<!doctype html><title>轻岛数据导出</title>"
              : "",
            {
              status: new URL(request.url).origin === origin ? 200 : 403,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            },
          ),
      );
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        session: storage,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadURL(origin + "/app");
    const script = fs.readFileSync(
      path.join(__dirname, "../.tmp/portable-state.js"),
      "utf8",
    );
    const value = await window.webContents.executeJavaScript(
      script +
        "\nQingdaoPortable.exportPortable(" +
        JSON.stringify(account) +
        ")",
    );
    try {
      value.position = JSON.parse(
        fs.readFileSync(path.join(profile, "window-position.json"), "utf8"),
      );
    } catch {
      /* Default placement remains available. */
    }
    fs.writeFileSync(output, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        exported: true,
        output,
        drafts: value.drafts.length,
        inputs: value.inputs.length,
        assets: value.assets.length,
      }),
    );
    window.destroy();
    app.quit();
  } catch (error) {
    console.error(error.message);
    window?.destroy();
    app.exit(1);
  }
});
