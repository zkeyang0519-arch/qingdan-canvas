import React, { useState, useRef, useEffect } from "react";
import { Map, ChevronDown } from "lucide-react";
import { objectLabel } from "./model.js";
import {
  minimapTransform,
  mapPoint,
  unmapPoint,
  centerView,
} from "./minimap.js";
const colors = {
  paper: "#fff",
  sage: "#edf2e7",
  sand: "#faf2df",
  rose: "#f8ece8",
  blue: "#eaf0f7",
  lavender: "#f0ecf6",
};
export default function Minimap({
  objects,
  view,
  size,
  onView,
  assetUrls,
  onLocate,
  disabled,
}) {
  const [collapsed, setCollapsed] = useState(true),
    [held, setHeld] = useState(null),
    [flash, setFlash] = useState(null);
  const drag = useRef(null),
    animation = useRef(null),
    timer = useRef(null),
    latest = useRef(view);
  latest.current = view;
  const transform = held || minimapTransform(objects, view, size);
  useEffect(
    () => () => {
      globalThis.cancelAnimationFrame?.(animation.current);
      clearTimeout(timer.current);
    },
    [],
  );
  const stop = (e) => e.stopPropagation();
  const point = (e, t) => {
    const r = e.currentTarget.getBoundingClientRect();
    return unmapPoint(
      {
        x: ((e.clientX - r.left) * 220) / r.width,
        y: ((e.clientY - r.top) * 150) / r.height,
      },
      t,
    );
  };
  function navigate(p, smooth = false) {
    globalThis.cancelAnimationFrame?.(animation.current);
    const start = latest.current,
      end = centerView(p, start, size);
    if (!smooth || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onView(end);
      return;
    }
    const since = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - since) / 180),
        k = 1 - (1 - t) ** 3;
      onView({
        ...end,
        x: start.x + (end.x - start.x) * k,
        y: start.y + (end.y - start.y) * k,
      });
      if (t < 1) animation.current = requestAnimationFrame(tick);
    };
    animation.current = requestAnimationFrame(tick);
  }
  function down(e) {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    globalThis.cancelAnimationFrame?.(animation.current);
    const p = point(e, transform);
    drag.current = {
      t: transform,
      p,
      start: { x: e.clientX, y: e.clientY },
      moved: false,
      view: latest.current,
      viewport: e.target.dataset.viewport === "true",
      id: e.target.closest("[data-map-id]")?.dataset.mapId,
    };
    setHeld(transform);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e) {
    const g = drag.current;
    if (!g) return;
    if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > 3)
      g.moved = true;
    if (!g.moved) return;
    const p = point(e, g.t);
    if (g.viewport)
      onView({
        ...g.view,
        x: g.view.x - (p.x - g.p.x) * g.view.scale,
        y: g.view.y - (p.y - g.p.y) * g.view.scale,
      });
    else navigate(p);
  }
  function up(e) {
    const g = drag.current;
    if (!g) return;
    drag.current = null;
    setHeld(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (!g.moved) {
      const o = objects.find((o) => o.id === g.id);
      navigate(
        o ? { x: o.x + o.width / 2, y: o.y + o.height / 2 } : point(e, g.t),
        true,
      );
      if (o) {
        onLocate(o.id);
        setFlash(o.id);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setFlash(null), 1200);
      }
    }
  }
  const vp = mapPoint(
    { x: -view.x / view.scale, y: -view.y / view.scale },
    transform,
  );
  return (
    <aside
      className={`canvas-minimap ${collapsed ? "is-collapsed" : ""}`}
      aria-label="画布导航图"
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={(e) => {
        e.preventDefault();
        stop(e);
      }}
      onKeyDown={stop}
    >
      <button
        className="minimap-toggle"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? "展开画布导航图" : "收起画布导航图"}
        aria-expanded={!collapsed}
      >
        <Map size={15} />
        {!collapsed && (
          <>
            <span>画布导航</span>
            <ChevronDown size={14} />
          </>
        )}
      </button>
      {!collapsed && (
        <svg
          viewBox="0 0 220 150"
          role="img"
          aria-label="全画布缩略图，点击定位，拖动浏览"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => {
            drag.current = null;
            setHeld(null);
          }}
        >
          {[...objects]
            .sort(
              (a, b) =>
                (a.type === "frame" ? -1 : 0) - (b.type === "frame" ? -1 : 0) ||
                b.width * b.height - a.width * a.height,
            )
            .map((o) => {
              const p = mapPoint(o, transform),
                w = Math.max(2, o.width * transform.scale),
                h = Math.max(2, o.height * transform.scale);
              return (
                <g
                  key={o.id}
                  data-map-id={o.id}
                  className={flash === o.id ? "map-highlight" : ""}
                >
                  <title>{objectLabel(o)}</title>
                  <rect
                    x={p.x}
                    y={p.y}
                    width={w}
                    height={h}
                    rx="1"
                    fill={
                      o.type === "frame"
                        ? "#EAE5DC"
                        : colors[o.color] || "#E6D0B5"
                    }
                    stroke="#a9a99e"
                    strokeWidth=".6"
                  />
                  {o.type === "image" && assetUrls.get(o.assetId) && (
                    <image
                      href={assetUrls.get(o.assetId)}
                      x={p.x}
                      y={p.y}
                      width={w}
                      height={h}
                      preserveAspectRatio="xMidYMid meet"
                    />
                  )}
                </g>
              );
            })}
          <rect
            className="minimap-viewport"
            x={vp.x}
            y={vp.y}
            width={(size.width / view.scale) * transform.scale}
            height={(size.height / view.scale) * transform.scale}
            data-viewport="true"
          />
        </svg>
      )}
    </aside>
  );
}
