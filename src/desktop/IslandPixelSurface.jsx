import React, { useLayoutEffect, useRef } from "react";
import { pixelTile, planeNames } from "./island-pixel-garden.js";
import { createPixelScene } from "./island-pixel-motion.js";
import "./island-pixel.css";

export function IslandPixelSwatch() {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (typeof window.CanvasRenderingContext2D !== "function") return;
    const ctx = ref.current.getContext("2d");
    if (!ctx) return;
    for (const layer of planeNames) ctx.drawImage(pixelTile(0, layer), -54, 0);
  }, []);
  return (
    <canvas
      className="island-design-swatch island-pixel-swatch"
      ref={ref}
      width={128}
      height={32}
      aria-hidden="true"
    />
  );
}

export default function IslandPixelSurface({ playing, speed, side, reverse }) {
  const node = useRef(null);
  const scene = useRef(null);
  useLayoutEffect(() => {
    if (
      typeof window.CanvasRenderingContext2D !== "function" ||
      !node.current.animate
    )
      return;
    scene.current = createPixelScene(node.current);
    return () => scene.current.destroy();
  }, []);
  useLayoutEffect(() => {
    scene.current?.update(playing, speed, reverse);
  }, [playing, speed, reverse]);
  return (
    <>
      <div
        ref={node}
        className="island-pixel-surface"
        data-side={side}
        aria-hidden="true"
      />
      <span className="island-meadow-readability" aria-hidden="true" />
    </>
  );
}
