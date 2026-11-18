import React, { useEffect, useRef } from "react";
import { MoveDiagonal2 } from "lucide-react";
import limits from "../../shared/island-size.json" with { type: "json" };
import { defaultIslandSize } from "./island-appearance.js";

const clamp = (value, max) => Math.max(0, Math.min(max, Math.round(value)));
export function islandSizeBounds(desktop, side, empty) {
  const width = side ? limits.side.width : limits.top.width;
  const height = side
    ? empty
      ? limits.side.emptyHeight
      : limits.side.height
    : limits.top.height;
  return {
    width,
    height,
    maxWidth: Math.max(
      0,
      Math.min(
        limits.maxExtraWidth,
        Math.floor(desktop.maxWidth ?? 1920) - width - (side ? 24 : 107),
      ),
    ),
    maxHeight: Math.max(
      0,
      Math.min(
        limits.maxExtraHeight,
        Math.floor(desktop.maxHeight ?? 900) - height - (side ? 75 : 24),
      ),
    ),
  };
}
export function fitIslandSize(size, bounds) {
  return {
    extraWidth: clamp(size.extraWidth, bounds.maxWidth),
    extraHeight: clamp(size.extraHeight, bounds.maxHeight),
  };
}

export function IslandResizeHandle({
  size,
  bounds,
  left,
  up,
  onPreview,
  onCommit,
  onSettings,
}) {
  const gesture = useRef(null),
    ignoreClick = useRef(false),
    current = useRef(null);
  current.current = { onPreview, onCommit };
  const end = (cancel = false) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    if (g.element.hasPointerCapture?.(g.id))
      g.element.releasePointerCapture(g.id);
    if (g.moved) {
      ignoreClick.current = true;
      if (!cancel) current.current.onCommit(g.last);
      current.current.onPreview(null);
    }
  };
  useEffect(() => {
    const onBlur = () => end();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      end(true);
    };
  }, []);
  const move = (event) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.screenX - g.x,
      dy = event.screenY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 3) return;
    g.moved = true;
    g.last = fitIslandSize(
      {
        extraWidth: g.start.extraWidth + dx * (g.left ? -1 : 1),
        extraHeight: g.start.extraHeight + dy * (g.up ? -1 : 1),
      },
      bounds,
    );
    onPreview(g.last);
  };
  return (
    <button
      type="button"
      className="island-resize-handle"
      data-left={left}
      data-up={up}
      aria-label="调整大舱尺寸"
      title="拖动调整宽高，点击打开尺寸设置"
      onPointerDown={(event) => {
        if (event.button !== 0 || event.isPrimary === false || gesture.current)
          return;
        ignoreClick.current = false;
        gesture.current = {
          id: event.pointerId,
          element: event.currentTarget,
          start: size,
          last: size,
          x: event.screenX,
          y: event.screenY,
          left,
          up,
          moved: false,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        if (gesture.current?.id === event.pointerId) {
          move(event);
          end();
        }
      }}
      onPointerCancel={(event) => {
        if (gesture.current?.id === event.pointerId) end(true);
      }}
      onLostPointerCapture={(event) => {
        if (gesture.current?.id === event.pointerId) end();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && gesture.current) {
          event.preventDefault();
          event.stopPropagation();
          end(true);
        }
      }}
      onClick={(event) => {
        if (ignoreClick.current && event.detail !== 0) {
          ignoreClick.current = false;
          return;
        }
        onSettings();
      }}
    >
      <MoveDiagonal2 size={12} aria-hidden="true" />
    </button>
  );
}

export function IslandSizeSettings({ size, bounds, onChange, focusRef }) {
  return (
    <section
      className="island-size-settings island-palette-settings"
      aria-label="大舱尺寸"
    >
      <div className="island-appearance-title">
        <strong>大舱尺寸</strong>
        <button type="button" onClick={() => onChange(defaultIslandSize)}>
          恢复默认尺寸
        </button>
      </div>
      {[
        ["extraWidth", "宽度", bounds.width, bounds.maxWidth],
        ["extraHeight", "高度", bounds.height, bounds.maxHeight],
      ].map(([key, name, base, maximum]) => (
        <label className="island-size-field" key={key}>
          <span className="island-appearance-range-label">
            {name}
            <output>{base + size[key]} px</output>
          </span>
          <input
            ref={key === "extraWidth" ? focusRef : undefined}
            type="range"
            aria-label={"大舱" + name}
            min={base}
            max={base + maximum}
            step="1"
            value={base + size[key]}
            onChange={(event) =>
              onChange({ ...size, [key]: Number(event.target.value) - base })
            }
          />
        </label>
      ))}
    </section>
  );
}
