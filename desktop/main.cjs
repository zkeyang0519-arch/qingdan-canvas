"use strict";
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  screen,
  ipcMain,
  shell,
  dialog,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { createUpdateController } = require("./updates.cjs");
const { installBundledWeb } = require("./bundled-web.cjs");
const { readResume, saveResume } = require("./resume-state.cjs");
const { desktopOnlineOrigins } = require("../shared/desktop-origins.cjs");
const {
  alwaysOnTopLevel,
  parseAppUrl,
  isTrustedPage,
  validateLayout,
  fitWindowBounds,
  islandShape,
  workspaceUrl,
} = require("./window-policy.cjs");
const {
  placementAtPoint,
  restorePlacement,
  fitDockBounds,
  placementState,
  dockShape,
} = require("./docking.cjs");
const { performSavedAction } = require("./save-before-action.cjs");
const {
  validateDescriptor,
  validateContext,
  readDescriptor,
  claimSession,
  ensureActive,
  applySessionHandoff,
  acknowledge,
  failedMessage,
} = require("./session-handoff.cjs");

const root = path.resolve(__dirname, "..");
// A legacy broker without an explicit origin always belongs to the local
// service, even when the packaged app starts on the production website.
const legacyHandoffApplication = parseAppUrl(
  process.env.QINGDAN_DESKTOP_URL,
).href;
const localApplication = parseAppUrl(
  process.env.QINGDAN_DESKTOP_URL ||
    (app.isPackaged ? "https://todo.zky.lol/app" : undefined),
).href;
let application = localApplication;
const profile = app.getPath
  ? require("./profile-location.cjs").resolveDesktopProfile({
      packaged: !!app.isPackaged,
      projectRoot: root,
      appData: app.getPath("appData"),
      env: process.env,
    })
  : path.resolve(
      process.env.QINGDAN_DESKTOP_PROFILE ||
        path.join(root, ".tmp", "desktop-profile"),
    );
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setName("轻岛");
if (!process.env.QINGDAN_DESKTOP_URL)
  application = readResume(profile) || application;
let updates,
  externalUpdating = false;
const positionFile = path.join(profile, "window-position.json");
let window,
  tray,
  layout = { mode: "setup", width: 920, height: 740 };
let positionTimer,
  actionPromise,
  pendingSave,
  islandPosition,
  userMoving = false,
  quitting = false,
  unavailable = false,
  allowSavedNavigation = false;
let rendererContext = null,
  rendererIslandReady = false,
  readyWaiter = null,
  handoffNavigation = false;
let dragSession = null,
  lastPlacement = "";

function trusted(event) {
  return (
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isTrustedPage(event.senderFrame.url, application)
  );
}
function guard(event) {
  if (!trusted(event)) throw new Error("Untrusted desktop request");
}
function currentWorkArea() {
  return window && !window.isDestroyed()
    ? screen.getDisplayMatching(window.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea;
}
function shape() {
  if (
    !window ||
    window.isDestroyed() ||
    !["win32", "linux"].includes(process.platform)
  )
    return;
  const bounds = window.getBounds();
  window.setShape(
    layout.mode === "island"
      ? dockShape(bounds, layout, islandPosition, currentWorkArea())
      : [],
  );
}
function getPlacement() {
  return {
    ...placementState(
      islandPosition,
      window.getBounds(),
      currentWorkArea(),
      !!dragSession,
    ),
    supportsJade: true,
  };
}
function publishPlacement() {
  const state = getPlacement(),
    encoded = JSON.stringify(state);
  if (encoded !== lastPlacement && window.webContents?.send) {
    lastPlacement = encoded;
    window.webContents.send("qingdan-desktop:placement", state);
  }
  return state;
}
function resize(next, { reset = false, relocate = false, workArea } = {}) {
  const work =
    workArea ||
    (reset ? screen.getPrimaryDisplay().workArea : currentWorkArea());
  const previous = reset ? null : window.getBounds();
  layout = dragSession
    ? {
        mode: "island",
        dock: "free",
        expanded: false,
        width: dragSession.layout.appearance === "jade" ? 214 : 354,
        height: dragSession.layout.appearance === "jade" ? 64 : 76,
        ...(dragSession.layout.appearance
          ? { appearance: dragSession.layout.appearance }
          : {}),
      }
    : next;
  if (!dragSession && layout.mode === "island") {
    if (
      reset ||
      relocate ||
      !["top", "left", "right"].includes(islandPosition?.dock)
    )
      rememberPosition(
        restorePlacement(
          reset ? null : islandPosition,
          work,
          layout.appearance,
        ),
      );
    if (layout.dock) {
      const changed = reset || layout.dock !== islandPosition.dock;
      layout = {
        ...layout,
        dock: islandPosition.dock,
        ...(changed
          ? {
              width: islandPosition.width,
              height: islandPosition.height,
              expanded: false,
            }
          : {}),
      };
    }
  }
  // ResizeObserver reports every animation frame. Reusing each rounded frame
  // as the next center would accumulate half-pixel errors across width changes.
  const anchor = layout.mode === "island" ? islandPosition : previous;
  const cursor = dragSession && screen.getCursorScreenPoint();
  const bounds = dragSession
    ? {
        x: Math.round(cursor.x - dragSession.offset.x),
        y: Math.round(cursor.y - dragSession.offset.y),
        width: layout.width,
        height: layout.height,
      }
    : layout.mode === "island" && !layout.dock
      ? fitDockBounds(
          { ...anchor, dock: "top" },
          { ...layout, dock: "top" },
          work,
        )
      : fitDockBounds(anchor, layout, work);
  const current = window.getBounds();
  if (Object.keys(bounds).some((key) => bounds[key] !== current[key]))
    window.setBounds(bounds, false);
  shape();
  publishPlacement();
}
function show() {
  if (!window || window.isDestroyed()) return;
  resize(layout);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function rememberPosition(bounds) {
  if (layout.mode !== "island") return;
  const { x, y, width, height } = bounds;
  islandPosition = {
    x,
    y,
    width,
    height,
    dock: bounds.dock || islandPosition?.dock || "top",
  };
  clearTimeout(positionTimer);
  positionTimer = setTimeout(() => {
    try {
      fs.writeFileSync(positionFile, JSON.stringify(islandPosition));
    } catch (error) {
      console.error("无法保存桌面窗口位置：", error.message);
    }
  }, 200);
}
function dragWindow(action, origin) {
  if (!["start", "move", "end", "cancel"].includes(action))
    throw new Error("Invalid desktop drag action");
  if (layout.mode !== "island") return getPlacement();
  if (action === "start" && !dragSession) {
    if (
      origin !== undefined &&
      (!Number.isFinite(origin?.x) ||
        !Number.isFinite(origin?.y) ||
        origin.x < 0 ||
        origin.x > 600 ||
        origin.y < 0 ||
        origin.y > 1000)
    )
      throw new Error("Invalid desktop drag origin");
    const point = screen.getCursorScreenPoint(),
      bounds = window.getBounds();
    dragSession = {
      position: islandPosition && { ...islandPosition },
      layout: { ...layout },
      offset: {
        x: Math.max(
          24,
          Math.min(
            layout.appearance === "jade" ? 202 : 330,
            origin?.x ?? point.x - bounds.x,
          ),
        ),
        y: Math.max(
          12,
          Math.min(layout.appearance === "jade" ? 52 : 64, origin?.y ?? 38),
        ),
      },
    };
    resize(layout);
  } else if (action === "move" && dragSession) resize(layout);
  else if ((action === "end" || action === "cancel") && dragSession) {
    const previous = dragSession;
    dragSession = null;
    if (action === "cancel") {
      islandPosition = previous.position;
      resize(previous.layout, {
        workArea: previous.position
          ? screen.getDisplayMatching(previous.position).workArea
          : currentWorkArea(),
      });
    } else {
      const point = screen.getCursorScreenPoint();
      const work = screen.getDisplayNearestPoint(point).workArea;
      const placement = placementAtPoint(
        point,
        previous.offset,
        work,
        previous.layout.appearance,
      );
      rememberPosition(placement);
      resize(
        {
          mode: "island",
          dock: placement.dock,
          expanded: false,
          width: placement.width,
          height: placement.height,
          ...(previous.layout.appearance
            ? { appearance: previous.layout.appearance }
            : {}),
        },
        { workArea: work },
      );
    }
  }
  return publishPlacement();
}
function icon() {
  const size = 32,
    pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 < 15 ** 2;
      const tick =
        inside &&
        ((x >= 7 && x <= 14 && Math.abs(y - (x + 7)) < 2) ||
          (x >= 12 && x <= 25 && Math.abs(y - (33 - x)) < 2));
      pixels[offset] = tick ? 170 : 39;
      pixels[offset + 1] = tick ? 218 : 44;
      pixels[offset + 2] = tick ? 186 : 35;
      pixels[offset + 3] = inside ? 255 : 0;
    }
  return nativeImage.createFromBitmap(pixels, {
    width: size,
    height: size,
    scaleFactor: 1,
  });
}
function saveBeforeQuit() {
  // A failed or cancelled navigation can leave the real workspace alive.
  // Its current URL, never a cached failure-page flag, determines save ownership.
  if (!isTrustedPage(window.webContents.getURL(), application))
    return Promise.resolve({ ok: true, unsynced: false, hasDraft: false });
  return new Promise((resolve, reject) => {
    const token = randomUUID();
    const timeout = setTimeout(() => {
      if (pendingSave?.token !== token) return;
      pendingSave = null;
      reject(new Error("等待本地草稿保存超时，请显示窗口后重试。"));
    }, 8000);
    pendingSave = { token, resolve, timeout };
    window.webContents.send("qingdan-desktop:prepare-quit", token);
  });
}
function requestSavedAction(kind) {
  if (externalUpdating || updates?.state().status === "installing")
    return Promise.resolve();
  if (quitting) return Promise.resolve();
  if (actionPromise) return actionPromise;
  if (!window || window.isDestroyed()) {
    if (kind === "quit") {
      quitting = true;
      app.quit();
    }
    return Promise.resolve();
  }
  const reconnect = kind === "reload";
  const label = reconnect ? "重新连接轻单" : "退出轻岛";
  const request = (async () => {
    try {
      return await performSavedAction({
        prepare: saveBeforeQuit,
        confirm: async (saved) => {
          if (saved.draftsPersisted) return true;
          show();
          const result = await dialog.showMessageBox(window, {
            type: "question",
            title: label,
            defaultId: 0,
            cancelId: 0,
            buttons: ["继续使用", label],
            message: saved.hasDraft
              ? "还有未提交的待办输入。"
              : "还有未同步的待办修改。",
            detail: saved.hasDraft
              ? `已保存待同步的修改。未提交的输入会在${reconnect ? "重新连接" : "退出"}后丢失，是否仍要${reconnect ? "重新连接" : "退出"}？`
              : reconnect
                ? "待同步修改已保存到本机。重新连接后会从本机草稿恢复，是否继续？"
                : "已完成本地草稿保存。退出会关闭悬浮窗，轻单服务继续运行；重新打开后可恢复待同步内容。",
            noLink: true,
          });
          return result.response === 1;
        },
        perform: async () => {
          await window.webContents.session.flushStorageData();
          await window.webContents.session.cookies?.flushStore?.();
          if (isTrustedPage(window.webContents.getURL(), application))
            saveResume(profile, window.webContents.getURL());
          if (reconnect) {
            const currentUrl = window.webContents.getURL();
            allowSavedNavigation = true;
            try {
              await loadApplication(
                isTrustedPage(currentUrl, application)
                  ? currentUrl
                  : application,
              );
            } finally {
              allowSavedNavigation = false;
            }
            show();
          } else {
            quitting = true;
            clearTimeout(positionTimer);
            window.destroy();
            tray?.destroy();
            app.quit();
          }
        },
      });
    } catch (error) {
      show();
      await dialog.showMessageBox(window, {
        type: "warning",
        title: reconnect ? "暂未重新连接" : "暂未退出",
        message: error.message,
        buttons: ["返回窗口"],
      });
    }
  })().finally(() => {
    if (actionPromise === request) actionPromise = null;
  });
  actionPromise = request;
  return request;
}
function requestQuit() {
  return requestSavedAction("quit");
}
function contextReady(session) {
  return (
    rendererIslandReady &&
    layout.mode === "island" &&
    rendererContext?.accountId === session.accountId &&
    rendererContext?.roomId === session.roomId
  );
}
function checkContextReady() {
  if (!readyWaiter || !contextReady(readyWaiter.session)) return;
  clearTimeout(readyWaiter.timeout);
  const resolve = readyWaiter.resolve;
  readyWaiter = null;
  resolve();
}
function waitForContext(session) {
  if (contextReady(session)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      readyWaiter = null;
      reject(new Error("桌面画布尚未就绪，请回到网页重试。"));
    }, 15000);
    readyWaiter = {
      session: { accountId: session.accountId, roomId: session.roomId },
      resolve,
      timeout,
    };
  });
}
async function handoffStatus(message = "正在接入当前画布…") {
  rendererContext = null;
  rendererIslandReady = false;
  unavailable = false;
  resize({ mode: "island", width: 354, height: 76 });
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>轻岛</title><style>html,body{margin:0;background:transparent}main{box-sizing:border-box;margin:12px;height:52px;border-radius:26px;display:flex;align-items:center;justify-content:center;background:#293c32;color:#eef3e7;font:13px 'Microsoft YaHei',sans-serif;app-region:drag}</style><main>${escapeHtml(message)}</main></html>`;
  await window.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(html),
  );
  show();
}
function sessionCookie(value, target = application, expiresAt) {
  return {
    url: new URL(target).origin,
    name: "qd_session",
    value,
    httpOnly: true,
    secure: new URL(target).protocol === "https:",
    sameSite: "lax",
    path: "/",
    ...(expiresAt ? { expirationDate: Math.floor(expiresAt / 1000) } : {}),
  };
}
async function activateHandoff(
  session,
  { reuse, ensureActive: checkActive = async () => {} },
) {
  const storage = window.webContents.session;
  const targetApplication = session.origin
    ? parseAppUrl(session.origin + "/app").href
    : legacyHandoffApplication;
  await checkActive();
  if (
    reuse &&
    new URL(targetApplication).origin === new URL(application).origin
  ) {
    const previousCookie = (
      await storage.cookies.get({
        url: new URL(targetApplication).origin,
        name: "qd_session",
      })
    ).find((cookie) => cookie.path === "/");
    let changed = false;
    try {
      await checkActive();
      await storage.cookies.set(
        sessionCookie(
          session.sessionToken,
          targetApplication,
          session.expiresAt,
        ),
      );
      changed = true;
      await waitForContext(session);
      await checkActive();
      show();
    } catch {
      if (changed) {
        if (previousCookie)
          await storage.cookies.set({
            ...sessionCookie(previousCookie.value, targetApplication),
            ...(previousCookie.expirationDate
              ? { expirationDate: previousCookie.expirationDate }
              : {}),
          });
        else
          await storage.cookies.remove(
            new URL(targetApplication).origin,
            "qd_session",
          );
      }
      throw new Error(failedMessage);
    }
    return;
  }
  const oldUrl = window.webContents.getURL();
  const previousApplication = application;
  const previousUrl = isTrustedPage(oldUrl, application) ? oldUrl : null;
  const previousLayout = { ...layout };
  const oldCookie = (
    await storage.cookies.get({
      url: new URL(targetApplication).origin,
      name: "qd_session",
    })
  ).find((cookie) => cookie.path === "/");
  let cookieChanged = false;
  handoffNavigation = true;
  allowSavedNavigation = true;
  try {
    await storage.flushStorageData();
    // Dispose the old renderer before changing accounts, so its pending sync
    // cannot run under the new cookie or erase its original local state on 401.
    await handoffStatus();
    await checkActive();
    application = targetApplication;
    await storage.cookies.set(
      sessionCookie(session.sessionToken, targetApplication, session.expiresAt),
    );
    cookieChanged = true;
    await window.loadURL(workspaceUrl(application, session.roomId));
    await checkActive();
    await waitForContext(session);
    await checkActive();
    show();
  } catch {
    try {
      await handoffStatus("连接未完成，正在恢复原窗口…");
      if (cookieChanged) {
        if (oldCookie)
          await storage.cookies.set({
            ...sessionCookie(oldCookie.value, targetApplication),
            ...(oldCookie.expirationDate
              ? { expirationDate: oldCookie.expirationDate }
              : {}),
          });
        else
          await storage.cookies.remove(
            new URL(targetApplication).origin,
            "qd_session",
          );
      }
      application = previousApplication;
      if (previousUrl) {
        resize(previousLayout);
        await window.loadURL(previousUrl);
      } else await handoffStatus("连接未完成，请回到网页重试");
    } catch {
      application = previousApplication;
      /* The fixed warning below remains safe even if recovery fails. */
    }
    throw new Error(failedMessage);
  } finally {
    handoffNavigation = false;
    allowSavedNavigation = false;
  }
}
function requestHandoff(input) {
  if (externalUpdating || updates?.state().status === "installing")
    return Promise.resolve();
  let descriptor;
  try {
    descriptor = validateDescriptor(input);
  } catch {
    return Promise.resolve();
  }
  // Claim immediately even while another save/confirmation is in progress.
  // The ephemeral broker has a short claim deadline, then a longer apply limit.
  const claimed = claimSession(descriptor, legacyHandoffApplication).then(
    (session) => ({
      session: {
        ...session,
        origin: session.origin || new URL(legacyHandoffApplication).origin,
      },
    }),
    () => ({ error: true }),
  );
  const previous = actionPromise;
  const request = (async () => {
    if (previous) await previous.catch(() => {});
    let result = { applied: false, code: "failed", error: failedMessage };
    try {
      const credential = await claimed;
      if (credential.error || quitting || !window || window.isDestroyed())
        throw new Error(failedMessage);
      result = await applySessionHandoff({
        session: credential.session,
        prepare: async () => ({
          ...(await saveBeforeQuit()),
          origin: new URL(application).origin,
        }),
        confirm: async (saved) => {
          show();
          const answer = await dialog.showMessageBox(window, {
            type: "question",
            title: "切换桌面画布",
            defaultId: 0,
            cancelId: 0,
            buttons: ["保留当前画布", "切换到网页画布"],
            message: saved.hasDraft
              ? "还有未提交的待办输入。"
              : "还有未同步的待办修改。",
            detail: saved.hasDraft
              ? saved.draftsPersisted
                ? "未提交输入和待同步内容已保存到原账号的本机草稿；返回原账号和画布后可以继续编辑。是否切换？"
                : "待同步内容已保存到本机；还有未提交的输入，切换会丢弃这些输入。是否切换？"
              : "待同步内容已保存到原账号的本机草稿；返回原账号和画布后可恢复。是否切换？",
            noLink: true,
          });
          return answer.response === 1;
        },
        ensureActive: () => ensureActive(descriptor),
        activate: (session, options) =>
          activateHandoff(session, {
            ...options,
            ensureActive: () => ensureActive(descriptor),
          }),
      });
    } catch {
      if (window && !window.isDestroyed()) {
        show();
        if (!isTrustedPage(window.webContents.getURL(), application))
          await handoffStatus("连接未完成，请回到网页重试").catch(() => {});
        void dialog.showMessageBox(window, {
          type: "warning",
          title: "暂未切换桌面画布",
          message: failedMessage,
          buttons: ["返回窗口"],
        });
      }
    }
    try {
      await acknowledge(descriptor, result);
    } catch {
      /* Never log credentials or broker authorization. */
    }
    return result;
  })().finally(() => {
    if (actionPromise === request) actionPromise = null;
  });
  actionPromise = request;
  return request;
}
function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}
async function failurePage() {
  if (!window || window.isDestroyed() || unavailable) return;
  const previousLayout = layout;
  unavailable = true;
  resize(validateLayout({ mode: "setup" }));
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>启动轻单服务</title><style>body{margin:0;background:#f4f4ee;color:#26352a;font:16px/1.7 'Microsoft YaHei',sans-serif}header{padding:18px 24px;background:#e7ebe1;app-region:drag;user-select:none}main{max-width:600px;margin:70px auto;padding:30px}code{display:block;padding:15px;background:#e1e7dc;border-radius:12px}a{display:inline-block;color:white;background:#435d40;padding:10px 24px;border-radius:24px;text-decoration:none}small{display:block;margin-top:26px;color:#60705f}</style><header>轻岛</header><main><h1>先开启轻单服务</h1><p>桌面窗口暂时无法连接本机轻单。在项目终端运行：</p><code>npm run dev</code><p>等服务启动完成后，点击重新连接。</p><a href="${escapeHtml(application)}">重新连接</a><small>隐藏、重试或退出也可使用系统托盘里的轻岛图标。</small></main></html>`;
  try {
    await window.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(html),
    );
    show();
  } catch (error) {
    unavailable = false;
    resize(previousLayout);
    if (!navigationCancelled(error))
      console.error("无法显示连接提示：", error.message);
  }
}
function navigationCancelled(error) {
  return error?.code === "ERR_ABORTED" || error?.errno === -3;
}
function loadApplication(url = application) {
  unavailable = false;
  return window
    .loadURL(url)
    .catch((error) => (navigationCancelled(error) ? undefined : failurePage()));
}
async function createWindow({ handoff = false } = {}) {
  let previous;
  try {
    const value = JSON.parse(fs.readFileSync(positionFile, "utf8"));
    if (
      [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
      value.width > 0 &&
      value.height > 0
    )
      previous = islandPosition = {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
        dock: ["top", "left", "right", "free"].includes(value.dock)
          ? value.dock
          : "free",
      };
  } catch {
    /* First start or corrupt placement only resets the window position. */
  }
  const work = previous
    ? screen.getDisplayMatching(previous).workArea
    : screen.getPrimaryDisplay().workArea;
  // Migrate old free-floating coordinates before the renderer reads placement.
  previous = islandPosition = restorePlacement(previous, work);
  window = new BrowserWindow({
    ...fitWindowBounds(previous, layout, work),
    title: "轻岛",
    icon: icon(),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    thickFrame: false,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: "persist:qingdan-desktop",
      spellcheck: false,
      additionalArguments: [
        `--qingdan-origin=${new URL(localApplication).origin}`,
        `--qingdan-allow-origin=${new URL(legacyHandoffApplication).origin}`,
        ...[...desktopOnlineOrigins()].map(
          (origin) => `--qingdan-allow-origin=${origin}`,
        ),
      ],
    },
  });
  window.on("page-title-updated", (event) => event.preventDefault());
  if (app.isPackaged)
    installBundledWeb(
      window.webContents.session,
      path.join(process.resourcesPath, "web"),
    );
  window.setAlwaysOnTop(true, alwaysOnTopLevel(process.platform));
  window.setMenu(null);
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedPage(url, application)) event.preventDefault();
    else unavailable = false;
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedPage(url, application)) event.preventDefault();
  });
  window.webContents.on("did-navigate", (_event, url, responseCode) => {
    if (
      !handoffNavigation &&
      responseCode >= 400 &&
      isTrustedPage(url, application)
    )
      void failurePage();
  });
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, isInPlace, mainFrame) => {
      if (mainFrame && !isInPlace) {
        if (dragSession) dragWindow("cancel");
        rendererContext = null;
        rendererIslandReady = false;
        lastPlacement = "";
      }
    },
  );
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("will-prevent-unload", (event) => {
    // Only a completed local-save handshake and explicit draft consent may
    // bypass the sync hook's ordinary unsynced beforeunload guard.
    if (allowSavedNavigation) event.preventDefault();
  });
  window.webContents.on(
    "did-fail-load",
    (_event, code, _description, url, mainFrame) => {
      if (
        !handoffNavigation &&
        mainFrame &&
        code !== -3 &&
        isTrustedPage(url, application) &&
        !unavailable
      )
        void failurePage();
    },
  );
  window.webContents.on("render-process-gone", () => {
    if (!handoffNavigation) void failurePage();
  });
  window.once("ready-to-show", show);
  // Electron documents will-move as manual only on Windows/macOS; setBounds
  // animations must not overwrite the user's stable placement anchor.
  window.on("will-move", (_event, bounds) => {
    userMoving = true;
    rememberPosition(bounds);
  });
  window.on("moved", () => {
    if (!userMoving) return;
    userMoving = false;
    resize(layout, { relocate: true });
  });
  window.on("blur", () => {
    if (dragSession) dragWindow("end");
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("minimize", (event) => {
    event.preventDefault();
    window.hide();
  });
  tray = new Tray(icon());
  tray.setToolTip("轻岛");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示轻岛", click: show },
      { label: "隐藏轻岛", click: () => window.hide() },
      {
        label: "恢复到屏幕顶部",
        click: () => {
          resize(layout, { reset: true });
          show();
        },
      },
      {
        label: "重新连接轻单",
        click: () => {
          void requestSavedAction("reload");
        },
      },
      { type: "separator" },
      {
        label: "检查更新",
        click: () => {
          show();
          void updates?.check();
        },
      },
      {
        label: "重启并安装已下载更新",
        click: () => {
          void updates?.install().catch((error) =>
            dialog.showMessageBox(window, {
              type: "warning",
              message: error.message,
            }),
          );
        },
      },
      {
        label: "关于轻岛",
        click: () => {
          void dialog.showMessageBox(window, {
            title: "关于轻岛",
            message: `轻岛 ${app.getVersion()}`,
            detail:
              "自动下载更新；点击重启更新后安装。登录与草稿保存在本机独立数据目录。",
          });
        },
      },
      { type: "separator" },
      {
        label: "退出轻岛",
        click: () => {
          void requestQuit();
        },
      },
    ]),
  );
  tray.on("click", show);
  updates = createUpdateController({
    updater: app.isPackaged ? require("electron-updater").autoUpdater : null,
    version: app.getVersion(),
    changed: (state) => {
      if (state.status === "error") {
        quitting = false;
        allowSavedNavigation = false;
      }
      if (!window.isDestroyed())
        window.webContents.send("qingdan-desktop:update-state", state);
    },
    prepare: saveBeforeQuit,
    install: async (run) => {
      if (actionPromise || handoffNavigation || dragSession)
        throw Error("轻岛正在切换或保存，请稍后再试。");
      saveResume(profile, window.webContents.getURL());
      await window.webContents.session.flushStorageData();
      await window.webContents.session.cookies.flushStore();
      allowSavedNavigation = true;
      quitting = true;
      clearTimeout(positionTimer);
      try {
        run();
      } catch (error) {
        quitting = false;
        allowSavedNavigation = false;
        throw error;
      }
    },
  });
  if (app.isPackaged) {
    const control = await require("./launch-control.cjs").createLaunchControl({
      profile,
      version: app.getVersion(),
      prepareExit: async () => {
        if (
          externalUpdating ||
          quitting ||
          actionPromise ||
          handoffNavigation ||
          dragSession ||
          updates.state().status === "installing"
        )
          throw Error("轻岛正在切换或保存，请稍后重试。");
        externalUpdating = true;
        const previous = updates.state();
        window.webContents.send("qingdan-desktop:update-state", {
          status: "installing",
          currentVersion: app.getVersion(),
        });
        try {
          const saved = await saveBeforeQuit();
          if (!saved?.ok || (saved.hasDraft && !saved.draftsPersisted))
            throw Error("未提交输入尚未保存。");
          saveResume(profile, window.webContents.getURL());
          await window.webContents.session.flushStorageData();
          await window.webContents.session.cookies.flushStore();
          return () => {
            quitting = true;
            allowSavedNavigation = true;
            clearTimeout(positionTimer);
          };
        } catch (error) {
          externalUpdating = false;
          if (!window.isDestroyed())
            window.webContents.send("qingdan-desktop:update-state", previous);
          throw error;
        }
      },
      quit: () => app.quit(),
    });
    app.once("will-quit", control.close);
    if (
      !process.env.QINGDAN_DESKTOP_PROFILE ||
      process.env.QINGDAN_DESKTOP_WEB_LAUNCH_PORT
    ) {
      try {
        const webLaunch = await require("./web-launch.cjs").createWebLaunch({
          updates,
          requestHandoff,
          port: process.env.QINGDAN_DESKTOP_WEB_LAUNCH_PORT
            ? Number(process.env.QINGDAN_DESKTOP_WEB_LAUNCH_PORT)
            : 8791,
          onError: (message) => {
            if (!window.isDestroyed())
              void dialog.showMessageBox(window, {
                type: "warning",
                message,
                buttons: ["返回轻岛"],
              });
          },
        });
        app.once("will-quit", webLaunch.close);
      } catch {
        // The existing local Agent remains a fallback if the native port is busy.
        console.error("轻岛网页入口暂不可用，请检查 8791 端口占用。");
      }
    }
    const initialUpdate = setTimeout(() => void updates.check(), 30000);
    const recurringUpdate = setInterval(
      () => void updates.check(),
      6 * 60 * 60 * 1000,
    );
    initialUpdate.unref();
    recurringUpdate.unref();
    app.once("will-quit", () => {
      clearTimeout(initialUpdate);
      clearInterval(recurringUpdate);
    });
  }
  screen.on("display-removed", () => resize(layout, { relocate: true }));
  screen.on("display-metrics-changed", () =>
    resize(layout, { relocate: true }),
  );
  if (handoff) await handoffStatus();
  else void loadApplication();
}

ipcMain.handle("qingdan-desktop:layout", (event, input) => {
  guard(event);
  const next = validateLayout(input);
  if (next.dock && next.dock !== getPlacement().dock)
    return { ...window.getBounds(), ...getPlacement() };
  resize(next);
  rendererIslandReady = layout.mode === "island";
  checkContextReady();
  return { ...window.getBounds(), ...getPlacement() };
});
ipcMain.handle("qingdan-desktop:placement", (event) => {
  guard(event);
  return getPlacement();
});
ipcMain.handle("qingdan-desktop:drag", (event, action, origin) => {
  guard(event);
  return dragWindow(action, origin);
});
ipcMain.handle("qingdan-desktop:context", (event, input) => {
  guard(event);
  rendererContext = validateContext(input);
  saveResume(
    profile,
    rendererContext
      ? workspaceUrl(application, rendererContext.roomId)
      : new URL("/app", application).href,
  );
  checkContextReady();
  return true;
});
ipcMain.handle("qingdan-desktop:hide", (event) => {
  guard(event);
  window.hide();
  return true;
});
ipcMain.handle("qingdan-desktop:open-workspace", async (event, roomId) => {
  guard(event);
  await shell.openExternal(workspaceUrl(application, roomId));
  return true;
});
ipcMain.on("qingdan-desktop:prepared-quit", (event, result) => {
  if (
    !trusted(event) ||
    !pendingSave ||
    !result ||
    result.token !== pendingSave.token ||
    typeof result.ok !== "boolean"
  )
    return;
  const save = pendingSave;
  pendingSave = null;
  clearTimeout(save.timeout);
  let context = null;
  try {
    context = validateContext(result);
  } catch {
    /* Older clients can still save without identity. */
  }
  save.resolve({
    ok: result.ok,
    unsynced: result.unsynced === true,
    hasDraft: result.hasDraft === true,
    draftsPersisted: result.draftsPersisted === true,
    ...(context || {}),
  });
});

ipcMain.handle("qingdan-desktop:update-state", (event) => {
  guard(event);
  return updates?.state() || { status: "unsupported" };
});
ipcMain.handle("qingdan-desktop:check-update", (event) => {
  guard(event);
  return updates?.check();
});
ipcMain.handle("qingdan-desktop:install-update", (event) => {
  guard(event);
  return updates?.install();
});

async function start() {
  // Electron 45's Windows GUI process exposes an empty process.stdin even
  // when the OS stdin pipe contains data. Read the inherited descriptor itself.
  const descriptor = (process.argv || []).includes("--qingdan-desktop-handoff")
    ? await readDescriptor(
        fs.createReadStream(null, { fd: 0, autoClose: false }),
      )
    : null;
  if (
    await require("./forward-installed.cjs").forwardInstalledDesktop({
      packaged: app.isPackaged,
      descriptor,
      profile,
      env: process.env,
    })
  ) {
    quitting = true;
    app.quit();
    return;
  }
  if (
    !app.requestSingleInstanceLock(
      descriptor ? { qingdanHandoff: descriptor } : {},
    )
  ) {
    quitting = true;
    app.quit();
    return;
  }
  if (descriptor) layout = { mode: "island", width: 354, height: 76 };
  const ready = app
    .whenReady()
    .then(() => createWindow({ handoff: !!descriptor }));
  app.on("second-instance", (_event, _argv, _directory, additionalData) => {
    if (additionalData?.qingdanHandoff)
      void ready.then(() => requestHandoff(additionalData.qingdanHandoff));
    else void ready.then(show);
  });
  app.on("activate", show);
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void requestQuit();
    }
  });
  app.on("window-all-closed", () => {
    if (quitting) app.quit();
  });
  process.on("SIGINT", () => {
    void requestQuit();
  });
  process.on("SIGTERM", () => {
    void requestQuit();
  });
  await ready;
  if (descriptor) await requestHandoff(descriptor);
}
void start().catch(() => {
  console.error("桌面启动未完成，请从网页或项目终端重试。");
  quitting = true;
  app.quit();
});
