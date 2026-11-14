import { useEffect, useRef, useState } from "react";

const initial = { dock: "top", dragging: false, railOffset: 12 };

export function useDesktopPlacement(bridge) {
  const [placement, setPlacement] = useState(initial);
  const gesture = useRef(null),
    suppressed = useRef(false),
    clearClick = useRef(null);
  const mounted = useRef(true);
  // A single queue spans gestures: a delayed release must finish before the
  // following start. Keep at most one pending move; release reads the cursor.
  const queue = useRef(Promise.resolve());
  const accept = (value) => {
    if (
      !mounted.current ||
      !["top", "left", "right", "free"].includes(value?.dock)
    )
      return;
    setPlacement((previous) => ({
      ...previous,
      ...value,
      dragging: !!value.dragging || !!gesture.current?.moving,
    }));
    for (const [key, name] of [
      ["maxHeight", "height"],
      ["maxWidth", "width"],
    ]) {
      if (Number.isFinite(value[key]))
        document.documentElement.style.setProperty(
          `--desktop-max-${name}`,
          `${Math.max(128, value[key])}px`,
        );
    }
  };
  const send = (record, action) => {
    if (action === "move" && record.movePending) return;
    if (action === "move") record.movePending = true;
    queue.current = queue.current
      .then(() =>
        action === "move" && record.finished
          ? undefined
          : bridge.drag(action, action === "start" ? record.origin : undefined),
      )
      .then(accept)
      .catch(() => {
        if (mounted.current)
          setPlacement((previous) => ({ ...previous, dragging: false }));
      })
      .finally(() => {
        if (action === "move") record.movePending = false;
      });
  };
  const finish = (event, cancel = false) => {
    const record = gesture.current;
    if (
      !record ||
      (event?.pointerId !== undefined && event.pointerId !== record.id)
    )
      return;
    gesture.current = null;
    record.finished = true;
    if (record.element.hasPointerCapture?.(record.id))
      record.element.releasePointerCapture(record.id);
    if (record.moving) send(record, cancel ? "cancel" : "end");
    clearClick.current = setTimeout(() => {
      suppressed.current = false;
    }, 0);
  };
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = bridge?.onPlacement?.(accept);
    Promise.resolve(bridge?.getPlacement?.())
      .then(accept)
      .catch(() => {});
    const blur = () => finish(null);
    window.addEventListener("blur", blur);
    const release = (event) => finish(event);
    window.addEventListener("pointerup", release);
    return () => {
      finish(null, true);
      mounted.current = false;
      clearTimeout(clearClick.current);
      unsubscribe?.();
      window.removeEventListener("blur", blur);
      window.removeEventListener("pointerup", release);
    };
  }, [bridge]);

  const handlers = {
    onPointerDown(event) {
      if (!bridge?.drag || event.button !== 0 || gesture.current?.moving)
        return;
      const handle = event.target.closest?.('[data-desktop-drag="true"]');
      const control = event.target.closest?.("button,input,textarea,select,a");
      if (!handle || (control && control !== handle)) return;
      gesture.current = {
        id: event.pointerId,
        x: event.screenX,
        y: event.screenY,
        origin: {
          x: event.clientX,
          y: handle.classList.contains("island-side-tab") ? 38 : event.clientY,
        },
        element: event.currentTarget,
        root: event.currentTarget,
        moving: false,
      };
    },
    onPointerMove(event) {
      const record = gesture.current;
      if (!record || record.id !== event.pointerId) return;
      if (!record.moving) {
        if (Math.hypot(event.screenX - record.x, event.screenY - record.y) < 5)
          return;
        record.moving = true;
        record.element = record.root;
        record.root.setPointerCapture?.(event.pointerId);
        suppressed.current = true;
        setPlacement((previous) => ({ ...previous, dragging: true }));
        send(record, "start");
      } else send(record, "move");
      event.preventDefault();
    },
    onPointerUp: (event) => finish(event),
    onPointerCancel: (event) => finish(event, true),
    // Native window movement can release Chromium's pointer capture. Commit
    // the current placement instead of undoing a move the user can already see.
    onLostPointerCapture: (event) => {
      if (event.target === gesture.current?.element) finish(event);
    },
    onClickCapture(event) {
      if (suppressed.current) {
        event.preventDefault();
        event.stopPropagation();
        suppressed.current = false;
      }
    },
  };
  return { ...placement, handlers };
}
