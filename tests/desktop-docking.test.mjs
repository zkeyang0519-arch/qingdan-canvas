import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const require = createRequire(import.meta.url);
let dock = {};
try {
  dock = require("../desktop/docking.cjs");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const work = { x: -1920, y: 32, width: 1920, height: 1048 };

test("drag release chooses top or sides from the display center, including drops far from every edge", () => {
  assert.equal(typeof dock.dockAtPoint, "function");
  const point = (x, y) => ({
    x: work.x + work.width * x,
    y: work.y + work.height * y,
  });
  for (const [x, y, expected] of [
    [0.5, 0.35, "top"],
    [0.35, 0.5, "left"],
    [0.65, 0.5, "right"],
    [0.25, 0.25, "top"],
    [0.2, 0.3, "left"],
    [0.8, 0.3, "right"],
    [0.5, 0.5, "top"],
    [0.35, 0.85, "left"],
    [0.65, 0.85, "right"],
    [0.5, 1, "right"],
  ])
    assert.equal(dock.dockAtPoint(point(x, y), work), expected);
  for (let x = 0; x <= 1; x += 0.05)
    for (let y = 0; y <= 1; y += 0.05)
      assert.ok(
        ["top", "left", "right"].includes(dock.dockAtPoint(point(x, y), work)),
      );
});

test("legacy free or missing dock positions restore onto an edge and valid docks retain their side", () => {
  assert.equal(typeof dock.restorePlacement, "function");
  for (const savedDock of [undefined, "free"])
    for (const [x, y, expected] of [
      [-960, 320, "top"],
      [-1200, 600, "left"],
      [-700, 600, "right"],
    ]) {
      const restored = dock.restorePlacement(
        { x: x - 177, y: y - 38, width: 354, height: 76, dock: savedDock },
        work,
      );
      assert.equal(restored.dock, expected);
      if (expected === "top") assert.equal(restored.y, work.y);
      else
        assert.equal(
          expected === "left"
            ? restored.x + 12
            : restored.x + restored.width - 12,
          expected === "left" ? work.x : work.x + work.width,
        );
    }
  assert.equal(dock.restorePlacement(null, work).dock, "top");
  const saved = { x: -1972, y: 100, width: 64, height: 160, dock: "right" };
  const restored = dock.restorePlacement(saved, work);
  assert.equal(restored.dock, "right");
  assert.equal(restored.x + restored.width - 12, 0);
});

test("side expansion stays attached and twenty size cycles retain the original tab center", () => {
  assert.equal(typeof dock.placementAtPoint, "function");
  for (const side of ["left", "right"]) {
    const anchor = dock.placementAtPoint(
      { x: side === "left" ? -1910 : -10, y: 500 },
      { x: 30, y: 38 },
      work,
    );
    assert.equal(anchor.dock, side);
    const closed = dock.fitDockBounds(
      anchor,
      { dock: side, width: 64, height: 160 },
      work,
    );
    for (let i = 0; i < 20; i++) {
      const open = dock.fitDockBounds(
        anchor,
        { dock: side, width: 492, height: 620 },
        work,
      );
      assert.equal(
        side === "left" ? open.x + 12 : open.x + open.width - 12,
        side === "left" ? work.x : 0,
      );
      assert.deepEqual(
        dock.fitDockBounds(
          anchor,
          { dock: side, width: 64, height: 160 },
          work,
        ),
        closed,
      );
      const state = dock.placementState(anchor, open, work, false);
      assert.equal(open.y + state.railOffset + 68, 500);
    }
  }
});

test("inside-screen drops snap to the top and display removal preserves a reachable edge", () => {
  assert.equal(typeof dock.fitDockBounds, "function");
  const anchor = dock.placementAtPoint(
    { x: -1000, y: 400 },
    { x: 30, y: 38 },
    work,
  );
  assert.equal(anchor.dock, "top");
  assert.deepEqual(
    dock.fitDockBounds(anchor, { dock: "top", width: 354, height: 76 }, work),
    { x: -1030, y: 32, width: 354, height: 76 },
  );
  const relocated = dock.fitDockBounds(
    anchor,
    { dock: "top", width: 444, height: 620 },
    { x: 0, y: 0, width: 800, height: 600 },
  );
  assert.deepEqual(relocated, { x: 0, y: 0, width: 444, height: 600 });
});

test("side hit shape contains the tab and panel but not the transparent corridor", () => {
  assert.equal(typeof dock.dockShape, "function");
  for (const side of ["left", "right"]) {
    const anchor = { x: 0, y: 200, width: 64, height: 160, dock: side };
    const layout = { dock: side, expanded: true, width: 492, height: 500 };
    const bounds = dock.fitDockBounds(anchor, layout, {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    const shape = dock.dockShape(bounds, layout, anchor, {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    const hit = (x, y) =>
      shape.some(
        (r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height,
      );
    const railX = side === "left" ? 32 : 460;
    const gapX = side === "left" ? 56 : 436;
    assert.equal(hit(railX, 250), true);
    assert.equal(hit(gapX, 250), false);
    assert.equal(hit(246, 250), true);
    assert.equal(hit(railX, 20), false);
  }
});

async function fixture(
  t,
  dual = false,
  saved = { x: 500, y: 0, width: 354, height: 76, dock: "top" },
) {
  let cursor = { x: 600, y: 38 },
    bounds = {
      x: saved.x,
      y: saved.y,
      width: saved.width,
      height: saved.height,
    };
  const area = { x: 0, y: 0, width: 1920, height: 1080 },
    handlers = new Map(),
    sent = [];
  const secondary = { ...area, x: 1920 };
  const screen = {
    getCursorScreenPoint: () => cursor,
    getDisplayNearestPoint: (point) => ({
      workArea: dual && point.x >= 1920 ? secondary : area,
    }),
    getDisplayMatching: (rect) => ({
      workArea: dual && rect.x + rect.width / 2 >= 1920 ? secondary : area,
    }),
    getPrimaryDisplay: () => ({ workArea: area }),
  };
  const electron = {
    screen,
    app: {
      setPath() {},
      setName() {},
      requestSingleInstanceLock: () => false,
      quit() {},
    },
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), on() {} },
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
  vm.runInNewContext(
    (await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8")) +
      '\nglobalThis.harness = { show, setWindow(w, dock) { window=w; layout={mode:"island",dock,expanded:false,width:354,height:76}; islandPosition={...w.getBounds(),dock}; }, cleanup() { clearTimeout(positionTimer); } };',
    context,
  );
  const mainFrame = { url: "http://127.0.0.1:8790/app" },
    wc = {
      mainFrame,
      send: (...args) => sent.push(args),
      getURL: () => mainFrame.url,
    };
  context.harness.setWindow(
    {
      isDestroyed: () => false,
      getBounds: () => bounds,
      setBounds: (next) => {
        bounds = { ...next };
      },
      setShape() {},
      isMinimized: () => false,
      show() {},
      focus() {},
      webContents: wc,
    },
    saved.dock,
  );
  t.after(context.harness.cleanup);
  return {
    handlers,
    sent,
    event: { sender: wc, senderFrame: mainFrame },
    cursor: (point) => {
      cursor = point;
    },
    bounds: () => bounds,
    show: context.harness.show,
  };
}

test("showing an old floating capsule migrates it to a side and stale free layouts cannot detach it", async (t) => {
  const f = await fixture(t, false, {
    x: 500,
    y: 480,
    width: 354,
    height: 76,
    dock: "free",
  });
  f.show();
  assert.equal(
    f.handlers.get("qingdan-desktop:placement")(f.event).dock,
    "left",
  );
  assert.equal(f.bounds().x, -12);
  assert.equal(f.bounds().width, 64);
  const before = f.bounds();
  f.handlers.get("qingdan-desktop:layout")(f.event, {
    mode: "island",
    dock: "free",
    expanded: false,
    width: 354,
    height: 76,
  });
  assert.deepEqual(f.bounds(), before);
});

test("native releases in the middle of each region always attach to the corresponding edge", async (t) => {
  const f = await fixture(t),
    drag = f.handlers.get("qingdan-desktop:drag");
  for (const [x, y, expected] of [
    [960, 400, "top"],
    [700, 540, "left"],
    [1200, 540, "right"],
    [900, 900, "left"],
  ]) {
    drag(f.event, "start");
    f.cursor({ x, y });
    drag(f.event, "move");
    const state = drag(f.event, "end");
    assert.equal(state.dock, expected);
    assert.equal(state.dragging, false);
    const bounds = f.bounds();
    if (expected === "top") assert.equal(bounds.y, 0);
    else
      assert.equal(
        expected === "left" ? bounds.x + 12 : bounds.x + bounds.width - 12,
        expected === "left" ? 0 : 1920,
      );
  }
});

test("guarded native drag uses the system cursor, snaps on release and rejects stale layouts", async (t) => {
  const f = await fixture(t),
    drag = f.handlers.get("qingdan-desktop:drag");
  assert.equal(typeof drag, "function");
  assert.throws(
    () => drag({ ...f.event, senderFrame: {} }, "start"),
    /Untrusted/,
  );
  assert.throws(() => drag(f.event, "teleport"), /Invalid/);
  assert.equal(drag(f.event, "start").dragging, true);
  f.cursor({ x: 1910, y: 600 });
  drag(f.event, "move");
  const placement = drag(f.event, "end");
  assert.equal(placement.dock, "right");
  assert.equal(placement.dragging, false);
  const before = { ...f.bounds() };
  f.handlers.get("qingdan-desktop:layout")(f.event, {
    mode: "island",
    dock: "free",
    expanded: false,
    width: 354,
    height: 76,
  });
  assert.deepEqual(f.bounds(), before);
  f.handlers.get("qingdan-desktop:layout")(f.event, {
    mode: "island",
    dock: "right",
    expanded: true,
    width: 492,
    height: 500,
  });
  assert.equal(f.bounds().x + f.bounds().width - 12, 1920);
  assert.ok(f.sent.some(([name]) => name === "qingdan-desktop:placement"));
});

test("cancelled movement restores the placement and late moves cannot restart a drag", async (t) => {
  const f = await fixture(t),
    drag = f.handlers.get("qingdan-desktop:drag");
  assert.equal(typeof drag, "function");
  const before = { ...f.bounds() };
  drag(f.event, "start");
  f.cursor({ x: 900, y: 700 });
  drag(f.event, "move");
  drag(f.event, "cancel");
  assert.deepEqual(f.bounds(), before);
  drag(f.event, "move");
  assert.deepEqual(f.bounds(), before);
});

test("drag keeps the original grab point instead of losing movement before the first IPC", async (t) => {
  const f = await fixture(t),
    drag = f.handlers.get("qingdan-desktop:drag");
  f.cursor({ x: 700, y: 300 });
  drag(f.event, "start", { x: 100, y: 38 });
  assert.equal(f.bounds().x, 600);
  assert.equal(f.bounds().y, 262);
  drag(f.event, "cancel");
  assert.throws(
    () => drag(f.event, "start", { x: Infinity, y: 38 }),
    /Invalid/,
  );
});

test("release near a second display edge docks to that display even with most of the dragged capsule on the first", async (t) => {
  const f = await fixture(t, true),
    drag = f.handlers.get("qingdan-desktop:drag");
  f.cursor({ x: 700, y: 250 });
  drag(f.event, "start");
  f.cursor({ x: 1925, y: 600 });
  drag(f.event, "move");
  drag(f.event, "end");
  assert.equal(f.bounds().x, 1908);
  f.handlers.get("qingdan-desktop:layout")(f.event, {
    mode: "island",
    dock: "left",
    expanded: true,
    width: 492,
    height: 500,
  });
  assert.equal(f.bounds().x, 1908);
  f.cursor({ x: 1950, y: 600 });
  drag(f.event, "start");
  f.cursor({ x: 900, y: 300 });
  drag(f.event, "move");
  drag(f.event, "cancel");
  assert.equal(f.bounds().x, 1908, "cancel restores the original display");
});
