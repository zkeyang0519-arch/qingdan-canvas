import { useLayoutEffect, useRef, useState } from "react";
import { descendantIds, hiddenByAncestor, displayRect } from "./layout.js";
export function returnKeyframes(rect, root, origin) {
  const scale = 0.06;
  return [
    {
      transformOrigin: "0 0",
      transform: `translate(${origin.x + origin.width / 2 + (rect.x - root.x - root.width / 2) * scale - rect.x}px,${origin.y + origin.height / 2 + (rect.y - root.y - root.height / 2) * scale - rect.y}px) scale(${scale})`,
      opacity: 0.25,
    },
    {
      transformOrigin: "0 0",
      transform: "translate(0,0) scale(1)",
      opacity: 1,
    },
  ];
}
export default function useCanvasReturn({
  objects,
  boardId,
  enabled,
  viewport,
}) {
  const pending = useRef(new Map()),
    animations = useRef(new Set()),
    timers = useRef(new Set());
  const [returningIds, setReturningIds] = useState(new Set());
  useLayoutEffect(() => {
    pending.current.clear();
    animations.current.forEach((a) => a.cancel());
    animations.current.clear();
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    setReturningIds(new Set());
    return () => {
      animations.current.forEach((a) => a.cancel());
      timers.current.forEach(clearTimeout);
    };
  }, [boardId, enabled]);
  useLayoutEffect(() => {
    if (!enabled) return;
    for (const [key, origin] of pending.current) {
      const root = objects.find((o) => o.id === key);
      if (!root) {
        pending.current.delete(key);
        continue;
      }
      const ids = descendantIds(objects, [key]);
      const active = [];
      for (const o of objects) {
        if (!ids.has(o.id) || hiddenByAncestor(objects, o.id)) continue;
        const el = [
          ...viewport.current.querySelectorAll("[data-object-id]"),
        ].find((n) => n.dataset.objectId === o.id);
        if (
          !el?.animate ||
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        )
          continue;
        const a = el.animate(
          returnKeyframes(displayRect(o), displayRect(root), origin),
          { duration: 420, easing: "cubic-bezier(.2,.75,.2,1)" },
        );
        animations.current.add(a);
        active.push(a);
        a.onfinish = () => animations.current.delete(a);
      }
      const timer = setTimeout(
        () => {
          timers.current.delete(timer);
          active.forEach((a) => {
            a.cancel();
            animations.current.delete(a);
          });
          setReturningIds(
            (current) => new Set([...current].filter((id) => !ids.has(id))),
          );
        },
        active.length ? 430 : 0,
      );
      timers.current.add(timer);
      pending.current.delete(key);
    }
  });
  return {
    returningIds,
    animateTakeOut: (key, origin) => {
      pending.current.set(key, origin);
      const ids = descendantIds(objects, [key]);
      setReturningIds((current) => new Set([...current, ...ids]));
    },
  };
}
