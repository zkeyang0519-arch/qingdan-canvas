"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const originArgument = process.argv.find((value) =>
  value.startsWith("--qingdan-origin="),
);
const expectedOrigin = originArgument?.slice("--qingdan-origin=".length);
const allowedOrigins = new Set([
  expectedOrigin,
  ...process.argv
    .filter((value) => value.startsWith("--qingdan-allow-origin="))
    .map((value) => value.slice("--qingdan-allow-origin=".length)),
]);
if (
  process.isMainFrame &&
  allowedOrigins.has(location.origin) &&
  location.pathname === "/app"
) {
  let beforeQuit = null;
  ipcRenderer.on("qingdan-desktop:prepare-quit", async (_event, token) => {
    if (typeof token !== "string") return;
    try {
      const result = await beforeQuit?.();
      ipcRenderer.send("qingdan-desktop:prepared-quit", {
        token,
        ok: true,
        unsynced: result?.unsynced === true,
        hasDraft: result?.hasDraft === true,
        ...(result?.draftsPersisted === true ? { draftsPersisted: true } : {}),
        ...(typeof result?.accountId === "string" &&
        typeof result?.roomId === "string"
          ? { accountId: result.accountId, roomId: result.roomId }
          : {}),
      });
    } catch {
      ipcRenderer.send("qingdan-desktop:prepared-quit", { token, ok: false });
    }
  });
  contextBridge.exposeInMainWorld(
    "qingdanDesktop",
    Object.freeze({
      version: 1,
      getUpdateState: () => ipcRenderer.invoke("qingdan-desktop:update-state"),
      checkForUpdates: () => ipcRenderer.invoke("qingdan-desktop:check-update"),
      installUpdate: () => ipcRenderer.invoke("qingdan-desktop:install-update"),
      onUpdateState: (callback) => {
        if (typeof callback !== "function")
          throw new TypeError("An update callback is required");
        const listener = (_event, state) => callback(state);
        ipcRenderer.on("qingdan-desktop:update-state", listener);
        return () =>
          ipcRenderer.removeListener("qingdan-desktop:update-state", listener);
      },
      setLayout: (layout) =>
        ipcRenderer.invoke("qingdan-desktop:layout", layout),
      setContext: (context) =>
        ipcRenderer.invoke("qingdan-desktop:context", context),
      getPlacement: () => ipcRenderer.invoke("qingdan-desktop:placement"),
      drag: (action, origin) =>
        ipcRenderer.invoke("qingdan-desktop:drag", action, origin),
      onPlacement: (callback) => {
        if (typeof callback !== "function")
          throw new TypeError("A placement callback is required");
        const listener = (_event, placement) => callback(placement);
        ipcRenderer.on("qingdan-desktop:placement", listener);
        return () =>
          ipcRenderer.removeListener("qingdan-desktop:placement", listener);
      },
      hide: () => ipcRenderer.invoke("qingdan-desktop:hide"),
      openWorkspace: (roomId) =>
        ipcRenderer.invoke("qingdan-desktop:open-workspace", roomId),
      onBeforeQuit: (callback) => {
        if (typeof callback !== "function")
          throw new TypeError("A save callback is required");
        beforeQuit = callback;
        return () => {
          if (beforeQuit === callback) beforeQuit = null;
        };
      },
    }),
  );
}
