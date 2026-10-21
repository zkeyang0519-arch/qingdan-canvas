import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
} from "react";
import { Check, ChevronDown, FileText } from "lucide-react";
export function BoardPicker({ pages, page, onChoose, label }) {
  const listId = useId();
  const root = useRef(null),
    trigger = useRef(null),
    timer = useRef(null);
  const [phase, setPhase] = useState("closed");
  const close = (restoreFocus = true) => {
    if (phase === "closed") return;
    setPhase("closing");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPhase("closed"), 120);
    if (restoreFocus) trigger.current?.focus();
  };
  const open = () => {
    clearTimeout(timer.current);
    setPhase("open");
  };
  useLayoutEffect(() => {
    if (phase === "open")
      (
        root.current?.querySelector('[aria-selected="true"]') ||
        root.current?.querySelector('[role="option"]')
      )?.focus();
  }, [phase]);
  useEffect(() => {
    if (phase !== "open") return;
    const outside = (e) => {
      if (!root.current?.contains(e.target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [phase]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className={`checklist-board-picker ${phase}`} ref={root}>
      <button
        ref={trigger}
        className="checklist-board-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={phase === "open"}
        aria-controls={listId}
        disabled={!page && pages.length < 2}
        onClick={() => (phase === "open" ? close() : open())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            open();
          }
        }}
      >
        <FileText size={15} />
        <span>{page?.title || "选择灵感板"}</span>
        <ChevronDown size={13} />
      </button>
      {phase !== "closed" && (
        <div
          className={`checklist-board-options ${phase}`}
          id={listId}
          role="listbox"
          aria-label={label}
          inert={phase === "closing" ? true : undefined}
          onBlur={(e) => {
            if (!root.current.contains(e.relatedTarget)) close(false);
          }}
          onKeyDown={(e) => {
            const options = [
              ...root.current.querySelectorAll('[role="option"]'),
            ];
            let index = options.indexOf(document.activeElement);
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              index =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? options.length - 1
                    : (index +
                        (e.key === "ArrowDown" ? 1 : -1) +
                        options.length) %
                      options.length;
              options[index]?.focus();
            }
          }}
        >
          {pages.map((p) => (
            <button
              key={p.id}
              role="option"
              tabIndex={-1}
              aria-selected={p.id === page?.id}
              onClick={() => {
                onChoose(p.id);
                close();
              }}
            >
              <span className="checklist-board-swatch">
                <FileText size={15} />
              </span>
              <span className="checklist-board-label">
                <strong>{p.title}</strong>
                <small>
                  未完成 {p.tasks.filter((t) => !t.block.done).length} · 已完成{" "}
                  {p.tasks.filter((t) => t.block.done).length}
                </small>
              </span>
              {p.id === page?.id && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function HoverText({ children, label }) {
  const host = useRef(null),
    text = useRef(null),
    motion = useRef(null),
    observer = useRef(null);
  const stop = () => {
    motion.current?.cancel();
    motion.current = null;
    host.current?.classList.remove("is-scrolling", "show-full-text");
  };
  const start = () => {
    stop();
    const distance = text.current.scrollWidth - host.current.clientWidth;
    if (distance <= 2) return;
    if (
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
      !text.current.animate
    ) {
      host.current.classList.add("show-full-text");
      return;
    }
    host.current.classList.add("is-scrolling");
    const travel = (distance / 36) * 1000,
      duration = 250 + travel + 900;
    motion.current = text.current.animate(
      [
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: 250 / duration },
        {
          transform: `translateX(-${distance}px)`,
          offset: (250 + travel) / duration,
        },
        { transform: `translateX(-${distance}px)`, offset: 1 },
      ],
      { duration, iterations: Infinity },
    );
  };
  useEffect(() => {
    observer.current = new ResizeObserver(stop);
    observer.current.observe(host.current);
    return () => {
      observer.current.disconnect();
      stop();
    };
  }, [label]);
  return (
    <span
      className="checklist-hover-text"
      ref={host}
      tabIndex={0}
      aria-label={label}
      onMouseEnter={start}
      onMouseLeave={stop}
      onFocus={start}
      onBlur={stop}
    >
      <span className="block-copy" ref={text}>
        {children}
      </span>
    </span>
  );
}
