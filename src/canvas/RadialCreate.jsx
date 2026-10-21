import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { StickyNote, ListChecks, ImagePlus, Plus } from "lucide-react";

const HOLD_MS = 800;
const RADIUS = 64;
export function useRadialCreate({ enabled, scope, viewport }) {
  const [menu, setMenu] = useState(null);
  const pending = useRef(null),
    timer = useRef(null);
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    const current = pending.current;
    pending.current = null;
    if (current && viewport.current?.hasPointerCapture(current.pointerId))
      viewport.current.releasePointerCapture(current.pointerId);
    setMenu(null);
  }, [viewport]);
  useEffect(() => {
    cancel();
    return () => clearTimeout(timer.current);
  }, [enabled, scope, cancel]);
  useEffect(() => {
    const outside = (event) => {
      if (!event.target.closest(".radial-create")) cancel();
    };
    const key = (event) => {
      if (event.key === "Escape") cancel();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
    };
  }, [cancel]);
  const start = (event, origin) => {
    if (!enabled || event.button !== 0 || event.pointerType === "touch") return;
    cancel();
    event.preventDefault();
    const value = {
      x: event.clientX,
      y: event.clientY,
      origin,
      pointerId: event.pointerId,
      ready: false,
    };
    pending.current = value;
    setMenu(value);
    viewport.current.setPointerCapture(event.pointerId);
    timer.current = setTimeout(() => {
      if (pending.current !== value) return;
      value.ready = true;
      const box = viewport.current.getBoundingClientRect();
      const edge = RADIUS + 34;
      // Keep the full orbit reachable at edges, retaining the original creation point.
      setMenu({
        ...value,
        x: Math.max(
          box.left + edge,
          Math.min(value.x, (box.right || innerWidth) - edge),
        ),
        y: Math.max(
          box.top + edge,
          Math.min(value.y, (box.bottom || innerHeight) - edge),
        ),
      });
    }, HOLD_MS);
  };
  const move = (event) => {
    const p = pending.current;
    if (
      p &&
      !p.ready &&
      event.pointerId === p.pointerId &&
      Math.hypot(event.clientX - p.x, event.clientY - p.y) > 8
    )
      cancel();
  };
  const up = (event) => {
    const p = pending.current;
    if (!p || event.pointerId !== p.pointerId) return;
    if (!p.ready) cancel();
    else {
      pending.current = null;
      if (viewport.current?.hasPointerCapture(event.pointerId))
        viewport.current.releasePointerCapture(event.pointerId);
    }
  };
  return { menu, start, move, up, cancel };
}

export default function RadialCreate({ menu, onChoose, onCancel }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (menu?.ready)
      ref.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [menu?.ready]);
  if (!menu) return null;
  return (
    <div
      ref={ref}
      className={`radial-create ${menu.ready ? "is-ready" : "is-holding"}`}
      style={{
        left: menu.x,
        top: menu.y,
        "--hold-time": `${HOLD_MS}ms`,
        "--orbit-radius": `${RADIUS}px`,
      }}
      role={menu.ready ? "menu" : "status"}
      aria-label={menu.ready ? "新建元素" : "继续按住以新建"}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(event) => {
        const buttons = [...ref.current.querySelectorAll("button")];
        if (
          ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          const step = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
          buttons[
            (buttons.indexOf(document.activeElement) + step + buttons.length) %
              buttons.length
          ]?.focus({ preventScroll: true });
        }
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="radial-orbit" aria-hidden="true">
        <i className="radial-fill" />
        {menu.ready && <Plus size={18} />}
      </div>
      {menu.ready &&
        [
          ["text", "便签", StickyNote, 0, -RADIUS],
          [
            "checklist",
            "清单",
            ListChecks,
            (RADIUS * Math.sqrt(3)) / 2,
            RADIUS / 2,
          ],
          [
            "image",
            "图片",
            ImagePlus,
            (-RADIUS * Math.sqrt(3)) / 2,
            RADIUS / 2,
          ],
        ].map(([kind, label, Icon, x, y]) => (
          <button
            type="button"
            role="menuitem"
            key={kind}
            style={{ left: x, top: y }}
            onClick={(e) => {
              e.stopPropagation();
              onChoose(kind, menu.origin);
            }}
          >
            <Icon size={20} strokeWidth={1.5} />
            <span>{label}</span>
          </button>
        ))}
    </div>
  );
}
