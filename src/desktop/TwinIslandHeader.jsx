import React, { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { blockText } from "../canvas/model.js";
import AnimalRunner from "../island/AnimalRunner.jsx";
import { twinTime } from "../island/twin-presentation.js";
import IslandColorSurface from "./IslandColorSurface.jsx";
import IslandMeadowSurface from "./IslandMeadowSurface.jsx";
import IslandPixelSurface from "./IslandPixelSurface.jsx";
import {
  activeIslandAppearance,
  defaultIslandAppearance,
  isSeasonalDesign,
} from "./island-appearance.js";

export default function TwinIslandHeader({
  task,
  remaining,
  animal,
  disabled,
  onComplete,
  toggle,
  onOpenWorkspace,
  onPointerEnter,
  onPointerLeave,
  panelId,
  trigger,
  side,
  wideSide,
  dock,
  peek,
  expanded,
  retained = false,
  project,
  appearance = defaultIslandAppearance,
  resizeHandle,
}) {
  const profile = activeIslandAppearance(appearance);
  const surfacePlaying = animal.playing && (!expanded || retained);
  const landscape = isSeasonalDesign(appearance.design);
  const Landscape =
    appearance.design === "pixel" ? IslandPixelSurface : IslandMeadowSurface;
  const [leaving, setLeaving] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const timer = useRef(null),
    busy = useRef(false),
    restoreFocus = useRef(false);
  const label = task ? blockText(task.block) || "未命名待办" : "暂无待办";
  const time = twinTime(task, remaining, now);
  const opensCanvas = expanded && retained && !!onOpenWorkspace;
  const smallAction = opensCanvas
    ? "打开画布"
    : expanded
      ? "收起待办列表"
      : "展开轻岛";
  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 30000);
    return () => {
      clearInterval(clock);
      clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (restoreFocus.current) {
      if (!task) trigger.current?.focus({ preventScroll: true });
      restoreFocus.current = false;
    }
  }, [task, trigger]);
  const complete = (event) => {
    if (!task || disabled || busy.current) return;
    // Commit through the existing latest-state/lock check immediately. Animation
    // holds only a text snapshot, never a delayed write to an old task or page.
    if (!onComplete(task, true)) return;
    restoreFocus.current = document.activeElement === event.currentTarget;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    busy.current = true;
    setLeaving(label);
    timer.current = setTimeout(() => {
      setLeaving(null);
      busy.current = false;
    }, 480);
  };
  return (
    <header
      className="island-twin-header"
      hidden={expanded && !retained}
      data-relay={!!leaving}
    >
      <div
        className="island-twin-main"
        data-desktop-drag="true"
        title="拖动轻岛"
      >
        {landscape ? (
          <Landscape
            playing={surfacePlaying && profile.motion}
            speed={profile.scrollSpeed}
            side={side}
            reverse={dock === "left"}
          />
        ) : (
          <IslandColorSurface
            design={appearance.design}
            profile={profile}
            playing={surfacePlaying}
          />
        )}
        {task && !side && (
          <button
            className="island-twin-complete"
            type="button"
            disabled={disabled || !!leaving}
            onClick={complete}
            aria-label={`完成待办：${label}`}
            title={`完成：${label}`}
          >
            <span className="island-twin-ring">
              <Check size={12} />
            </span>
          </button>
        )}
        <div
          className="island-twin-summary"
          aria-hidden={side && !peek && !wideSide}
          title={label}
        >
          <span className="island-twin-copy">
            {leaving && (
              <span className="island-twin-out" aria-hidden="true">
                {leaving}
              </span>
            )}
            <span
              className="island-twin-current"
              key={`${task?.note.id}/${task?.key}`}
            >
              {label}
            </span>
            <span className="island-twin-project">{project || "轻岛"}</span>
          </span>
        </div>
        <span className="island-twin-pet">
          <AnimalRunner {...animal} size={34} />
        </span>
        {resizeHandle}
      </div>
      <button
        className="island-twin-time"
        type="button"
        ref={trigger}
        onClick={(event) => {
          if (!opensCanvas) toggle();
          else if (event.detail <= 1) onOpenWorkspace();
        }}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        title={`${time.title} · ${smallAction}`}
        aria-label={smallAction}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        {!landscape && (
          <IslandColorSurface
            design={appearance.design}
            profile={profile}
            playing={false}
            small
          />
        )}
        {time.label && <span>{time.label}</span>}
        <strong>{time.value}</strong>
      </button>
    </header>
  );
}
