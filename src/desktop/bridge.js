export function getDesktopBridge() {
  const bridge = globalThis.window?.qingdanDesktop;
  return bridge?.version === 1 &&
    ["setLayout", "hide", "openWorkspace", "onBeforeQuit"].every(
      (name) => typeof bridge[name] === "function",
    )
    ? bridge
    : null;
}

export function requestDesktopLayout(bridge, layout) {
  // A closing native window may stop accepting layout updates during cleanup.
  Promise.resolve(bridge.setLayout(layout))
    .then((result) => {
      if (Number.isFinite(result?.maxHeight)) {
        const height = Math.max(128, Math.min(2160, result.maxHeight));
        document.documentElement.style.setProperty(
          "--desktop-max-height",
          `${height}px`,
        );
      }
    })
    .catch(() => {});
}
