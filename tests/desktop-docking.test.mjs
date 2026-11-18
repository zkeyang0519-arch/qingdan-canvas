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

test("native twin mask preserves the CSS antialias fringe at common display scales", () => {
  const contains = (shape, x, y) =>
    shape.some(
      (r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height,
    );
  const cases = [
    [
      "top",
      false,
      false,
      false,
      400,
      72,
      [
        [12, 12, 293, 48, 24],
        [314, 12, 74, 48, 24],
      ],
    ],
    [
      "top",
      false,
      true,
      false,
      436,
      88,
      [
        [12, 12, 329, 64, 26],
        [350, 20, 74, 48, 24],
      ],
    ],
    [
      "left",
      true,
      false,
      false,
      80,
      127,
      [
        [12, 12, 56, 52, 26],
        [12, 71, 56, 44, 22],
      ],
    ],
    [
      "right",
      false,
      false,
      false,
      80,
      161,
      [
        [12, 12, 56, 86, 28],
        [12, 105, 56, 44, 22],
      ],
    ],
    [
      "left",
      false,
      true,
      false,
      342,
      161,
      [
        [12, 12, 318, 86, 25],
        [12, 105, 56, 44, 22],
      ],
    ],
    [
      "right",
      true,
      true,
      false,
      342,
      127,
      [
        [12, 12, 318, 52, 25],
        [274, 71, 56, 44, 22],
      ],
    ],
    ["top", false, false, true, 444, 510, [[12, 12, 420, 486, 25]]],
    ["left", false, false, true, 384, 510, [[12, 12, 360, 486, 25]]],
  ];
  for (const [side, empty, peek, expanded, width, height, surfaces] of cases) {
    const layout = {
      dock: side,
      empty,
      peek,
      expanded,
      width,
      height,
      appearance: "jade-twins",
    };
    const shape = dock.dockShape(layout, layout, null, work);
    for (const [x, y, w, h, r] of surfaces) {
      for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
        for (const [cx, cy, start] of [
          [x + r, y + r, Math.PI],
          [x + w - r, y + r, Math.PI * 1.5],
          [x + w - r, y + h - r, 0],
          [x + r, y + h - r, Math.PI * 0.5],
        ]) {
          for (let step = 0; step <= 40; step++) {
            const angle = start + (step * Math.PI) / 80;
            // Sample the device pixel covering the browser's soft outer edge,
            // including subpixel positioning at 125%, 150% and 175% scaling.
            const px =
              (Math.floor((cx + Math.cos(angle) * (r + 0.7 / scale)) * scale) +
                0.5) /
              scale;
            const py =
              (Math.floor((cy + Math.sin(angle) * (r + 0.7 / scale)) * scale) +
                0.5) /
              scale;
            assert.ok(
              contains(shape, px, py),
              `${side} ${scale}x clipped CSS edge at ${px},${py}`,
            );
          }
        }
      }
    }
    assert.equal(
      contains(shape, 12, 12),
      false,
      "transparent corners remain outside the window",
    );
    assert.equal(
      contains(shape, 5, height / 2),
      false,
      "outer margin still passes through",
    );
  }
});

test("twin island hit regions follow both capsules, mirrored peeks and the shorter empty rail", () => {
  const hit = (shape, x, y) =>
    shape.some(
      (r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height,
    );
  for (const side of ["left", "right"])
    for (const empty of [false, true])
      for (const peek of [false, true]) {
        const size = dock.compactSize(side, "jade-twins", empty);
        const layout = {
          ...size,
          width: peek ? 342 : size.width,
          dock: side,
          expanded: false,
          appearance: "jade-twins",
          empty,
          peek,
        };
        const bounds = dock.fitDockBounds(null, layout, work);
        const shape = dock.dockShape(bounds, layout, null, work);
        const x = side === "left" ? 40 : bounds.width - 40;
        const h = empty ? 52 : 86;
        assert.equal(hit(shape, x, 38), true);
        assert.equal(hit(shape, x, 12 + h + 3), false, "gap passes through");
        assert.equal(
          hit(shape, x, 12 + h + 27),
          true,
          "time capsule is clickable",
        );
        assert.equal(hit(shape, x, layout.height - 5), false);
        if (peek)
          assert.equal(hit(shape, 171, 40), true, "inward title is clickable");
        assert.equal(
          side === "left" ? bounds.x + 12 : bounds.x + bounds.width - 12,
          side === "left" ? work.x : work.x + work.width,
        );
      }
  for (const peek of [false, true]) {
    const layout = {
      appearance: "jade-twins",
      dock: "top",
      expanded: false,
      empty: false,
      peek,
      width: peek ? 436 : 400,
      height: peek ? 88 : 72,
    };
    const shape = dock.dockShape(layout, layout, null, work);
    assert.equal(hit(shape, 35, 36), true);
    assert.equal(hit(shape, layout.width - 90, 36), false);
    assert.equal(hit(shape, layout.width - 49, 36), true);
  }
});

test("native twin capability, drag cancellation and empty side docking preserve matching geometry", async (t) => {
  const f = await fixture(t);
  const layout = f.handlers.get("qingdan-desktop:layout"),
    drag = f.handlers.get("qingdan-desktop:drag");
  assert.equal(
    f.handlers.get("qingdan-desktop:placement")(f.event)
      .supportsRetainedTwinIsland,
    true,
  );
  assert.equal(
    f.handlers.get("qingdan-desktop:placement")(f.event).supportsTwinIsland,
    true,
  );
  layout(f.event, {
    mode: "island",
    dock: "top",
    expanded: false,
    appearance: "jade-twins",
    peek: false,
    empty: true,
    width: 400,
    height: 72,
  });
  const original = f.bounds();
  drag(f.event, "start", { x: 80, y: 38 });
  f.cursor({ x: 30, y: 450 });
  drag(f.event, "cancel");
  assert.deepEqual(f.bounds(), original);
  drag(f.event, "start", { x: 80, y: 38 });
  drag(f.event, "end");
  assert.equal(f.bounds().width, 80);
  assert.equal(f.bounds().height, 127);
  assert.equal(f.bounds().x, -12);
  layout(f.event, {
    mode: "island",
    dock: "left",
    expanded: false,
    appearance: "jade-twins",
    peek: true,
    empty: true,
    width: 342,
    height: 127,
  });
  assert.equal(f.bounds().width, 342);
  assert.equal(f.bounds().x, -12);
});

test("retained capsules keep their screen position while a separate clickable list opens below", () => {
  const hit = (shape, x, y) =>
    shape.some(
      (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
    );
  for (const edge of ["top", "left", "right"])
    for (const empty of [false, true])
      for (const horizontal of [
        work.x,
        work.x + 700,
        work.x + work.width - 100,
      ]) {
        const layout = {
          dock: edge,
          appearance: "jade-twins",
          empty,
          peek: false,
          retained: true,
        };
        const anchor = dock.restorePlacement(
          {
            x: horizontal,
            y: 200,
            ...dock.compactSize(edge, "jade-twins", empty),
            dock: edge,
          },
          work,
          "jade-twins",
          empty,
        );
        const compact = dock.fitDockBounds(
          anchor,
          {
            ...layout,
            ...dock.compactSize(edge, "jade-twins", empty),
            expanded: false,
          },
          work,
        );
        const expandedLayout = {
          ...layout,
          expanded: true,
          width: edge === "top" ? 444 : 384,
          height: 450,
        };
        const expanded = dock.fitDockBounds(anchor, expandedLayout, work);
        const placement = dock.placementState(
          anchor,
          expanded,
          work,
          false,
          expandedLayout,
        );
        const shape = dock.dockShape(expanded, expandedLayout, anchor, work);
        const headerX =
          edge === "top"
            ? 12 + placement.headerOffset
            : edge === "left"
              ? 12
              : expanded.width - 68;
        const compactX = edge === "right" ? compact.width - 68 : 12;
        assert.equal(expanded.x + headerX, compact.x + compactX);
        assert.equal(
          expanded.y,
          compact.y,
          "expanding must not recenter a side rail vertically",
        );
        const headerHeight = edge === "top" ? 48 : (empty ? 52 : 86) + 51;
        assert.ok(hit(shape, headerX + 28, 40));
        const timeX = edge === "top" ? headerX + 339 : headerX + 28;
        const timeY = edge === "top" ? 36 : 12 + headerHeight - 22;
        assert.ok(hit(shape, timeX, timeY), "small capsule remains clickable");
        assert.ok(
          hit(shape, expanded.width / 2, headerHeight + 60),
          "list below remains clickable",
        );
        assert.equal(
          hit(shape, timeX, 12 + headerHeight + 5),
          false,
          "transparent gap passes through",
        );
        if (edge !== "top")
          assert.equal(
            hit(shape, expanded.width / 2, 40),
            false,
            "empty space beside side capsules passes through",
          );
        const closed = dock.fitDockBounds(
          anchor,
          {
            ...layout,
            ...dock.compactSize(edge, "jade-twins", empty),
            expanded: false,
          },
          work,
        );
        assert.deepEqual(
          closed,
          compact,
          "collapse returns to the saved compact bounds",
        );
      }
});

test("twin hover and peek keep one native horizontal frame with click-through margins", () => {
  for (const edge of ["top", "left", "right"]) {
    const compact = dock.compactSize(edge, "jade-twins");
    const anchor = dock.restorePlacement(
      { ...compact, dock: edge, x: work.x + 600, y: 200 },
      work,
      "jade-twins",
    );
    const layout = {
      ...compact,
      dock: edge,
      appearance: "jade-twins",
      retained: true,
      fixedFrame: true,
    };
    const closed = dock.fitDockBounds(anchor, layout, work);
    for (const state of [
      { ...layout, peek: true, width: edge === "top" ? 436 : 342 },
      {
        ...layout,
        expanded: true,
        height: 450,
        width: edge === "top" ? 444 : 384,
      },
    ]) {
      const bounds = dock.fitDockBounds(anchor, state, work);
      assert.equal(bounds.x, closed.x);
      assert.equal(bounds.width, closed.width);
    }
    const regions = dock.dockShape(closed, layout, anchor, work);
    const hit = (x, y) =>
      regions.some(
        (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
      );
    if (edge === "top") {
      assert.equal(hit(20, 36), false);
      assert.equal(hit(424, 36), false);
      assert.equal(hit(380, 36), true);
    } else {
      assert.equal(hit(closed.width / 2, 39), false);
      assert.equal(hit(edge === "left" ? 40 : closed.width - 40, 120), true);
    }
  }
});

test("retained list uses available space below its anchor and stays inside a short display", () => {
  const area = { x: 1920, y: 0, width: 1280, height: 720 };
  const anchor = { x: 1908, y: 540, width: 80, height: 161, dock: "left" };
  const layout = {
    dock: "left",
    appearance: "jade-twins",
    retained: true,
    empty: false,
    expanded: true,
    width: 384,
    height: 400,
  };
  const bounds = dock.fitDockBounds(anchor, layout, area);
  assert.equal(bounds.y + bounds.height, 720);
  assert.equal(
    dock.placementState(anchor, bounds, area, false, layout).maxHeight,
    400,
  );
  const higher = { ...anchor, y: 100 };
  assert.equal(
    dock.placementState(higher, bounds, area, false, layout).maxHeight,
    620,
  );
});

test("jade capsule uses separate native hit regions and its transparent gap passes through", () => {
  const layout = {
    dock: "top",
    expanded: true,
    appearance: "jade",
    width: 370,
    height: 520,
  };
  const bounds = dock.fitDockBounds(null, layout, work);
  assert.equal(bounds.y + 12, work.y);
  const shape = dock.dockShape(bounds, layout, null, work);
  const hit = (x, y) =>
    shape.some(
      (r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height,
    );
  assert.equal(hit(185, 30), true);
  assert.equal(hit(310, 30), true, "the wider title and toggle stay clickable");
  assert.equal(hit(340, 30), false);
  assert.equal(hit(30, 30), false);
  assert.equal(hit(185, 60), false);
  assert.equal(hit(185, 80), true);
  assert.equal(hit(185, 505), true);
  const restored = dock.restorePlacement(null, work, "jade");
  assert.equal(restored.width, 314);
  assert.equal(restored.height, 64);
});

test("jade desktop keeps its compact dimensions and appearance through native drag and dock changes", async (t) => {
  const f = await fixture(t),
    layout = f.handlers.get("qingdan-desktop:layout"),
    drag = f.handlers.get("qingdan-desktop:drag");
  layout(f.event, {
    mode: "island",
    dock: "top",
    expanded: false,
    appearance: "jade",
    width: 314,
    height: 64,
  });
  assert.equal(f.bounds().width, 314);
  assert.equal(f.bounds().y, -12);
  drag(f.event, "start", { x: 80, y: 30 });
  assert.equal(f.bounds().width, 314);
  f.cursor({ x: 960, y: 300 });
  drag(f.event, "end");
  assert.equal(f.bounds().width, 314);
  assert.equal(f.bounds().height, 64);
  drag(f.event, "start");
  f.cursor({ x: 1500, y: 600 });
  drag(f.event, "end");
  assert.equal(f.bounds().width, 64);
  layout(f.event, {
    mode: "island",
    dock: "right",
    expanded: true,
    appearance: "jade",
    width: 418,
    height: 520,
  });
  assert.equal(f.bounds().x + f.bounds().width - 12, 1920);
});

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
