import React, { useEffect, useState } from "react";
import { collectionEnvelope } from "./collectionWrap.js";
export default function CollectionWrap({
  rects,
  target,
  scale = 1,
  collecting = false,
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 16);
    return () => clearTimeout(timer);
  }, []);
  const envelope = collectionEnvelope(rects, target, scale);
  const box = collecting
    ? ready
      ? target
      : envelope
    : ready
      ? envelope
      : target;
  return (
    <div
      className={`collection-wrap ${collecting ? "is-collecting" : ""}`}
      aria-hidden="true"
      style={{
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        borderWidth: 1.5 / scale,
        borderRadius: 10 / scale,
        "--wrap-inset": `${6 / scale}px`,
      }}
    >
      <i />
    </div>
  );
}
