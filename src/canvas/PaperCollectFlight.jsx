import React, { useEffect } from "react";
import { Snapshot } from "./CollectionFlight.jsx";

// Collection is committed before this runs. Undo, collaboration or unmounting
// can remove the visual copy without delaying or replaying a data change.
export default function PaperCollectFlight({
  flight,
  assetUrls,
  objects,
  onDone,
}) {
  const { token, object, target, snapshot, visibleIds, wrapScale = 1 } = flight;
  const { width, height } = object;
  const size = Math.min(44 / wrapScale, width * 0.8, height * 0.8);
  const x = object.x + width / 2;
  const y = object.y + height / 2;
  const dx = target.x + target.width / 2 - x;
  const dy = target.y + target.height / 2 - y;
  const arc = Math.min(110 / wrapScale, Math.hypot(dx, dy) * 0.16);
  useEffect(() => {
    const timer = setTimeout(() => onDone(token), 1200);
    return () => clearTimeout(timer);
  }, [token, onDone]);
  return (
    <div
      className={`paper-collection-flight paper-color-${object.color || "paper"}`}
      aria-hidden="true"
      inert
      style={{
        left: x,
        top: y,
        "--paper-size": `${size}px`,
        "--paper-scale-x": size / width,
        "--paper-scale-y": size / height,
        "--paper-mid-x": `${dx * 0.48}px`,
        "--paper-mid-y": `${dy * 0.48 - arc}px`,
        "--paper-end-x": `${dx}px`,
        "--paper-end-y": `${dy}px`,
      }}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onDone(token);
      }}
    >
      <div
        className={`paper-crumple-sheet object-${object.type}`}
        style={{ left: -width / 2, top: -height / 2, width, height }}
      >
        <Snapshot
          object={object}
          snapshot={snapshot}
          visibleIds={visibleIds}
          objects={objects}
          assetUrls={assetUrls}
        />
      </div>
      <svg className="paper-crumple-ball" viewBox="0 0 64 64" fill="none">
        <path
          d="M22 3 38 5 49 10 54 21 61 31 56 46 45 56 29 61 16 55 7 46 3 31 9 16Z"
          fill="currentColor"
          stroke="#665d4d"
          strokeOpacity=".22"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path
          d="m22 3 6 22-19-9ZM38 5l-10 20 21-15ZM3 31l25-6L7 46ZM28 25l17 31 11-10Z"
          fill="#fff"
          fillOpacity=".7"
        />
        <path
          d="m28 25 10-20 1 30ZM28 25 7 46l18-7ZM25 39l4 22 16-5ZM39 35l22-4-7-10Z"
          fill="#80715a"
          fillOpacity=".2"
        />
        <path
          d="m22 3 6 22-19-9m-6 15 25-6L38 5m-10 20 11 10 15-14M7 46l18-7 4 22m-4-22 3-14 17 31m-6-21 17 11"
          stroke="#786b55"
          strokeOpacity=".3"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="m12 22 9 7-6 8m26-23 4 9-6 5m-8 15 7 7"
          stroke="#fff"
          strokeOpacity=".8"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
