// Preserve the existing frontend contract; share geometry with Electron.
const { validateLayout } = require("./window-policy.cjs");
const { exportPortable, importPortable } = require("./portable-state.mjs");
const {
  compactSize,
  restorePlacement,
  fitDockBounds,
  placementAtPoint,
  placementState,
  dockShape,
} = require("./docking.cjs");
const trusted =
  location.pathname === "/tauri-preview.html" || location.pathname === "/app";
if (window === window.top && trusted && window.__TAURI_INTERNALS__) {
  const invoke = (op, data = null) =>
    window.__TAURI_INTERNALS__.invoke("desktop", { op, data });
  let layout = { mode: "setup", width: 920, height: 740 },
    anchor,
    drag,
    bounds,
    work;
  let beforeQuit,
    queue = Promise.resolve();
  const placements = new Set(),
    updates = new Set();
  const state = () => ({
    ...placementState(anchor, bounds, work, !!drag, layout),
    supportsJade: true,
    supportsTwinIsland: true,
    supportsRetainedTwinIsland: true,
    supportsFixedTwinFrame: true,
  });
  const geometry = async () => {
    const info = await invoke("geometry", { dragging: !!drag });
    work = info.work;
    bounds = info.bounds;
    if (!anchor) anchor = info.saved || restorePlacement(null, work);
    return info;
  };
  const compact = (current, dock) => ({
    ...current,
    ...compactSize(dock, current.appearance, current.empty),
    dock,
    expanded: false,
    ...(current.appearance === "jade-twins" ? { peek: false } : {}),
  });
  const resize = async (next, info) => {
    info ??= await geometry();
    work = info.work;
    layout = drag ? compact(drag.layout, "free") : next;
    if (!drag && layout.mode === "island") {
      anchor = restorePlacement(anchor, work, layout.appearance, layout.empty);
      if (layout.dock && layout.dock !== anchor.dock)
        layout = compact(layout, anchor.dock);
    }
    bounds = drag
      ? {
          x: info.cursor.x - drag.offset.x,
          y: info.cursor.y - drag.offset.y,
          width: layout.width,
          height: layout.height,
        }
      : layout.mode === "island" && !layout.dock
        ? fitDockBounds(
            { ...anchor, dock: "top" },
            { ...layout, dock: "top" },
            work,
          )
        : fitDockBounds(
            layout.mode === "island" ? anchor : bounds,
            layout,
            work,
          );
    const rects =
      layout.mode === "island" ? dockShape(bounds, layout, anchor, work) : [];
    await invoke("bounds", {
      bounds,
      rects,
      scale: info.scale || 1,
      islandReady: layout.mode === "island",
      dragging: !!drag,
    });
    const value = state();
    for (const listener of placements) listener(value);
    return { ...bounds, ...value };
  };
  const serial = (fn) => {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  };
  const subscribe = (set, cb) => {
    set.add(cb);
    return () => set.delete(cb);
  };
  window.qingdanDesktop = Object.freeze({
    version: 1,
    runtime: "tauri",
    setLayout: (input) => serial(() => resize(validateLayout(input))),
    getPlacement: () =>
      serial(async () => {
        await geometry();
        return state();
      }),
    onPlacement: (cb) => subscribe(placements, cb),
    drag: (action, origin) =>
      serial(async () => {
        if (!["start", "move", "end", "cancel"].includes(action))
          throw Error("Invalid drag");
        const info = await geometry();
        if (layout.mode !== "island") return state();
        if (action === "start" && !drag) {
          const size = compactSize("free", layout.appearance);
          drag = {
            anchor: { ...anchor },
            layout: { ...layout },
            work,
            scale: info.scale,
            offset: {
              x: Math.max(
                24,
                Math.min(
                  size.width - 12,
                  origin?.x ?? info.cursor.x - bounds.x,
                ),
              ),
              y: Math.max(12, Math.min(size.height - 12, origin?.y ?? 38)),
            },
          };
        } else if ((action === "end" || action === "cancel") && drag) {
          const previous = drag;
          drag = null;
          if (action === "cancel") {
            anchor = previous.anchor;
            return resize(previous.layout, {
              ...info,
              work: previous.work,
              scale: previous.scale,
            });
          }
          anchor = placementAtPoint(
            info.cursor,
            previous.offset,
            work,
            previous.layout.appearance,
            previous.layout.empty,
          );
          layout = compact(previous.layout, anchor.dock);
          await invoke("save_position", anchor);
        }
        return resize(layout, info);
      }),
    setContext: (context) => invoke("context", context),
    hide: () => invoke("hide"),
    openWorkspace: (roomId) => invoke("open_workspace", roomId),
    onBeforeQuit: (cb) => {
      beforeQuit = cb;
      return () => {
        if (beforeQuit === cb) beforeQuit = null;
      };
    },
    getUpdateState: () => invoke("update"),
    checkForUpdates: () => invoke("check_update"),
    openPreviewDownloads: () => invoke("open_preview_downloads"),
    installUpdate: () => invoke("install_update"),
    onUpdateState: (cb) => subscribe(updates, cb),
  });
  // Native asks for a save; no session credential ever crosses this bridge.
  const listen = async () => {
    if (!window.__TAURI__?.event) {
      setTimeout(listen, 10);
      return;
    }
    await window.__TAURI__.event.listen(
      "prepare-save",
      async ({ payload: token }) => {
        try {
          const result = beforeQuit
            ? await beforeQuit()
            : { missingHandler: true };
          await invoke("saved", { ...result, ok: result?.ok !== false, token });
        } catch {
          await invoke("saved", { ok: false, token });
        }
      },
    );
    window.__TAURI__.event.listen("update-state", ({ payload }) => {
      for (const listener of updates) listener(payload);
    });
    window.__TAURI__.event.listen("transition-state", ({ payload }) => {
      if (window.document?.body) window.document.body.inert = payload === true;
    });
    window.__TAURI__.event.listen("migration-request", async ({ payload }) => {
      try {
        if (location.pathname !== "/app") throw Error("请先登录真实账号。");
        const response = await fetch("/api/session", {
          credentials: "same-origin",
          redirect: "error",
        });
        const session = await response.json();
        if (!response.ok || !session.user?.id)
          throw Error("请先登录需要迁移的账号。");
        const value =
          payload.action === "export"
            ? await exportPortable(session.user.id)
            : await importPortable(payload.value, session.user.id);
        await invoke("migration_result", {
          token: payload.token,
          ok: true,
          value,
        });
      } catch (error) {
        await invoke("migration_result", {
          token: payload.token,
          ok: false,
          error: error.message,
        });
      }
    });
    window.__TAURI__.event.listen("reset-position", () =>
      serial(async () => {
        const info = await geometry();
        drag = null;
        anchor = restorePlacement(null, work, layout.appearance, layout.empty);
        await invoke("save_position", anchor);
        await resize(
          layout.mode === "island" ? compact(layout, "top") : layout,
          info,
        );
      }),
    );
    window.__TAURI__.event.listen("display-changed", () =>
      serial(() => resize(layout)),
    );
    await invoke("bridge_ready");
  };
  listen();
}
