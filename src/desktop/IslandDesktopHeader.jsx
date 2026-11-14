import React from "react";
import {
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
} from "lucide-react";

export function IslandDesktopHeader({
  title,
  summary,
  completed,
  total,
  expanded,
  toggle,
  panelId,
  trigger,
}) {
  return (
    <header
      className="island-desktop-header"
      data-desktop-drag="true"
      title={title}
    >
      <GripVertical
        size={14}
        className="island-desktop-grip"
        aria-hidden="true"
      />
      <span className="island-logo" aria-hidden="true">
        <CheckCheck size={17} />
      </span>
      <span className="island-summary" title={summary}>
        <span>轻岛</span>
        {summary}
      </span>
      <span className="island-progress" aria-label="待办进度">
        {completed} / {total}
      </span>
      <button
        ref={trigger}
        type="button"
        className="island-desktop-toggle"
        aria-label={expanded ? "收起轻岛" : "展开轻岛"}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={toggle}
      >
        <ChevronDown size={15} className="island-chevron" aria-hidden="true" />
      </button>
    </header>
  );
}

export function IslandSideTab({ dock, expanded, remaining, toggle, panelId }) {
  const Arrow = dock === "left" ? ChevronRight : ChevronLeft;
  return (
    <aside
      className="island-side-tab"
      data-desktop-drag="true"
      title="拖动侧签移位"
      aria-label={dock === "left" ? "左侧待办签" : "右侧待办签"}
      onClick={(event) => {
        if (!event.target.closest("button")) toggle();
      }}
    >
      <GripVertical size={14} className="island-side-grip" aria-hidden="true" />
      <CheckCheck size={18} aria-hidden="true" />
      <span className="island-side-word">轻岛</span>
      <span
        className="island-side-count"
        aria-label={`还有 ${remaining} 项待办`}
      >
        {remaining}
      </span>
      <button
        type="button"
        className="island-side-toggle"
        aria-label={expanded ? "收起侧边待办" : "展开侧边待办"}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={toggle}
      >
        <Arrow size={14} />
      </button>
    </aside>
  );
}
