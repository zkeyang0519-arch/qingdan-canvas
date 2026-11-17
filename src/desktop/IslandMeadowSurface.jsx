import React, { useLayoutEffect, useRef } from "react";
import { createIslandMeadowSurface } from "./island-meadow.js";

export default function IslandMeadowSurface({ playing, speed, side, reverse }) {
  const node = useRef(null),
    controller = useRef(null);
  const phase = useRef({ time: 0, scroll: 0 });
  useLayoutEffect(() => {
    if (
      typeof window.CanvasRenderingContext2D !== "function" ||
      typeof node.current.animate !== "function"
    )
      return;
    controller.current = createIslandMeadowSurface(node.current, phase.current);
    return () => {
      controller.current.destroy();
      controller.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    controller.current?.update({ playing, speed, side, reverse });
  }, [playing, speed, side, reverse]);
  return (
    <>
      <div
        className="island-meadow-surface"
        ref={node}
        data-side={side}
        data-reverse={reverse}
        aria-hidden="true"
      />
      <span className="island-meadow-readability" aria-hidden="true" />
    </>
  );
}
