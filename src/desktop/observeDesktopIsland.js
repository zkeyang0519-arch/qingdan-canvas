import { requestDesktopLayout } from "./bridge.js";

export function observeDesktopIsland(bridge, container, placement, dragging) {
  if (!bridge) return;
  const island = container?.querySelector(".dynamic-island");
  const opening = container?.querySelector(".desktop-opening-capsule");
  const target =
    island || opening || container?.querySelector(".desktop-loading-card");
  if (!target) return;
  let frame;
  let previous = "";
  const measure = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const bounds = target.getBoundingClientRect();
      const width =
        Math.ceil(bounds.width || (island || opening ? 330 : 420)) + 24;
      const height =
        Math.ceil(bounds.height || (island || opening ? 52 : 176)) + 24;
      const dock = dragging ? "free" : placement;
      const expanded = island?.dataset.open === "true";
      const twins = island?.dataset.layout === "twins";
      const retained = island?.dataset.retained === "true";
      const fixedFrame = island?.dataset.fixedFrame === "true";
      const peek = island?.dataset.peek === "true";
      const empty = island?.dataset.empty === "true";
      const extraWidth = Number(island?.dataset.extraWidth),
        extraHeight = Number(island?.dataset.extraHeight);
      const size = `${width}/${height}/${dock}/${expanded}/${twins}/${peek}/${empty}/${retained}/${fixedFrame}/${extraWidth}/${extraHeight}`;
      if (size === previous) return;
      previous = size;
      requestDesktopLayout(bridge, {
        mode: "island",
        width,
        height,
        ...(island ? { dock, expanded } : {}),
        ...(island?.dataset.appearance === "jade"
          ? { appearance: twins ? "jade-twins" : "jade" }
          : {}),
        ...(twins ? { peek, empty } : {}),
        ...(twins && Number.isFinite(extraWidth) && Number.isFinite(extraHeight)
          ? { size: { extraWidth, extraHeight } }
          : {}),
        ...(retained ? { retained: true } : {}),
        ...(fixedFrame ? { fixedFrame: true } : {}),
      });
    });
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(target);
  const attributes = new window.MutationObserver(measure);
  if (island)
    attributes.observe(island, {
      attributes: true,
      attributeFilter: [
        "data-layout",
        "data-retained",
        "data-fixed-frame",
        "data-open",
        "data-peek",
        "data-empty",
        "data-extra-width",
        "data-extra-height",
        "data-deadline-editor",
      ],
    });
  window.addEventListener("resize", measure);
  return () => {
    observer.disconnect();
    attributes.disconnect();
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", measure);
  };
}
