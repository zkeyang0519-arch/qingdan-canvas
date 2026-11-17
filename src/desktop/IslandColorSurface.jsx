import React, { useLayoutEffect, useRef } from "react";
import { createIslandColorField } from "./island-color-field.js";

export default function IslandColorSurface({
  design,
  profile,
  playing,
  small = false,
}) {
  const canvas = useRef(null),
    phase = useRef(0);
  const colors = profile.colors.join();
  useLayoutEffect(() => {
    // A static CSS palette remains available if Canvas is unavailable.
    if (typeof window.CanvasRenderingContext2D !== "function") return;
    const node = canvas.current,
      parent = node.parentElement;
    const context = node.getContext("2d", { alpha: false });
    if (!context) return;
    const buffer = document.createElement("canvas"),
      brush = buffer.getContext("2d", { alpha: false });
    if (!brush) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame = null,
      last = null,
      field,
      pixels,
      inView = true;
    const running = () =>
      !!field &&
      playing &&
      profile.motion &&
      !small &&
      inView &&
      !document.hidden &&
      !reduced?.matches;
    const draw = () => {
      if (!field) return;
      field.render(phase.current, pixels.data);
      brush.putImageData(pixels, 0, 0);
      context.drawImage(buffer, 0, 0, node.width, node.height);
      node.dataset.ready = "true";
    };
    const tick = (now) => {
      frame = null;
      if (!running()) return;
      if (last === null) last = now;
      if (now - last >= 1000 / 30) {
        phase.current +=
          (Math.min(0.15, (now - last) / 1000) * Math.PI * 2) / profile.cycle;
        last = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      last = null;
      if (running()) frame = requestAnimationFrame(tick);
    };
    const resize = () => {
      const width = parent.clientWidth,
        height = parent.clientHeight;
      if (!width || !height) {
        field = null;
        schedule();
        return;
      }
      const radius =
        parseFloat(window.getComputedStyle(parent).borderTopLeftRadius) ||
        Math.min(width, height) / 2;
      field = createIslandColorField({
        width,
        height,
        radius,
        design,
        profile,
        small,
      });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      node.width = Math.round(width * dpr);
      node.height = Math.round(height * dpr);
      buffer.width = field.width;
      buffer.height = field.height;
      pixels = brush.createImageData(field.width, field.height);
      draw();
      schedule();
    };
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(parent);
    const intersection =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            inView = entry.isIntersecting;
            schedule();
          })
        : null;
    intersection?.observe(parent);
    document.addEventListener("visibilitychange", schedule);
    reduced?.addEventListener?.("change", schedule);
    window.addEventListener("resize", resize);
    resize();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      intersection?.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      reduced?.removeEventListener?.("change", schedule);
      window.removeEventListener("resize", resize);
    };
  }, [
    design,
    colors,
    profile.smallColor,
    profile.glassStrength,
    profile.motion,
    profile.cycle,
    playing,
    small,
  ]);
  return (
    <>
      <canvas
        className="island-color-surface"
        ref={canvas}
        aria-hidden="true"
      />
      {design === "glass" && (
        <span className="island-color-sheen" aria-hidden="true" />
      )}
    </>
  );
}
