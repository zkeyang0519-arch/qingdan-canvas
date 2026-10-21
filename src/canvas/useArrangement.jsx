import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { arrangeObjects } from "./arrangement.js";

export default function useArrangement({
  enabled,
  objects,
  dimensions,
  viewport,
  boardId,
  onView,
  view,
}) {
  const measurements = useRef(new Map()),
    births = useRef(new Map()),
    nodes = useRef(new Map());
  const animations = useRef(new Map());
  const restoration = useRef(null);
  const frozen = useRef(null),
    previous = useRef(null);
  const [, rerender] = useState(0);
  const [scroll, setScroll] = useState(0);
  const layout = enabled
    ? frozen.current?.boardId === boardId
      ? frozen.current.layout
      : arrangeObjects(objects, dimensions.width, measurements.current)
    : null;
  const current = useRef({});
  current.current = { layout, view, onView, enabled };
  const measure = useCallback((id, height) => {
    const rect = current.current.layout?.rects.get(id);
    if (!rect || height <= 0) return;
    const before = measurements.current.get(id);
    if (
      before &&
      Math.abs(before.height - height) < 0.5 &&
      Math.abs(before.width - rect.width) < 0.5
    )
      return;
    measurements.current.set(id, { width: rect.width, height });
    rerender((n) => n + 1);
  }, []);
  const queueBirth = (id, point, options = {}) => {
    if (enabled)
      births.current.set(id, {
        x: point.x,
        y: point.y - (viewport.current?.scrollTop || 0),
        scale: options.scale ?? ".22",
        duration: options.duration ?? 560,
        rootId: options.rootId,
        reveal: options.reveal ?? true,
      });
  };
  const saveScroll = () => {
    const top = viewport.current?.scrollTop || 0;
    setScroll(top);
    if (restoration.current !== null) return;
    if (current.current.enabled && current.current.view.arrangedScroll !== top)
      current.current.onView({ ...current.current.view, arrangedScroll: top });
  };
  useLayoutEffect(() => {
    const el = viewport.current;
    restoration.current = enabled ? view.arrangedScroll || 0 : null;
    el.scrollTop = restoration.current || 0;
    setScroll(el.scrollTop);
    births.current.clear();
    frozen.current = null;
    previous.current = null;
    animations.current.forEach((animation) => animation.cancel());
    animations.current.clear();
  }, [enabled, boardId]);
  useLayoutEffect(() => {
    if (
      enabled &&
      view.arrangedScroll !== undefined &&
      Math.abs(view.arrangedScroll - viewport.current.scrollTop) > 1
    ) {
      restoration.current = view.arrangedScroll;
    }
  }, [view.arrangedScroll]);
  useLayoutEffect(() => {
    if (!enabled || restoration.current === null) return;
    // ResizeObserver may replace an estimated note height on the next frame.
    // Keep trying the requested location until it fits or the user navigates.
    viewport.current.scrollTop = restoration.current;
    setScroll(viewport.current.scrollTop);
    if (Math.abs(viewport.current.scrollTop - restoration.current) < 1)
      restoration.current = null;
  });
  useLayoutEffect(() => {
    if (!enabled || !layout) return;
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    // One scroll decision per batch, before computing any animation origins.
    const reveal = [...births.current].find(
      ([id, origin]) =>
        origin.reveal && layout.rects.has(id) && nodes.current.has(id),
    );
    if (reveal) {
      restoration.current = null;
      const rect = layout.rects.get(reveal[0]);
      const top = rect.y - viewport.current.scrollTop;
      if (
        top < 20 ||
        top + Math.min(rect.height, 220) > dimensions.height - 24
      ) {
        viewport.current.scrollTop = Math.max(0, rect.y - 100);
        saveScroll();
      }
    }
    const before = previous.current;
    previous.current = { layout, scroll: viewport.current.scrollTop };
    if (before && !frozen.current && !reduced) {
      for (const [id, rect] of layout.rects) {
        const old = before.layout.rects.get(id),
          el = nodes.current.get(id);
        if (
          !old ||
          !el?.animate ||
          births.current.has(id) ||
          (Math.abs(old.x - rect.x) < 0.5 && Math.abs(old.y - rect.y) < 0.5)
        )
          continue;
        animations.current.get(id)?.cancel();
        const animation = el.animate(
          [
            {
              transform: `translate(${old.x - rect.x}px,${old.y - rect.y + viewport.current.scrollTop - before.scroll}px)`,
            },
            { transform: "translate(0,0)" },
          ],
          { duration: 260, easing: "cubic-bezier(.2,.75,.2,1)" },
        );
        animations.current.set(id, animation);
        const finish = () => {
          if (animations.current.get(id) === animation)
            animations.current.delete(id);
        };
        animation.onfinish = finish;
        animation.oncancel = finish;
      }
    }
    for (const [id, origin] of births.current) {
      const el = nodes.current.get(id),
        rect = layout.rects.get(id);
      if (!el || !rect) {
        births.current.delete(id);
        continue;
      }
      restoration.current = null;
      const root = layout.rects.get(origin.rootId) || rect;
      const startX = origin.x + (rect.x - root.x) * Number(origin.scale);
      const startY = origin.y + (rect.y - root.y) * Number(origin.scale);
      if (el.animate && !reduced) {
        animations.current.get(id)?.cancel();
        const animation = el.animate(
          [
            {
              transformOrigin: "0 0",
              transform: `translate(${startX - rect.x}px,${startY + viewport.current.scrollTop - rect.y}px) scale(${origin.scale})`,
              opacity: 0.35,
            },
            {
              transformOrigin: "0 0",
              transform: "translate(0,0) scale(1)",
              opacity: 1,
            },
          ],
          { duration: origin.duration, easing: "cubic-bezier(.2,.75,.2,1)" },
        );
        animations.current.set(id, animation);
        el.classList.add("arranged-entering");
        const finish = () => {
          el.classList.remove("arranged-entering");
          animations.current.delete(id);
        };
        animation.onfinish = finish;
        animation.oncancel = finish;
      }
      births.current.delete(id);
    }
  });
  useLayoutEffect(
    () => () => animations.current.forEach((animation) => animation.cancel()),
    [],
  );
  return {
    layout,
    measure,
    scroll,
    saveScroll,
    queueBirth,
    freeze: () => {
      if (!enabled) return;
      frozen.current = { boardId, layout };
      animations.current.forEach((animation) => animation.cancel());
      animations.current.clear();
    },
    release: () => {
      if (!frozen.current) return;
      frozen.current = null;
      rerender((n) => n + 1);
    },
    interruptRestore: () => {
      restoration.current = null;
    },
    register: (id, element) => {
      if (element) nodes.current.set(id, element);
      else nodes.current.delete(id);
    },
    screenRect: (id) => {
      const rect = layout?.rects.get(id);
      return (
        rect && { ...rect, y: rect.y - (viewport.current?.scrollTop || 0) }
      );
    },
    scrollTo: (id) => {
      const rect = layout?.rects.get(id);
      if (rect) {
        restoration.current = null;
        viewport.current.scrollTop = Math.max(0, rect.y - 100);
        saveScroll();
      }
    },
  };
}
