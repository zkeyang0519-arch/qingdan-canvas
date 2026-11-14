import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const require = createRequire(import.meta.url);
let policy = {};
try {
  policy = require("../desktop/window-policy.cjs");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}

test("desktop origin accepts loopback and the configured HTTPS app only", () => {
  assert.equal(typeof policy.parseAppUrl, "function");
  assert.equal(policy.parseAppUrl().href, "http://127.0.0.1:8790/app");
  assert.equal(
    policy.parseAppUrl("https://todo.zky.lol/app").origin,
    "https://todo.zky.lol",
  );
  assert.equal(
    policy.parseAppUrl("https://qingdan-canvas.zkeyang0519.workers.dev/app")
      .protocol,
    "https:",
  );
  assert.equal(
    policy.parseAppUrl("http://localhost:61234/app?room=test").port,
    "61234",
  );
  for (const url of [
    "https://evil.example/app",
    "https://todo.zky.lol.evil.example/app",
    "https://other.zky.lol/app",
    "http://todo.zky.lol/app",
    "file:///app",
    "http://127.0.0.1.evil/app",
    "http://127.0.0.1:8790/",
    "http://user:pass@127.0.0.1:8790/app",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => policy.parseAppUrl(url));
  }
});

test("extra desktop origins require exact HTTPS origins without wildcard domains", () => {
  const { desktopOnlineOrigins } = require("../shared/desktop-origins.cjs");
  const configured = desktopOnlineOrigins({
    QINGDAN_DESKTOP_ORIGINS:
      "https://preview.example, https://custom.example:8443",
  });
  assert.equal(configured.has("https://todo.zky.lol"), true);
  assert.equal(configured.has("https://preview.example"), true);
  assert.equal(configured.has("https://custom.example:8443"), true);
  for (const origin of [
    "http://example.com",
    "https://*.example.com",
    "https://example.com/app",
    "https://user:pass@example.com",
    "https://example.com/",
  ]) {
    assert.throws(() =>
      desktopOnlineOrigins({ QINGDAN_DESKTOP_ORIGINS: origin }),
    );
  }
});

test("Windows topmost does not follow the taskbar behind-floating placement path", () => {
  assert.equal(typeof policy.alwaysOnTopLevel, "function");
  assert.equal(policy.alwaysOnTopLevel("win32"), "normal");
  assert.equal(policy.alwaysOnTopLevel("darwin"), "floating");
  assert.equal(policy.alwaysOnTopLevel("linux"), "floating");
});

test("desktop bridge only trusts the configured app main frame", () => {
  assert.equal(typeof policy.isTrustedPage, "function");
  const app = "http://127.0.0.1:8790/app";
  assert.equal(
    policy.isTrustedPage("http://127.0.0.1:8790/app?room=a", app),
    true,
  );
  for (const url of [
    "http://localhost:8790/app",
    "http://127.0.0.1:8788/app",
    "http://127.0.0.1:8790/api/session",
    "http://127.0.0.1:8790/app/evil",
    "file:///app",
    "about:blank",
  ]) {
    assert.equal(policy.isTrustedPage(url, app), false);
  }
});

test("desktop layout rejects malformed or excessively large renderer requests", () => {
  assert.equal(typeof policy.validateLayout, "function");
  assert.deepEqual(
    policy.validateLayout({ mode: "island", width: 354, height: 76 }),
    { mode: "island", width: 354, height: 76 },
  );
  assert.deepEqual(policy.validateLayout({ mode: "setup" }), {
    mode: "setup",
    width: 920,
    height: 740,
  });
  for (const input of [
    null,
    [],
    { mode: "full" },
    { mode: "island", width: NaN, height: 76 },
    { mode: "island", width: 50000, height: 50000 },
    { mode: "island", width: "354", height: 76 },
    { mode: "island", width: 354, height: -1 },
  ]) {
    assert.throws(() => policy.validateLayout(input));
  }
});

test("desktop resize preserves center and top while constraining all edges to the display", () => {
  assert.equal(typeof policy.fitWindowBounds, "function");
  const work = { x: -1920, y: 32, width: 1920, height: 1048 };
  assert.deepEqual(
    policy.fitWindowBounds(
      { x: -1020, y: 44, width: 354, height: 76 },
      { width: 444, height: 600 },
      work,
    ),
    { x: -1065, y: 44, width: 444, height: 600 },
  );
  const fit = policy.fitWindowBounds(
    { x: 1000, y: 2000, width: 354, height: 76 },
    { width: 444, height: 600 },
    work,
  );
  assert.deepEqual(fit, { x: -444, y: 480, width: 444, height: 600 });
  const small = policy.fitWindowBounds(
    null,
    { width: 920, height: 740 },
    { x: 0, y: 0, width: 400, height: 300 },
  );
  assert.deepEqual(small, { x: 0, y: 0, width: 400, height: 300 });
});

test("desktop hit shape excludes transparent border and rounded corners", () => {
  assert.equal(typeof policy.islandShape, "function");
  const shape = policy.islandShape(354, 76);
  const hit = (x, y) =>
    shape.some(
      (r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height,
    );
  assert.equal(hit(0, 0), false);
  assert.equal(hit(12, 12), false);
  assert.equal(hit(176, 12), true);
  assert.equal(hit(176, 38), true);
  assert.equal(hit(353, 38), false);
  assert.ok(
    shape.every(
      (r) =>
        Number.isInteger(r.x) &&
        Number.isInteger(r.y) &&
        r.width > 0 &&
        r.height > 0 &&
        r.x >= 12 &&
        r.y >= 12 &&
        r.x + r.width <= 342 &&
        r.y + r.height <= 64,
    ),
  );
});

test("open in browser only constructs a safe same-origin room link", () => {
  assert.equal(typeof policy.workspaceUrl, "function");
  assert.equal(
    policy.workspaceUrl("http://127.0.0.1:8790/app?desktop=1", "room/a&b"),
    "http://127.0.0.1:8790/app?room=room%2Fa%26b",
  );
  assert.throws(() => policy.workspaceUrl("http://127.0.0.1:8790/app", ""));
  assert.throws(() =>
    policy.workspaceUrl("http://127.0.0.1:8790/app", "x".repeat(513)),
  );
});

async function preloadFixture({
  allowed = [],
  origin = "http://127.0.0.1:8790",
  pathname = "/app",
  mainFrame = true,
} = {}) {
  const listeners = new Map(),
    exposed = {},
    sent = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = value;
      },
    },
    ipcRenderer: {
      on(name, listener) {
        listeners.set(name, listener);
      },
      send(...args) {
        sent.push(args);
      },
      invoke(...args) {
        sent.push(args);
        return Promise.resolve(true);
      },
    },
  };
  vm.runInNewContext(
    await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
    {
      require(name) {
        assert.equal(name, "electron");
        return electron;
      },
      process: {
        isMainFrame: mainFrame,
        argv: [
          "--qingdan-origin=http://127.0.0.1:8790",
          ...allowed.map((origin) => `--qingdan-allow-origin=${origin}`),
        ],
      },
      location: { origin, pathname },
    },
  );
  return { bridge: exposed.qingdanDesktop, listeners, sent };
}

test("preload grants the narrow bridge only to the app main frame", async () => {
  for (const settings of [
    { origin: "http://evil.example" },
    { mainFrame: false },
    { pathname: "/api/session" },
  ]) {
    assert.equal((await preloadFixture(settings)).bridge, undefined);
  }
  const { bridge } = await preloadFixture();
  assert.deepEqual(Object.keys(bridge).sort(), [
    "checkForUpdates",
    "drag",
    "getPlacement",
    "getUpdateState",
    "hide",
    "installUpdate",
    "onBeforeQuit",
    "onPlacement",
    "onUpdateState",
    "openWorkspace",
    "setContext",
    "setLayout",
    "version",
  ]);
  assert.equal(bridge.version, 1);
  assert.equal(Object.isFrozen(bridge), true);
});

test("preload permits the configured online main frame while excluding other frames and origins", async () => {
  const origin = "https://qingdan-canvas.zkeyang0519.workers.dev";
  assert.ok((await preloadFixture({ origin, allowed: [origin] })).bridge);
  assert.equal(
    (await preloadFixture({ origin, allowed: [origin], mainFrame: false }))
      .bridge,
    undefined,
  );
  assert.equal(
    (await preloadFixture({ origin: "https://other.test", allowed: [origin] }))
      .bridge,
    undefined,
  );
});

test("preload waits for the current save callback and stale cleanup cannot erase it", async () => {
  const { bridge, listeners, sent } = await preloadFixture();
  let finish;
  const oldCleanup = bridge.onBeforeQuit(() => {
    throw Error("old callback must not run");
  });
  bridge.onBeforeQuit(async () => {
    await new Promise((resolve) => {
      finish = resolve;
    });
    return { unsynced: true, hasDraft: true };
  });
  oldCleanup();
  const saving = listeners.get("qingdan-desktop:prepare-quit")(
    null,
    "save-token",
  );
  assert.deepEqual(sent, []);
  finish();
  await saving;
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    [
      "qingdan-desktop:prepared-quit",
      { token: "save-token", ok: true, unsynced: true, hasDraft: true },
    ],
  ]);
});

test("preload reports save rejection rather than authorizing quit", async () => {
  const { bridge, listeners, sent } = await preloadFixture();
  bridge.onBeforeQuit(async () => {
    throw Error("storage failure");
  });
  await listeners.get("qingdan-desktop:prepare-quit")(null, "save-token");
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    ["qingdan-desktop:prepared-quit", { token: "save-token", ok: false }],
  ]);
});

test("preload exposes context reporting without exposing credentials and includes public saved identity", async () => {
  const { bridge, listeners, sent } = await preloadFixture();
  await bridge.setContext({ accountId: "alice", roomId: "room-a" });
  bridge.onBeforeQuit(async () => ({
    unsynced: false,
    hasDraft: true,
    accountId: "alice",
    roomId: "room-a",
    sessionToken: "never-forward-this",
  }));
  await listeners.get("qingdan-desktop:prepare-quit")(null, "save-token");
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    ["qingdan-desktop:context", { accountId: "alice", roomId: "room-a" }],
    [
      "qingdan-desktop:prepared-quit",
      {
        token: "save-token",
        ok: true,
        unsynced: false,
        hasDraft: true,
        accountId: "alice",
        roomId: "room-a",
      },
    ],
  ]);
});

test("desktop reconnect waits for persistence and consent before changing the page", async () => {
  let performSavedAction;
  try {
    ({ performSavedAction } = require("../desktop/save-before-action.cjs"));
  } catch {}
  assert.equal(typeof performSavedAction, "function");
  const calls = [];
  let saved;
  const action = performSavedAction({
    prepare: () =>
      new Promise((resolve) => {
        saved = resolve;
      }),
    confirm: async (state) => {
      calls.push(["confirm", state.hasDraft]);
      return true;
    },
    perform: async () => {
      calls.push(["reload"]);
    },
  });
  assert.deepEqual(calls, []);
  saved({ ok: true, hasDraft: true, unsynced: false });
  assert.equal(await action, true);
  assert.deepEqual(calls, [["confirm", true], ["reload"]]);
});

test("desktop reconnect leaves the page intact after save failure, timeout or cancelled consent", async () => {
  let performSavedAction;
  try {
    ({ performSavedAction } = require("../desktop/save-before-action.cjs"));
  } catch {}
  assert.equal(typeof performSavedAction, "function");
  let changed = false;
  const perform = async () => {
    changed = true;
  };
  await assert.rejects(
    performSavedAction({
      prepare: async () => ({ ok: false }),
      confirm: async () => true,
      perform,
    }),
    /保存失败/,
  );
  await assert.rejects(
    performSavedAction({
      prepare: async () => {
        throw Error("save timeout");
      },
      confirm: async () => true,
      perform,
    }),
    /save timeout/,
  );
  assert.equal(
    await performSavedAction({
      prepare: async () => ({ ok: true, unsynced: true }),
      confirm: async () => false,
      perform,
    }),
    false,
  );
  assert.equal(changed, false);
});

async function mainFixture() {
  const listeners = new Map();
  const electron = {
    app: {
      setPath() {},
      setName() {},
      requestSingleInstanceLock: () => false,
      quit() {},
    },
    ipcMain: {
      handle() {},
      on(name, listener) {
        listeners.set(name, listener);
      },
    },
    screen: {
      getDisplayMatching: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
  };
  const context = {
    require(name) {
      if (name === "electron") return electron;
      if (name === "node:fs") return { mkdirSync() {}, writeFileSync() {} };
      if (name.startsWith("./")) return require("../desktop/" + name.slice(2));
      return require(name);
    },
    __dirname: "D:/fixture/desktop",
    process: { env: {}, platform: "win32" },
    setTimeout,
    clearTimeout,
    console,
    Buffer,
    URL,
  };
  const source = await readFile(
    new URL("../desktop/main.cjs", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(
    source +
      `\nglobalThis.hostHarness = { loadApplication, prepare: saveBeforeQuit, resize, rememberPosition, clearPlacementTimer: () => clearTimeout(positionTimer), setWindow(value, failed) { window=value; unavailable=failed; }, isUnavailable: () => unavailable };`,
    context,
  );
  return { host: context.hostHarness, listeners };
}

test("cancelled navigation retains the real page and never tries to replace it with a failure page", async () => {
  const { host } = await mainFixture();
  const calls = [];
  const abort = Object.assign(new Error("ERR_ABORTED"), {
    code: "ERR_ABORTED",
    errno: -3,
  });
  host.setWindow(
    {
      isDestroyed: () => false,
      loadURL: async (url) => {
        calls.push(url);
        throw abort;
      },
      getBounds: () => ({ x: 0, y: 0, width: 920, height: 740 }),
      setBounds() {},
      setShape() {},
      isMinimized: () => false,
      show() {},
      focus() {},
    },
    false,
  );
  await host.loadApplication();
  assert.equal(calls.length, 1);
  assert.equal(host.isUnavailable(), false);
});

test("a stale failure flag cannot skip saving a still-trusted live workspace", async () => {
  const { host, listeners } = await mainFixture();
  const sent = [];
  const mainFrame = { url: "http://127.0.0.1:8790/app?room=a" };
  const webContents = {
    mainFrame,
    getURL: () => mainFrame.url,
    send: (...args) => sent.push(args),
  };
  host.setWindow({ isDestroyed: () => false, webContents }, true);
  const saving = host.prepare();
  assert.equal(sent.length, 1);
  listeners.get("qingdan-desktop:prepared-quit")(
    { sender: webContents, senderFrame: mainFrame },
    { token: sent[0][1], ok: true, unsynced: true, hasDraft: false },
  );
  assert.equal((await saving).unsynced, true);
});

test("twenty animated island expand-collapse cycles keep one native center anchor", async () => {
  const { host } = await mainFixture();
  let bounds = { x: 500, y: 12, width: 920, height: 740 };
  host.setWindow(
    {
      isDestroyed: () => false,
      getBounds: () => bounds,
      setBounds(next) {
        bounds = { ...next };
      },
      setShape() {},
    },
    false,
  );
  host.resize({ mode: "island", width: 354, height: 76 });
  const initial = { ...bounds };
  for (let cycle = 0; cycle < 20; cycle++) {
    for (let width = 354; width <= 444; width++)
      host.resize({ mode: "island", width, height: 400 });
    for (let width = 444; width >= 354; width--)
      host.resize({ mode: "island", width, height: 76 });
    assert.equal(
      bounds.x + bounds.width / 2,
      initial.x + initial.width / 2,
      `center drift after cycle ${cycle + 1}`,
    );
    assert.equal(bounds.y, initial.y);
  }
  host.clearPlacementTimer();
});

test("manual placement keeps the capsule at the top and explicit reset centers its anchor", async () => {
  const { host } = await mainFixture();
  let bounds = { x: 500, y: 12, width: 920, height: 740 };
  host.setWindow(
    {
      isDestroyed: () => false,
      getBounds: () => bounds,
      setBounds(next) {
        bounds = { ...next };
      },
      setShape() {},
    },
    false,
  );
  host.resize({ mode: "island", width: 354, height: 76 });
  bounds = { x: 100, y: 200, width: 354, height: 76 };
  host.rememberPosition(bounds);
  host.resize({ mode: "island", width: 444, height: 400 });
  assert.equal(bounds.x + bounds.width / 2, 277);
  assert.equal(bounds.y, 0);
  host.resize({ mode: "island", width: 444, height: 400 }, { reset: true });
  host.resize({ mode: "island", width: 354, height: 76 });
  assert.equal(bounds.x + bounds.width / 2, 960);
  assert.equal(bounds.y, 0);
  host.clearPlacementTimer();
});
